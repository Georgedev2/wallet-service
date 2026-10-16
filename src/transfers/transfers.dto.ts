import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateTransferDto {
  @IsUUID('all')
  sourceWalletId!: string;

  @IsUUID('all')
  destinationWalletId!: string;

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
