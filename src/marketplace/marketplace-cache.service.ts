import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';

// Async cache facade for marketplace.service.ts. Backed by the global
// CacheModule that app.module.ts wires to Redis in prod and to an
// in-process LRU in dev. Same shape as the bespoke MemCache it
// replaces (get / set / invalidate / clear) so the call sites only
// gain `await` — no logic changes.
//
// cache-manager v7 has no native "delete by prefix" operation through
// the Cache abstraction (the underlying Redis store could SCAN for it
// but the wrapper doesn't expose that). We keep a local Set of every
// key we've written so invalidate(prefix) can fan out a finite list of
// `cache.del()` calls. Memory cost is bounded by working set size; in
// practice marketplace caches a few hundred keys at a time.
//
// The known-keys index is per-process. With multiple Node instances
// behind a load balancer each one tracks its own writes — a write on
// instance A is invalidated on its keyset only, but Redis still drops
// the entry, so reads on instance B return null and refresh from
// Postgres. The Set just caps which keys *this* instance bothers
// trying to delete.
@Injectable()
export class MarketplaceCache {
  private readonly logger = new Logger(MarketplaceCache.name);
  private readonly knownKeys = new Set<string>();

  constructor(@Inject(CACHE_MANAGER) private readonly store: Cache) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const v = await this.store.get<T>(key);
      return v ?? null;
    } catch (err) {
      this.logger.warn(`cache get(${key}) failed: ${err}`);
      return null;
    }
  }

  async set(key: string, data: unknown, ttlMs: number): Promise<void> {
    try {
      await this.store.set(key, data, ttlMs);
      this.knownKeys.add(key);
    } catch (err) {
      this.logger.warn(`cache set(${key}) failed: ${err}`);
    }
  }

  async invalidate(prefix: string): Promise<void> {
    const matches: string[] = [];
    for (const key of this.knownKeys) {
      if (key.startsWith(prefix)) matches.push(key);
    }
    if (matches.length === 0) return;
    try {
      await Promise.all(matches.map((k) => this.store.del(k)));
    } catch (err) {
      this.logger.warn(`cache invalidate(${prefix}) failed: ${err}`);
    }
    for (const k of matches) this.knownKeys.delete(k);
  }

  async clear(): Promise<void> {
    try {
      await this.store.clear();
    } catch (err) {
      this.logger.warn(`cache clear failed: ${err}`);
    }
    this.knownKeys.clear();
  }
}
