import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BlacklistModule } from './blacklist/blacklist.module';
import { Env, envSchema, envValidationOptions } from './config/configuration';
import { buildLoggerParams } from './config/logger.config';
import { DatabaseModule } from './database/database.module';
import { TransfersModule } from './transfers/transfers.module';
import { UsersModule } from './users/users.module';
import { WalletsModule } from './wallets/wallets.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envSchema,
      validationOptions: envValidationOptions,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => buildLoggerParams(config.get('NODE_ENV')),
    }),
    DatabaseModule,
    // Global, but only routes with ThrottlerGuard are limited; each sets its own @Throttle.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
    AuthModule,
    BlacklistModule,
    UsersModule,
    WalletsModule,
    TransfersModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
