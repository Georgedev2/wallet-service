import { Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DatabaseError, Pool } from 'pg';
import { BlacklistService } from '../blacklist/blacklist.service';
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from '../common/errors/domain.error';
import { normalizeBvn, normalizeEmail, normalizePhone } from '../common/utils/normalize';
import { PG_POOL } from '../database/database.constants';
import { withTransaction } from '../database/with-transaction';
import { WalletSummary, WalletsRepository } from '../wallets/wallets.repository';
import { SignupDto } from './users.dto';
import { PublicUser, StatusEvent, UsersRepository } from './users.repository';

const UNIQUE_VIOLATION = '23505';
const USER_UNIQUE_CONSTRAINTS = new Set(['users_email_uq', 'users_phone_uq', 'users_bvn_uq']);

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly users: UsersRepository,
    private readonly wallets: WalletsRepository,
    private readonly blacklist: BlacklistService,
  ) {}

  async signup(dto: SignupDto): Promise<{ user: PublicUser; wallet: WalletSummary }> {
    const email = normalizeEmail(dto.email);
    const phone = normalizePhone(dto.phone);
    const bvn = dto.bvn === undefined ? null : normalizeBvn(dto.bvn);

    if (await this.blacklist.isBlacklisted({ email, phone, bvn: bvn ?? undefined })) {
      // Don't reveal which identifier matched; that would help someone probe the list.
      this.logger.warn('Signup rejected: blacklisted identity');
      throw new ForbiddenError('USER_BLACKLISTED', 'Unable to create account');
    }

    const passwordHash = await argon2.hash(dto.password);

    try {
      // No pre-check for duplicates: the unique indexes are the source of truth,
      // so two concurrent signups with the same email can't both succeed.
      return await withTransaction(this.pool, async (client) => {
        const user = await this.users.insert(client, {
          email,
          phone,
          fullName: dto.fullName,
          passwordHash,
          bvn,
        });
        const wallet = await this.wallets.insert(client, user.id);
        return { user, wallet };
      });
    } catch (err) {
      if (
        err instanceof DatabaseError &&
        err.code === UNIQUE_VIOLATION &&
        USER_UNIQUE_CONSTRAINTS.has(err.constraint ?? '')
      ) {
        throw new ConflictError(
          'USER_EXISTS',
          'An account with this email, phone number or BVN already exists',
        );
      }
      throw err;
    }
  }

  async getMe(userId: string): Promise<{ user: PublicUser; wallets: WalletSummary[] }> {
    const user = await this.users.findById(userId);
    if (!user) {
      // A valid token for a user that no longer exists.
      throw userNotFound();
    }
    return { user, wallets: await this.wallets.findByUserId(userId) };
  }

  async block(adminId: string, userId: string, reason: string): Promise<PublicUser> {
    if (adminId === userId) {
      throw new BusinessRuleError('CANNOT_BLOCK_SELF', 'Admins cannot block themselves');
    }
    const user = await withTransaction(this.pool, async (client) => {
      // Lock, then check: two admins blocking at once get one success and one 409.
      const current = await this.users.lockStatus(client, userId);
      if (!current) {
        throw userNotFound();
      }
      if (current.status === 'blocked') {
        throw new ConflictError('ALREADY_BLOCKED', 'User is already blocked');
      }
      const updated = await this.users.block(client, userId, reason);
      await this.users.insertStatusEvent(client, {
        userId,
        action: 'blocked',
        reason,
        performedBy: adminId,
      });
      return updated;
    });
    this.logger.log(`User ${userId} blocked by admin ${adminId}`);
    return user;
  }

  async unblock(adminId: string, userId: string, reason: string): Promise<PublicUser> {
    const user = await withTransaction(this.pool, async (client) => {
      const current = await this.users.lockStatus(client, userId);
      if (!current) {
        throw userNotFound();
      }
      if (current.status !== 'blocked') {
        throw new ConflictError('NOT_BLOCKED', 'User is not blocked');
      }
      const updated = await this.users.unblock(client, userId);
      await this.users.insertStatusEvent(client, {
        userId,
        action: 'unblocked',
        reason,
        performedBy: adminId,
      });
      return updated;
    });
    this.logger.log(`User ${userId} unblocked by admin ${adminId}`);
    return user;
  }

  async getStatusHistory(userId: string): Promise<StatusEvent[]> {
    if (!(await this.users.findById(userId))) {
      throw userNotFound();
    }
    return this.users.findStatusEvents(userId);
  }
}

const userNotFound = () => new NotFoundError('USER_NOT_FOUND', 'User not found');
