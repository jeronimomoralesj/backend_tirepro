// =============================================================================
// IndexNowService — push URL updates to search engines instantly.
//
// IndexNow (https://www.indexnow.org/) is a free protocol shared by Bing,
// Yandex, Naver and Seznam: instead of waiting for crawlers to find new
// content (often days), we POST a list of changed URLs to a single
// endpoint and they index within minutes. Google doesn't yet adopt
// IndexNow but uses Sitemaps + Search Console; Bing benefits the most.
//
// Verification: the search engine fetches our `<key>.txt` file at the
// site root to confirm we own the domain. The file lives in
// `frontend_tirepro/public/<key>.txt` and Vercel serves it as a static
// asset at `https://www.tirepro.com.co/<key>.txt`.
//
// Quotas: 10,000 URLs/day per protocol, batches of up to 10,000 per
// request. We're nowhere near those limits — use freely.
// =============================================================================

import { Injectable, Logger } from '@nestjs/common';

const SITE        = 'https://www.tirepro.com.co';
const HOST        = 'www.tirepro.com.co';
const ENDPOINT    = 'https://api.indexnow.org/indexnow';
// Fallback to the key shipped in the public/ folder. Override with
// INDEXNOW_KEY in EC2 env if you ever rotate.
const DEFAULT_KEY = 'bb56b8b7bd4fb163735ace5670e74c11';

@Injectable()
export class IndexNowService {
  private readonly logger = new Logger(IndexNowService.name);
  private readonly key = (process.env.INDEXNOW_KEY ?? DEFAULT_KEY).trim();

  /**
   * Push one or more URLs to IndexNow. Best-effort — never blocks
   * the caller's flow on success/failure of the search-engine ping.
   * Caller passes either absolute (https://...) or path-only (/foo)
   * URLs; we normalise to absolute.
   */
  async ping(urls: string[]): Promise<void> {
    if (!this.key) return;
    const cleaned = Array.from(new Set(
      urls
        .map((u) => u?.trim())
        .filter((u): u is string => !!u && u.length > 1)
        .map((u) => (u.startsWith('http') ? u : `${SITE}${u.startsWith('/') ? '' : '/'}${u}`)),
    ));
    if (cleaned.length === 0) return;

    // IndexNow accepts up to 10K URLs per call, but the docs recommend
    // chunks ≤ 1K for reliability. Chunk just in case the caller dumps
    // a very large sitemap.
    const CHUNK = 1000;
    for (let i = 0; i < cleaned.length; i += CHUNK) {
      const urlList = cleaned.slice(i, i + CHUNK);
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'User-Agent':   'TirePro-Marketplace/1.0',
          },
          body: JSON.stringify({
            host:        HOST,
            key:         this.key,
            keyLocation: `${SITE}/${this.key}.txt`,
            urlList,
          }),
          // Bind to a 10s deadline — we don't want a stalled IndexNow
          // ping to block listing creation on the user's request path.
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 200 || res.status === 202) {
          this.logger.log(`IndexNow accepted ${urlList.length} URL${urlList.length === 1 ? '' : 's'}`);
        } else if (res.status === 422) {
          this.logger.warn('IndexNow 422 — key file not reachable. Check that public/<key>.txt is deployed and matches INDEXNOW_KEY env.');
        } else {
          this.logger.warn(`IndexNow returned ${res.status} for ${urlList.length} URLs`);
        }
      } catch (err) {
        this.logger.warn(`IndexNow ping failed: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  /** Fire-and-forget convenience wrapper — never awaited by callers. */
  pingAsync(urls: string[]): void {
    void this.ping(urls).catch(() => {});
  }
}
