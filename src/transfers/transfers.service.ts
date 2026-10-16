import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseError, Pool, PoolClient } from 'pg';
import {
  BusinessRuleError,
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
} from '../common/errors/domain.error';
import { parseAmount } from '../common/utils/money';
import { generateReference } from '../common/utils/reference';
import { requestHash } from '../common/utils/request-hash';
import { PG_POOL } from '../database/database.constants';
import {
  IDEMPOTENCY_CONSTRAINT,
  PG_DEADLOCK_DETECTED,
  PG_LOCK_NOT_AVAILABLE,
  PG_NUMERIC_OUT_OF_RANGE,
  PG_UNIQUE_VIOLATION,
} from '../database/pg-errors';
import { withTransaction } from '../database/with-transaction';

export interface TransferRequest {
  sourceWalletId: string;
  destinationWalletId: string;
  amount: string;
  narration: string | null;
}

export interface TransferResult {
  reference: string;
  amount: string;
  currency: string;
  sourceWalletId: string;
  destinationWalletId: string;
  narration: string | null;
  status: string;
  /** The sender's balance right after this transfer. */
  balanceAfter: string;
  createdAt: Date;
}

interface LockedWallet {
  id: string;
  userId: string;
  currency: string;
  balance: string;
  status: 'active' | 'frozen';
  ownerStatus: 'active' | 'blocked';
}

const keyReused = () =>
  new ConflictError(
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used with a different request',
  );

@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Moves money between two wallets. CLAUDE.md rule 2, in order:
   * lock both wallets (ordered by id) → idempotency check → validate → insert transaction →
   * debit, credit → two ledger entries → COMMIT. All on one client, in one transaction.
   */
  async transfer(
    initiatorId: string,
    idempotencyKey: string,
    req: TransferRequest,
  ): Promise<{ result: TransferResult; replayed: boolean }> {
    const amount = parseAmount(req.amount);
    const hash = requestHash([
      req.sourceWalletId,
      req.destinationWalletId,
      amount.toString(),
      req.narration,
    ]);

    try {
      return await withTransaction(this.pool, async (client) => {
        // Fail fast instead of queueing forever behind a stuck lock; mapped to 503.
        await client.query("SET LOCAL lock_timeout = '5s'");

        // a. Lock both wallets in id order, so A→B and B→A can't deadlock.
        //    Locks are taken as rows are returned, after the sort.
        const { rows: locked } = await client.query<LockedWallet>(
          `SELECT w.id, w.user_id AS "userId", w.currency, w.balance::text AS balance,
                  w.status, u.status AS "ownerStatus"
             FROM wallets w
             JOIN users u ON u.id = w.user_id
            WHERE w.id = ANY($1::uuid[])
            ORDER BY w.id
              FOR UPDATE OF w`,
          [[req.sourceWalletId, req.destinationWalletId]],
        );

        // b. Idempotency, after the lock: a concurrent duplicate waits above, then sees our row.
        const { rows: existing } = await client.query<{ id: string; requestHash: string }>(
          `SELECT id, request_hash AS "requestHash"
             FROM transactions
            WHERE initiated_by = $1 AND idempotency_key = $2`,
          [initiatorId, idempotencyKey],
        );
        if (existing[0]) {
          if (existing[0].requestHash !== hash) {
            throw keyReused();
          }
          return { result: await loadTransfer(client, existing[0].id), replayed: true };
        }

        // c. Validate.
        if (req.sourceWalletId === req.destinationWalletId) {
          throw new BusinessRuleError('SAME_WALLET', 'Cannot transfer to the same wallet');
        }
        const source = locked.find((w) => w.id === req.sourceWalletId);
        const destination = locked.find((w) => w.id === req.destinationWalletId);
        if (!source) {
          throw new NotFoundError('WALLET_NOT_FOUND', 'Source wallet not found');
        }
        if (!destination) {
          throw new NotFoundError('WALLET_NOT_FOUND', 'Destination wallet not found');
        }
        if (source.userId !== initiatorId) {
          throw new ForbiddenError('FORBIDDEN', 'You can only send from your own wallet');
        }
        if (source.ownerStatus === 'blocked') {
          throw new ForbiddenError('USER_BLOCKED', 'Your account is blocked');
        }
        if (destination.ownerStatus === 'blocked') {
          throw new ForbiddenError('USER_BLOCKED', 'The recipient cannot receive transfers');
        }
        if (source.status === 'frozen') {
          throw new BusinessRuleError('WALLET_FROZEN', 'The source wallet is frozen');
        }
        if (destination.status === 'frozen') {
          throw new BusinessRuleError('WALLET_FROZEN', 'The destination wallet is frozen');
        }
        if (source.currency !== destination.currency) {
          throw new BusinessRuleError(
            'CURRENCY_MISMATCH',
            'Source and destination wallets have different currencies',
          );
        }
        if (BigInt(source.balance) < amount) {
          throw new BusinessRuleError('INSUFFICIENT_FUNDS', 'Insufficient funds');
        }

        // d. Insert the transaction.
        const { rows: txRows } = await client.query<{ id: string }>(
          `INSERT INTO transactions
             (reference, type, initiated_by, idempotency_key, request_hash,
              source_wallet_id, destination_wallet_id, amount, currency, narration)
           VALUES ($1, 'transfer', $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            generateReference('TRF'),
            initiatorId,
            idempotencyKey,
            hash,
            source.id,
            destination.id,
            amount.toString(),
            source.currency,
            req.narration,
          ],
        );
        const transactionId = txRows[0].id;

        // e. Debit, then credit.
        const debit = await client.query<{ balance: string }>(
          `UPDATE wallets SET balance = balance - $2, updated_at = now()
            WHERE id = $1
            RETURNING balance::text AS balance`,
          [source.id, amount.toString()],
        );
        const credit = await client.query<{ balance: string }>(
          `UPDATE wallets SET balance = balance + $2, updated_at = now()
            WHERE id = $1
            RETURNING balance::text AS balance`,
          [destination.id, amount.toString()],
        );

        // f. Two ledger entries.
        await client.query(
          `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after)
           VALUES ($1, $2, 'debit', $3, $4), ($1, $5, 'credit', $3, $6)`,
          [
            transactionId,
            source.id,
            amount.toString(),
            debit.rows[0].balance,
            destination.id,
            credit.rows[0].balance,
          ],
        );

        const result = await loadTransfer(client, transactionId);
        this.logger.log(`Transfer ${result.reference} by user ${initiatorId}`);
        return { result, replayed: false };
      }); // g. COMMIT (withTransaction)
    } catch (err) {
      if (!(err instanceof DatabaseError)) {
        throw err;
      }
      // Backstop: the same key sent for different wallets at once. They lock different
      // rows, so both pass the check above and the unique index decides.
      if (err.code === PG_UNIQUE_VIOLATION && err.constraint === IDEMPOTENCY_CONSTRAINT) {
        return this.replayAfterRace(initiatorId, idempotencyKey, hash);
      }
      if (err.code === PG_LOCK_NOT_AVAILABLE || err.code === PG_DEADLOCK_DETECTED) {
        this.logger.warn(`Transfer lock contention (${err.code}) for user ${initiatorId}`);
        throw new DomainError('TRY_AGAIN', 'The wallet is busy; please retry', 503);
      }
      if (err.code === PG_NUMERIC_OUT_OF_RANGE) {
        throw new BusinessRuleError(
          'BALANCE_LIMIT_EXCEEDED',
          'The recipient balance would be too large',
        );
      }
      throw err;
    }
  }

  private async replayAfterRace(
    initiatorId: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<{ result: TransferResult; replayed: boolean }> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ id: string; requestHash: string }>(
        `SELECT id, request_hash AS "requestHash"
           FROM transactions
          WHERE initiated_by = $1 AND idempotency_key = $2`,
        [initiatorId, idempotencyKey],
      );
      if (rows[0].requestHash !== hash) {
        throw keyReused();
      }
      return { result: await loadTransfer(client, rows[0].id), replayed: true };
    } finally {
      client.release();
    }
  }
}

/** Builds the response from the stored rows, so a replay returns exactly the original body. */
async function loadTransfer(client: PoolClient, transactionId: string): Promise<TransferResult> {
  const { rows } = await client.query<TransferResult>(
    `SELECT t.reference, t.amount::text AS amount, t.currency,
            t.source_wallet_id AS "sourceWalletId",
            t.destination_wallet_id AS "destinationWalletId",
            t.narration, t.status,
            le.balance_after::text AS "balanceAfter", t.created_at AS "createdAt"
       FROM transactions t
       JOIN ledger_entries le ON le.transaction_id = t.id AND le.direction = 'debit'
      WHERE t.id = $1`,
    [transactionId],
  );
  return rows[0];
}
