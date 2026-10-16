import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { normalizeEmail } from '../common/utils/normalize';

export class LoginDto {
  @ApiProperty({ example: 'alice@example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? normalizeEmail(value) : value))
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Capped so a huge body can't make argon2 do unbounded work.
  @ApiProperty({ example: 'Passw0rd!Test' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  password!: string;
}
