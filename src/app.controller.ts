import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly prisma:     PrismaService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Liveness + readiness probe. Used by UptimeRobot and CloudWatch to
   * detect outages. Returns 200 only when the DB round-trip succeeds —
   * catches the "node is up but Postgres pool is dead" failure mode that
   * was silently killing requests earlier.
   */
  @Get('health')
  async health() {
    const t0 = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        dbMs:   Date.now() - t0,
        ts:     new Date().toISOString(),
      };
    } catch (err: any) {
      // Throw so Nest returns 500 — UptimeRobot treats non-2xx as down.
      throw err;
    }
  }
}
