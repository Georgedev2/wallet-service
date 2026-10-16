import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { normalizeEmail } from '../common/utils/normalize';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SignupDto {
  @ApiProperty({ example: 'alice@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Format is checked and normalised to E.164 by the service (normalizePhone).
  @ApiProperty({ example: '08031234567', description: 'Nigerian local or E.164; stored as E.164' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone!: string;

  @ApiProperty({ example: 'Alice Okafor' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  fullName!: string;

  @ApiProperty({ example: 'Passw0rd!Test', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;

  // Checked against the blacklist and stored. 11 digits, checked by normalizeBvn.
  @ApiPropertyOptional({ example: '22212345678', description: '11 digits; returned masked' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  bvn?: string;
}

export class StatusChangeDto {
  @ApiProperty({ example: 'Suspicious activity' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class UserIdParams {
  @IsUUID('all', { message: 'id must be a UUID' })
  id!: string;
}
