import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from './jwt-auth.guard';

@Injectable()
export class CompanyScopeGuard implements CanActivate {
  private readonly logger = new Logger(CompanyScopeGuard.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Skip for public routes
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    // If no user (unauthenticated), let JwtAuthGuard handle it
    if (!user) return true;

    if (!user.companyId) {
      throw new ForbiddenException('No company associated with user');
    }

    // Extract companyId from query, body, or route params
    const requestedCompanyId =
      request.query?.companyId ||
      request.body?.companyId ||
      request.params?.companyId;

    // If no companyId in request, auto-inject the user's companyId
    if (!requestedCompanyId) {
      Object.defineProperty(request, 'query', {
        value: { ...request.query, companyId: user.companyId },
        writable: true,
        configurable: true,
      });
      return true;
    }

    // Same company — always allowed
    if (requestedCompanyId === user.companyId) {
      return true;
    }

    // Different company — check distributor access
    try {
      const hasAccess = await this.prisma.distributorAccess.findFirst({
        where: {
          distributorId: user.companyId,
          companyId: requestedCompanyId,
        },
        select: { companyId: true },
      });

      if (hasAccess) return true;
    } catch (err) {
      this.logger.warn(`Distributor access check failed: ${err.message}`);
    }

    // Log the attempt
    this.logger.warn(
      `Company scope violation: user ${user.userId} (company ${user.companyId}) tried to access company ${requestedCompanyId}`,
    );

    throw new ForbiddenException('Access denied: company mismatch');
  }
}
