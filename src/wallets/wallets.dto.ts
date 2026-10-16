import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class WalletIdParams {
  @IsUUID('all', { message: 'id must be a UUID' })
  id!: string;
}

export class HistoryQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  // The nextCursor from the previous page: a ledger entry id.
  @IsOptional()
  @Matches(/^[1-9]\d{0,17}$/, { message: 'cursor is invalid' })
  cursor?: string;
}

export class FundWalletDto {
  // Kobo as a string of digits; checked by parseAmount (400 INVALID_AMOUNT).
  @IsString()
  amount!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  narration?: string;
}
