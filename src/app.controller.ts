import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';
import { PrismaService } from './prisma/prisma.service';

// In-memory cache of the most recent successful DB ping. UptimeRobot
// hits /health every minute (1440x/day per region), and the original
// implementation ran SELECT 1 on every probe — that's ~1440 free DB
// roundtrips/day going to RDS for no real benefit, plus it amplifies
// any DB hiccup into a flapping "platform down" alert. We now ping the
// DB at most once every HEALTH_TTL_MS and serve the cached result
// otherwise. The cache holds a successful result OR the most recent
// error so a real outage still surfaces — but we don't add to the load.
const HEALTH_TTL_MS = 30_000; // 30 seconds. Same DB-down detection
                              // latency as before for practical purposes
                              // (UptimeRobot pings every 60s anyway).

interface HealthSnapshot {
  ok: boolean;
  uptime: number;
  dbMs: number;
  ts: string;
  error?: string;
  fetchedAt: number; // monotonic ms — used to decide cache freshness
}

@Controller()
export class AppController {
  private cache: HealthSnapshot | null = null;
  private inflight: Promise<HealthSnapshot> | null = null;

  constructor(
    private readonly appService: AppService,
    private readonly prisma:     PrismaService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Liveness + readiness probe. Used by UptimeRobot and CloudWatch.
   *
   * Caches the DB-ping result for HEALTH_TTL_MS (30s) so back-to-back
   * probes share one roundtrip. Concurrent probes during a cache miss
   * dedupe via the `inflight` promise — only one SELECT 1 hits the DB
   * even if 10 probes arrive at once.
   *
   * Still returns 500 on real DB failures so UptimeRobot triggers an
   * alert; the cache only affects how often we BURDEN the DB, not how
   * fast we DETECT failure.
   */
  @Get('health')
  async health() {
    const now = Date.now();
    const fresh = this.cache && now - this.cache.fetchedAt < HEALTH_TTL_MS;
    if (fresh && this.cache!.ok) {
      // Serve cached success without touching the DB.
      return this.respond(this.cache!);
    }

    // Cache miss OR cached value was a failure — refresh now (deduped).
    this.inflight ??= this.doProbe();
    const snap = await this.inflight;
    this.inflight = null;
    return this.respond(snap);
  }

  private async doProbe(): Promise<HealthSnapshot> {
    const t0 = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const snap: HealthSnapshot = {
        ok: true,
        uptime: Math.round(process.uptime()),
        dbMs:   Date.now() - t0,
        ts:     new Date().toISOString(),
        fetchedAt: Date.now(),
      };
      this.cache = snap;
      return snap;
    } catch (err: any) {
      const snap: HealthSnapshot = {
        ok: false,
        uptime: Math.round(process.uptime()),
        dbMs:   Date.now() - t0,
        ts:     new Date().toISOString(),
        error:  err?.message ?? 'unknown',
        fetchedAt: Date.now(),
      };
      this.cache = snap;
      return snap;
    }
  }

  private respond(snap: HealthSnapshot) {
    if (!snap.ok) {
      // Throw so Nest returns 500 — UptimeRobot treats non-2xx as down.
      throw new Error(snap.error ?? 'health probe failed');
    }
    return {
      status: 'ok',
      uptime: snap.uptime,
      dbMs:   snap.dbMs,
      ts:     snap.ts,
    };
  }
}
