import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.constants';

export interface WalletSummary {
  id: string;
  currency: string;
  balance: string; // kobo, as a string of digits
}

export interface Wallet extends WalletSummary {
  userId: string;
  status: 'active' | 'frozen';
  createdAt: Date;
  updatedAt: Date;
}

export interface HistoryRow {
  ledgerId: string;
  reference: string;
  type: 'funding' | 'transfer';
  direction: 'debit' | 'credit';
  amount: string;
  balanceAfter: string;
  counterpartyWalletId: string | null;
  narration: string | null;
  createdAt: Date;
}

// BIGINT cast to text explicitly so money never passes through a JS number.
const SUMMARY_COLUMNS = `id, currency, balance::text AS balance`;

@Injectable()
export class WalletsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Runs on the caller's transaction client. */
  async insert(client: PoolClient, userId: string, currency = 'NGN'): Promise<WalletSummary> {
    const { rows } = await client.query<WalletSummary>(
      `INSERT INTO wallets (user_id, currency) VALUES ($1, $2) RETURNING ${SUMMARY_COLUMNS}`,
      [userId, currency],
    );
    return rows[0];
  }

  async findByUserId(userId: string): Promise<WalletSummary[]> {
    const { rows } = await this.pool.query<WalletSummary>(
      `SELECT ${SUMMARY_COLUMNS} FROM wallets WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows;
  }

  async findById(id: string): Promise<Wallet | null> {
    const { rows } = await this.pool.query<Wallet>(
      `SELECT ${SUMMARY_COLUMNS}, user_id AS "userId", status,
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM wallets
        WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /**
   * Newest first, keyset-paginated on ledger_entries.id (uses ledger_entries_wallet_idx).
   * Returns up to `limit` rows older than `beforeId`.
   */
  async findHistory(walletId: string, limit: number, beforeId?: string): Promise<HistoryRow[]> {
    const { rows } = await this.pool.query<HistoryRow>(
      `SELECT le.id AS "ledgerId", t.reference, t.type, le.direction,
              le.amount::text AS amount, le.balance_after::text AS "balanceAfter",
              CASE WHEN le.direction = 'debit' THEN t.destination_wallet_id
                   ELSE t.source_wallet_id END AS "counterpartyWalletId",
              t.narration, le.created_at AS "createdAt"
         FROM ledger_entries le
         JOIN transactions t ON t.id = le.transaction_id
        WHERE le.wallet_id = $1
          AND ($2::bigint IS NULL OR le.id < $2::bigint)
        ORDER BY le.id DESC
        LIMIT $3`,
      [walletId, beforeId ?? null, limit],
    );
    return rows;
  }
}
