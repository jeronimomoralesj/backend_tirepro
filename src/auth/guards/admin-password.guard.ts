import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';

@Injectable()
export class AdminPasswordGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const headerPwd = req.headers['x-admin-password'] as string | undefined;
    const bodyPwd = (req.body && req.body.__adminPassword) as string | undefined;
    const pwd = headerPwd ?? bodyPwd;
    if (!pwd) throw new UnauthorizedException('Admin password required');
    const ok = await this.authService.isAdminPasswordActive(pwd);
    if (!ok) throw new UnauthorizedException('Admin password invalid or expired');
    return true;
  }
}
