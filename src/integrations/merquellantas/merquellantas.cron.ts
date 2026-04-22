import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MerquellantasService } from './merquellantas.service';

/**
 * Nightly Merquellantas incremental sync.
 *
 * Runs at 03:30 America/Bogota — after the tire-projection job at 03:00
 * and the benchmark job at 08:00, so we aren't fighting them for DB.
 *
 * Guarded by MERQUELLANTAS_CRON_ENABLED so staging/preview envs don't
 * fire real pulls against the Azure API. Set to "true" in prod only.
 */
@Injectable()
export class MerquellantasCron {
  private readonly logger = new Logger(MerquellantasCron.name);
  constructor(private readonly svc: MerquellantasService) {}

  @Cron('30 3 * * *', { name: 'merquellantas-nightly', timeZone: 'America/Bogota' })
  async nightly() {
    if (process.env.MERQUELLANTAS_CRON_ENABLED !== 'true') return;
    try {
      await this.svc.runDailySync({ apply: true, sinceDays: 2 });
    } catch (err) {
      this.logger.error(`Nightly sync failed: ${(err as Error).message}`);
    }
  }
}
