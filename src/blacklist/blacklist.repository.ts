import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { IdentityType } from '../common/utils/normalize';
import { PG_POOL } from '../database/database.constants';

export interface BlacklistEntry {
  id: string; // BIGSERIAL; pg returns it as a string
  identityType: IdentityType;
  identityValue: string;
  reason: string | null;
  source: string;
  createdAt: Date;
}

/** Values must already be normalised. */
export interface IdentityToCheck {
  email: string;
  phone: string;
  bvn?: string;
}

const COLUMNS = `id, identity_type AS "identityType", identity_value AS "identityValue",
                 reason, source, created_at AS "createdAt"`;

@Injectable()
export class BlacklistRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findMatch(identity: IdentityToCheck): Promise<BlacklistEntry | null> {
    const pairs: [IdentityType, string][] = [
      ['email', identity.email],
      ['phone', identity.phone],
    ];
    if (identity.bvn !== undefined) {
      pairs.push(['bvn', identity.bvn]);
    }
    // Only placeholders are interpolated: "($1, $2), ($3, $4), ...".
    const tuples = pairs.map((_, i) => `($${2 * i + 1}, $${2 * i + 2})`).join(', ');

    const { rows } = await this.pool.query<BlacklistEntry>(
      `SELECT ${COLUMNS}
         FROM blacklist_entries
        WHERE (identity_type, identity_value) IN (${tuples})
        ORDER BY id
        LIMIT 1`,
      pairs.flat(),
    );
    return rows[0] ?? null;
  }

  /** Returns null if the identity is already blacklisted. */
  async insert(
    identityType: IdentityType,
    identityValue: string,
    reason: string,
  ): Promise<BlacklistEntry | null> {
    const { rows } = await this.pool.query<BlacklistEntry>(
      `INSERT INTO blacklist_entries (identity_type, identity_value, reason)
       VALUES ($1, $2, $3)
       ON CONFLICT (identity_type, identity_value) DO NOTHING
       RETURNING ${COLUMNS}`,
      [identityType, identityValue, reason],
    );
    return rows[0] ?? null;
  }

  /** Returns false if no entry has this id. */
  async deleteById(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM blacklist_entries WHERE id = $1', [id]);
    return rowCount === 1;
  }
}
