import { Module } from '@nestjs/common';
import { BlacklistModule } from '../blacklist/blacklist.module';
import { WalletsModule } from '../wallets/wallets.module';
import { AdminUsersController } from './admin-users.controller';
import { UsersController } from './users.controller';
import { UsersRepository } from './users.repository';
import { UsersService } from './users.service';

@Module({
  imports: [BlacklistModule, WalletsModule],
  controllers: [UsersController, AdminUsersController],
  providers: [UsersRepository, UsersService],
  exports: [UsersRepository],
})
export class UsersModule {}
