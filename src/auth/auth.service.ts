import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { Role } from '../common/decorators/current-user.decorator';
import { DomainError } from '../common/errors/domain.error';
import { UserStatus, UsersRepository } from '../users/users.repository';
import { JwtPayload } from './jwt-payload';

export interface LoginResult {
  accessToken: string;
  user: { id: string; email: string; fullName: string; role: Role; status: UserStatus };
}

const invalidCredentials = () =>
  new DomainError('INVALID_CREDENTIALS', 'Invalid email or password', 401);

@Injectable()
export class AuthService {
  // Verified against when the email is unknown, so both failures take about
  // as long and response time doesn't reveal which emails are registered.
  private readonly dummyHash = argon2.hash('dummy-password-for-timing');

  constructor(
    private readonly users: UsersRepository,
    private readonly jwt: JwtService,
  ) {}

  /** `email` must already be normalised (LoginDto trims and lowercases it). */
  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.users.findByEmailWithPassword(email);
    if (!user) {
      await argon2.verify(await this.dummyHash, password);
      throw invalidCredentials();
    }
    if (!(await argon2.verify(user.passwordHash, password))) {
      throw invalidCredentials();
    }

    // Blocked users may still log in (they can view their data); transfers check status.
    const payload: JwtPayload = { sub: user.id, role: user.role };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
      },
    };
  }
}
