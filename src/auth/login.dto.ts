import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { normalizeEmail } from '../common/utils/normalize';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Capped so a huge body can't make argon2 do unbounded work.
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}
