import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AdminPasswordGuard } from '../../auth/guards/admin-password.guard';
import { MerquellantasService } from './merquellantas.service';

/**
 * Admin-only controller for triggering Merquellantas syncs on demand.
 * Guarded by AdminPasswordGuard — consistent with the catalog admin
 * surface (marketplace.controller.ts uses the same guard for `admin/*`).
 *
 * Runs are exclusive: the service tracks `running` and refuses a second
 * invocation until the first resolves. For long-running initial
 * migrations, prefer shelling into the box and running
 * `npx ts-node scripts/...` directly so HTTP timeouts don't abort it.
 */
@Controller('admin/integrations/merquellantas')
@UseGuards(AdminPasswordGuard)
export class MerquellantasController {
  constructor(private readonly svc: MerquellantasService) {}

  /** Current run status — used by the admin UI to disable the trigger button. */
  @Get('status')
  status() {
    return {
      running: this.svc.isRunning(),
      tokenConfigured: !!process.env.MERQUELLANTAS_TOKEN,
      cronEnabled: process.env.MERQUELLANTAS_CRON_ENABLED === 'true',
    };
  }

  /**
   * Incremental sync — fetch inspections since `sinceDays` ago, then import.
   * This is what the nightly cron calls.
   */
  @Post('sync')
  async sync(@Body() body: { apply?: boolean; sinceDays?: number } = {}) {
    return this.svc.runDailySync({
      apply: body.apply ?? false,           // dry-run by default via API
      sinceDays: body.sinceDays ?? 2,
    });
  }

  /**
   * Full re-pull. Expensive — use once during onboarding or after a
   * reconciliation incident. Default is dry-run; pass {apply: true} only
   * after eyeballing the staged JSON under /tmp/merquepro.
   */
  @Post('full-migration')
  async fullMigration(@Body() body: { apply?: boolean } = {}) {
    return this.svc.runFullMigration({ apply: body.apply ?? false });
  }
}
