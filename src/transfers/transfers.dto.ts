import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTransferDto {
  @IsUUID('all')
  sourceWalletId!: string;

  @IsUUID('all')
  destinationWalletId!: string;

  // Kobo as a string of digits; checked by parseAmount (400 INVALID_AMOUNT).
  @ApiProperty({ example: '25000', description: 'Kobo as a string of digits ("25000" = ₦250.00)' })
  @IsString()
  amount!: string;

  @ApiPropertyOptional({ example: 'Lunch', maxLength: 140 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(140)
  narration?: string;
}
