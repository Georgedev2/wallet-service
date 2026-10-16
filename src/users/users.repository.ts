import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { Role } from '../common/decorators/current-user.decorator';
import { PG_POOL } from '../database/database.constants';

export type UserStatus = 'active' | 'blocked';

/** Safe to return from the API: never includes the password hash. */
export interface PublicUser {
  id: string;
  email: string;
  phone: string;
  fullName: string;
  /** Masked, e.g. "*******8901"; null if not provided. The full BVN is never returned. */
  bvn: string | null;
  role: Role;
  status: UserStatus;
  /** Set exactly when status is 'blocked'; blocked users can see why. */
  blockedReason: string | null;
  blockedAt: Date | null;
  createdAt: Date;
}

export type StatusAction = 'blocked' | 'unblocked';

export interface StatusEvent {
  id: string; // BIGSERIAL; pg returns it as a string
  action: StatusAction;
  reason: string | null;
  performedBy: string;
  createdAt: Date;
}

export interface UserWithPassword {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  passwordHash: string;
}

export interface NewUser {
  email: string;
  phone: string;
  fullName: string;
  passwordHash: string;
  bvn: string | null;
}

const PUBLIC_COLUMNS = `id, email, phone, full_name AS "fullName",
                        '*******' || right(bvn, 4) AS bvn,
                        role, status, blocked_reason AS "blockedReason",
                        blocked_at AS "blockedAt", created_at AS "createdAt"`;

@Injectable()
export class UsersRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** `email` must already be normalised (trimmed, lowercase); matches the lower(email) index. */
  async findByEmailWithPassword(email: string): Promise<UserWithPassword | null> {
    const { rows } = await this.pool.query<UserWithPassword>(
      `SELECT id, email, full_name AS "fullName", role, status, password_hash AS "passwordHash"
         FROM users
        WHERE lower(email) = $1`,
      [email],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<PublicUser | null> {
    const { rows } = await this.pool.query<PublicUser>(
      `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Runs on the caller's transaction client. Email, phone and BVN must already be normalised. */
  async insert(client: PoolClient, user: NewUser): Promise<PublicUser> {
    const { rows } = await client.query<PublicUser>(
      `INSERT INTO users (email, phone, full_name, password_hash, bvn)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${PUBLIC_COLUMNS}`,
      [user.email, user.phone, user.fullName, user.passwordHash, user.bvn],
    );
    return rows[0];
  }

  /** Locks the user row until the caller's transaction ends. Null if no such user. */
  async lockStatus(client: PoolClient, id: string): Promise<{ status: UserStatus } | null> {
    const { rows } = await client.query<{ status: UserStatus }>(
      'SELECT status FROM users WHERE id = $1 FOR UPDATE',
      [id],
    );
    return rows[0] ?? null;
  }

  async block(client: PoolClient, id: string, reason: string): Promise<PublicUser> {
    const { rows } = await client.query<PublicUser>(
      `UPDATE users
          SET status = 'blocked', blocked_reason = $2, blocked_at = now(), updated_at = now()
        WHERE id = $1
        RETURNING ${PUBLIC_COLUMNS}`,
      [id, reason],
    );
    return rows[0];
  }

  async unblock(client: PoolClient, id: string): Promise<PublicUser> {
    const { rows } = await client.query<PublicUser>(
      `UPDATE users
          SET status = 'active', blocked_reason = NULL, blocked_at = NULL, updated_at = now()
        WHERE id = $1
        RETURNING ${PUBLIC_COLUMNS}`,
      [id],
    );
    return rows[0];
  }

  async insertStatusEvent(
    client: PoolClient,
    event: { userId: string; action: StatusAction; reason: string; performedBy: string },
  ): Promise<void> {
    await client.query(
      `INSERT INTO user_status_events (user_id, action, reason, performed_by)
       VALUES ($1, $2, $3, $4)`,
      [event.userId, event.action, event.reason, event.performedBy],
    );
  }

  /** Newest first. */
  async findStatusEvents(userId: string): Promise<StatusEvent[]> {
    const { rows } = await this.pool.query<StatusEvent>(
      `SELECT id, action, reason, performed_by AS "performedBy", created_at AS "createdAt"
         FROM user_status_events
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC`,
      [userId],
    );
    return rows;
  }
}
