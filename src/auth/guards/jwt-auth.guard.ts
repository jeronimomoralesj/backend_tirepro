import {
  Injectable,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(
    err: any,
    user: TUser,
    info: any,
    _context: ExecutionContext,
  ): TUser {
    if (info instanceof TokenExpiredError) {
      throw new UnauthorizedException('Token has expired. Please log in again.');
    }

    if (info instanceof JsonWebTokenError) {
      throw new UnauthorizedException('Invalid token.');
    }

    if (err || !user) {
      throw new UnauthorizedException('Unauthorized.');
    }

    return user;
  }
}