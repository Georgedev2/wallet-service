import { Module } from '@nestjs/common';
import { BlacklistController } from './blacklist.controller';
import { BlacklistRepository } from './blacklist.repository';
import { BlacklistService } from './blacklist.service';

@Module({
  controllers: [BlacklistController],
  providers: [BlacklistRepository, BlacklistService],
  exports: [BlacklistService],
})
export class BlacklistModule {}
