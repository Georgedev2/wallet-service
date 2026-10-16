import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../common/decorators/current-user.decorator';
import { Env } from '../config/configuration';
import { JwtPayload } from './jwt-payload';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_SECRET'),
      algorithms: ['HS256'],
    });
  }

  /** Whatever this returns becomes request.user. Returning null rejects the token. */
  validate(payload: Partial<JwtPayload>): AuthUser | null {
    if (typeof payload.sub !== 'string' || (payload.role !== 'user' && payload.role !== 'admin')) {
      return null;
    }
    return { id: payload.sub, role: payload.role };
  }
}
