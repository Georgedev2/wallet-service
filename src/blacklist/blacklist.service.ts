import { Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../common/errors/domain.error';
import {
  IdentityType,
  normalizeBvn,
  normalizeEmail,
  normalizeIdentity,
  normalizePhone,
} from '../common/utils/normalize';
import { BlacklistEntry, BlacklistRepository } from './blacklist.repository';

export interface Identity {
  email: string;
  phone: string;
  bvn?: string;
}

@Injectable()
export class BlacklistService {
  private readonly logger = new Logger(BlacklistService.name);

  constructor(private readonly repo: BlacklistRepository) {}

  /** Accepts raw input; normalises it before matching. Throws 400 on an invalid phone or BVN. */
  async isBlacklisted(identity: Identity): Promise<boolean> {
    const match = await this.repo.findMatch({
      email: normalizeEmail(identity.email),
      phone: normalizePhone(identity.phone),
      bvn: identity.bvn === undefined ? undefined : normalizeBvn(identity.bvn),
    });
    return match !== null;
  }

  async add(
    adminId: string,
    identityType: IdentityType,
    rawValue: string,
    reason: string,
  ): Promise<BlacklistEntry> {
    const entry = await this.repo.insert(
      identityType,
      normalizeIdentity(identityType, rawValue),
      reason,
    );
    if (!entry) {
      throw new ConflictError('ALREADY_BLACKLISTED', 'This identity is already blacklisted');
    }
    this.logger.log(`Blacklist entry ${entry.id} (${identityType}) added by admin ${adminId}`);
    return entry;
  }

  async remove(adminId: string, id: string): Promise<void> {
    if (!(await this.repo.deleteById(id))) {
      throw new NotFoundError('BLACKLIST_ENTRY_NOT_FOUND', 'Blacklist entry not found');
    }
    this.logger.log(`Blacklist entry ${id} removed by admin ${adminId}`);
  }
}
