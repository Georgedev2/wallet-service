import { Role } from '../common/decorators/current-user.decorator';

export interface JwtPayload {
  sub: string;
  role: Role;
}
