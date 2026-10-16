import { Inject, Injectable, Logger } from '@nestjs/common';
import { DatabaseError, Pool, PoolClient } from 'pg';
import { AuthUser } from '../common/decorators/current-user.decorator';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../common/errors/domain.error';
import { formatKobo, parseAmount } from '../common/utils/money';
import { generateReference } from '../common/utils/reference';
import { requestHash } from '../common/utils/request-hash';
import { PG_POOL } from '../database/database.constants';
import {
  IDEMPOTENCY_CONSTRAINT,
  PG_NUMERIC_OUT_OF_RANGE,
  PG_UNIQUE_VIOLATION,
} from '../database/pg-errors';
import { withTransaction } from '../database/with-transaction';
import { HistoryRow, Wallet, WalletsRepository } from './wallets.repository';

export interface WalletView {
  id: string;
  userId: string;
  currency: string;
  balance: string;
  balanceFormatted: string;
  status: 'active' | 'frozen';
  createdAt: Date;
  updatedAt: Date;
}

export interface HistoryPage {
  items: Omit<HistoryRow, 'ledgerId'>[];
  nextCursor: string | null;
}

export interface FundingResult {
  reference: string;
  type: 'funding';
  walletId: string;
  amount: string;
  currency: string;
  narration: string | null;
  status: string;
  balanceAfter: string;
  createdAt: Date;
}

const walletNotFound = () => new NotFoundError('WALLET_NOT_FOUND', 'Wallet not found');
const keyReused = () =>
  new ConflictError(
    'IDEMPOTENCY_KEY_REUSED',
    'This Idempotency-Key was already used with a different request',
  );

@Injectable()
export class WalletsService {
  private readonly logger = new Logger(WalletsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly wallets: WalletsRepository,
  ) {}

  async getWallet(viewer: AuthUser, walletId: string): Promise<WalletView> {
    const wallet = await this.visibleWallet(viewer, walletId);
    return { ...wallet, balanceFormatted: formatKobo(BigInt(wallet.balance)) };
  }

  async getHistory(
    viewer: AuthUser,
    walletId: string,
    limit: number,
    cursor?: string,
  ): Promise<HistoryPage> {
    await this.visibleWallet(viewer, walletId);
    // One extra row tells us whether another page exists.
    const rows = await this.wallets.findHistory(walletId, limit + 1, cursor);
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ ledgerId: _ledgerId, ...item }) => item),
      nextCursor: rows.length > limit ? page[page.length - 1].ledgerId : null,
    };
  }

  /**
   * Admin funding. SQL is inline (see CLAUDE.md) so the locking sequence is visible:
   * lock wallet → idempotency check → validate → insert transaction → update balance →
   * credit ledger entry.
   */
  async fund(
    adminId: string,
    walletId: string,
    idempotencyKey: string,
    rawAmount: string,
    narration: string | null,
  ): Promise<{ result: FundingResult; replayed: boolean }> {
    const amount = parseAmount(rawAmount);
    const hash = requestHash([walletId, amount.toString(), narration]);

    try {
      return await withTransaction(this.pool, async (client) => {
        // a. Lock the wallet. Concurrent fundings of this wallet queue here.
        const { rows: walletRows } = await client.query<{
          currency: string;
          walletStatus: string;
          ownerStatus: string;
        }>(
          `SELECT w.currency, w.status AS "walletStatus", u.status AS "ownerStatus"
             FROM wallets w
             JOIN users u ON u.id = w.user_id
            WHERE w.id = $1
              FOR UPDATE OF w`,
          [walletId],
        );
        const wallet = walletRows[0];
        if (!wallet) {
          throw walletNotFound();
        }

        // b. Idempotency, checked after the lock so a concurrent duplicate sees our commit.
        const { rows: existing } = await client.query<{ id: string; requestHash: string }>(
          `SELECT id, request_hash AS "requestHash"
             FROM transactions
            WHERE initiated_by = $1 AND idempotency_key = $2`,
          [adminId, idempotencyKey],
        );
        if (existing[0]) {
          if (existing[0].requestHash !== hash) {
            throw keyReused();
          }
          return { result: await loadFunding(client, existing[0].id), replayed: true };
        }

        // c. Validate.
        if (wallet.ownerStatus === 'blocked') {
          throw new ForbiddenError('USER_BLOCKED', 'The wallet owner is blocked');
        }
        if (wallet.walletStatus === 'frozen') {
          throw new BusinessRuleError('WALLET_FROZEN', 'The wallet is frozen');
        }

        // d. Insert the transaction.
        const { rows: txRows } = await client.query<{ id: string }>(
          `INSERT INTO transactions
             (reference, type, initiated_by, idempotency_key, request_hash,
              source_wallet_id, destination_wallet_id, amount, currency, narration)
           VALUES ($1, 'funding', $2, $3, $4, NULL, $5, $6, $7, $8)
           RETURNING id`,
          [
            generateReference('FND'),
            adminId,
            idempotencyKey,
            hash,
            walletId,
            amount.toString(),
            wallet.currency,
            narration,
          ],
        );
        const transactionId = txRows[0].id;

        // e. Update the balance.
        const { rows: balanceRows } = await client.query<{ balance: string }>(
          `UPDATE wallets SET balance = balance + $2, updated_at = now()
            WHERE id = $1
            RETURNING balance::text AS balance`,
          [walletId, amount.toString()],
        );

        // f. One credit ledger entry.
        await client.query(
          `INSERT INTO ledger_entries (transaction_id, wallet_id, direction, amount, balance_after)
           VALUES ($1, $2, 'credit', $3, $4)`,
          [transactionId, walletId, amount.toString(), balanceRows[0].balance],
        );

        const result = await loadFunding(client, transactionId);
        this.logger.log(`Wallet ${walletId} funded (${result.reference}) by admin ${adminId}`);
        return { result, replayed: false };
      });
    } catch (err) {
      if (!(err instanceof DatabaseError)) {
        throw err;
      }
      // Backstop: the same key sent for two different wallets at once. They lock
      // different rows, so both pass the check above and the unique index decides.
      if (err.code === PG_UNIQUE_VIOLATION && err.constraint === IDEMPOTENCY_CONSTRAINT) {
        return this.replayAfterRace(adminId, idempotencyKey, hash);
      }
      if (err.code === PG_NUMERIC_OUT_OF_RANGE) {
        throw new BusinessRuleError(
          'BALANCE_LIMIT_EXCEEDED',
          'The wallet balance would be too large',
        );
      }
      throw err;
    }
  }

  private async replayAfterRace(
    adminId: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<{ result: FundingResult; replayed: boolean }> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ id: string; requestHash: string }>(
        `SELECT id, request_hash AS "requestHash"
           FROM transactions
          WHERE initiated_by = $1 AND idempotency_key = $2`,
        [adminId, idempotencyKey],
      );
      if (rows[0].requestHash !== hash) {
        throw keyReused();
      }
      return { result: await loadFunding(client, rows[0].id), replayed: true };
    } finally {
      client.release();
    }
  }

  /** Owners and admins see the wallet; everyone else gets 404, so existence isn't revealed. */
  private async visibleWallet(viewer: AuthUser, walletId: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId);
    if (!wallet || (wallet.userId !== viewer.id && viewer.role !== 'admin')) {
      throw walletNotFound();
    }
    return wallet;
  }
}

/** Builds the response from the stored rows, so a replay returns exactly the original body. */
async function loadFunding(client: PoolClient, transactionId: string): Promise<FundingResult> {
  const { rows } = await client.query<FundingResult>(
    `SELECT t.reference, t.type, t.destination_wallet_id AS "walletId",
            t.amount::text AS amount, t.currency, t.narration, t.status,
            le.balance_after::text AS "balanceAfter", t.created_at AS "createdAt"
       FROM transactions t
       JOIN ledger_entries le ON le.transaction_id = t.id AND le.direction = 'credit'
      WHERE t.id = $1`,
    [transactionId],
  );
  return rows[0];
}
