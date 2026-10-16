import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { Env } from '../config/configuration';
import { PG_POOL, buildPoolConfig } from './database.constants';

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Pool => {
        const pool = new Pool(
          buildPoolConfig(config.get('DATABASE_URL'), config.get('DATABASE_SSL')),
        );
        // Without a listener, an error on an idle client crashes the process.
        pool.on('error', (err) => new Logger('PgPool').error(err.message, err.stack));
        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // Not onModuleDestroy: that runs before Nest closes the HTTP server, so requests
  // still in flight would find the pool gone. This hook runs after the server has
  // stopped accepting connections and finished the open requests.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
