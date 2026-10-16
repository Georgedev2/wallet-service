import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DomainError } from '../common/errors/domain.error';
import { PG_POOL } from '../database/database.constants';

export interface HealthStatus {
  status: 'ok';
  db: 'ok';
}

/** Render's health check times out after a few seconds; answer well before that. */
const DB_CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async check(): Promise<HealthStatus> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), DB_CHECK_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.pool.query('SELECT 1'), timeout]);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      this.logger.warn(`Database health check failed: ${(err as Error).message}`);
      throw new DomainError('DB_UNAVAILABLE', 'The database is unreachable', 503);
    } finally {
      clearTimeout(timer);
    }
  }
}
