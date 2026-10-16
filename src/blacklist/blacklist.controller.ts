import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AddBlacklistEntryDto, BlacklistEntryIdParams } from './blacklist.dto';
import { BlacklistEntry } from './blacklist.repository';
import { BlacklistService } from './blacklist.service';

@Controller('admin/blacklist')
@UseGuards(JwtAuthGuard, AdminGuard)
export class BlacklistController {
  constructor(private readonly blacklist: BlacklistService) {}

  @Post()
  add(@CurrentUser() admin: AuthUser, @Body() dto: AddBlacklistEntryDto): Promise<BlacklistEntry> {
    return this.blacklist.add(admin.id, dto.identityType, dto.identityValue, dto.reason);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() admin: AuthUser, @Param() params: BlacklistEntryIdParams): Promise<void> {
    return this.blacklist.remove(admin.id, params.id);
  }
}
