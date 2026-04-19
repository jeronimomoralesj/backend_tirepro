import { Controller, Post, Get, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TireBenchmarkService } from './tire-benchmark.service';

// =============================================================================
// Admin endpoints to trigger the TireBenchmark + catalog crowdsource ETL
// on demand. The cron schedule handles nightly runs; these let an operator
// refresh immediately after a bulk import or schema change.
// =============================================================================

@Controller('tire-benchmarks')
@UseGuards(JwtAuthGuard)
@SkipThrottle() // ETL rebuild hits all SKUs; don't rate-limit the admin
export class TireBenchmarkController {
  constructor(private readonly service: TireBenchmarkService) {}

  /** Rebuild TireBenchmark table from current inspection data. */
  @Post('rebuild')
  rebuild() {
    return this.service.rebuildAll();
  }

  /** Rebuild TireMasterCatalog.crowd* fields for every distinct SKU. */
  @Post('rebuild-crowdsource')
  rebuildCrowd() {
    return this.service.rebuildCatalogCrowdsource();
  }

  /** Run both rebuilds in sequence. Use this for a full refresh. */
  @Post('rebuild-all')
  async rebuildAllPipelines() {
    const bench = await this.service.rebuildAll();
    const crowd = await this.service.rebuildCatalogCrowdsource();
    return { bench, crowd };
  }

  /** Lightweight status probe — returns the current row count. */
  @Get('status')
  async status() {
    const [benchCount, catalogCount] = await Promise.all([
      this.service['prisma'].tireBenchmark.count(),
      this.service['prisma'].tireMasterCatalog.count({ where: { fuente: 'crowdsource' } }),
    ]);
    return {
      tireBenchmarks: benchCount,
      crowdsourcedCatalogEntries: catalogCount,
    };
  }
}
