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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AddBlacklistEntryDto, BlacklistEntryIdParams } from './blacklist.dto';
import { BlacklistEntry } from './blacklist.repository';
import { BlacklistService } from './blacklist.service';

@ApiTags('admin: blacklist')
@ApiBearerAuth()
@Controller('admin/blacklist')
@UseGuards(JwtAuthGuard, AdminGuard)
export class BlacklistController {
  constructor(private readonly blacklist: BlacklistService) {}

  @Post()
  @ApiOperation({
    summary: 'Add a blacklist entry (value is normalised)',
    description:
      'Errors: 409 ALREADY_BLACKLISTED, 400 INVALID_EMAIL | INVALID_PHONE | INVALID_BVN | INVALID_NIN.',
  })
  add(@CurrentUser() admin: AuthUser, @Body() dto: AddBlacklistEntryDto): Promise<BlacklistEntry> {
    return this.blacklist.add(admin.id, dto.identityType, dto.identityValue, dto.reason);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Remove a blacklist entry',
    description: 'Errors: 404 BLACKLIST_ENTRY_NOT_FOUND.',
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() admin: AuthUser, @Param() params: BlacklistEntryIdParams): Promise<void> {
    return this.blacklist.remove(admin.id, params.id);
  }
}
