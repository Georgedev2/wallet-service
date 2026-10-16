import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { Role } from '../common/decorators/current-user.decorator';
import { PG_POOL } from '../database/database.constants';

export type UserStatus = 'active' | 'blocked';

export interface UserWithPassword {
  id: string;
  email: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  passwordHash: string;
}

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
}
