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
import { normalizeEmail } from '../common/utils/normalize';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class SignupDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Format is checked and normalised to E.164 by the service (normalizePhone).
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phone!: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  fullName!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(256)
  password!: string;

  // Checked against the blacklist and stored. 11 digits, checked by normalizeBvn.
  @IsOptional()
  @IsString()
  @MaxLength(32)
  bvn?: string;
}

export class StatusChangeDto {
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
