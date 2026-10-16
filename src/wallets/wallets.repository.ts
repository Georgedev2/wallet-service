import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../database/database.constants';

export interface WalletSummary {
  id: string;
  currency: string;
  balance: string; // kobo, as a string of digits
}

// BIGINT cast to text explicitly so money never passes through a JS number.
const COLUMNS = `id, currency, balance::text AS balance`;

@Injectable()
export class WalletsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Runs on the caller's transaction client. */
  async insert(client: PoolClient, userId: string, currency = 'NGN'): Promise<WalletSummary> {
    const { rows } = await client.query<WalletSummary>(
      `INSERT INTO wallets (user_id, currency) VALUES ($1, $2) RETURNING ${COLUMNS}`,
      [userId, currency],
    );
    return rows[0];
  }

  async findByUserId(userId: string): Promise<WalletSummary[]> {
    const { rows } = await this.pool.query<WalletSummary>(
      `SELECT ${COLUMNS} FROM wallets WHERE user_id = $1 ORDER BY created_at, id`,
      [userId],
    );
    return rows;
  }
}
