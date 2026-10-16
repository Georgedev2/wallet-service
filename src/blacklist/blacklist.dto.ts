import { IsIn, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IDENTITY_TYPES, IdentityType } from '../common/utils/normalize';

export class AddBlacklistEntryDto {
  @ApiProperty({ enum: IDENTITY_TYPES, example: 'email' })
  @IsIn(IDENTITY_TYPES)
  identityType!: IdentityType;

  // Normalised and format-checked per type by the service.
  @ApiProperty({ example: 'fraud@example.com' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(254)
  identityValue!: string;

  @ApiProperty({ example: 'Known fraud' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class BlacklistEntryIdParams {
  // A BIGSERIAL id. 18 digits max so it always fits in BIGINT.
  @Matches(/^[1-9]\d{0,17}$/, { message: 'id must be a positive integer' })
  id!: string;
}
