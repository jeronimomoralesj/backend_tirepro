/**
 * Pulls live Merquellantas data off their Azure reporting APIs and writes it
 * to disk in the shape `import-merquepro.ts` already knows how to import.
 *
 * Why split fetch vs import:
 *   • The existing importer is battle-tested (externalSourceId dedup,
 *     DistributorAccess, TireVidaSnapshot, orphan handling, cost fallbacks,
 *     analytics cache refresh). Reusing it means we don't re-derive vida
 *     logic for every new distributor.
 *   • Fetch is I/O-bound and can run on a cron independently of the write
 *     pass — letting you eyeball the staged JSON before touching the DB.
 *   • For the next distributor (Goodyear, etc.), you copy THIS file, swap
 *     URLs + endpoint names, and feed the same importer.
 *
 * Pipeline:
 *   1. fetch-merquellantas-api.ts      → /tmp/merquepro/*.json
 *   2. import-merquepro.ts --apply     → Postgres
 *
 * Usage:
 *   MERQUELLANTAS_TOKEN=<bearer> npx ts-node scripts/fetch-merquellantas-api.ts
 *     [--out=/tmp/merquepro]        target directory (default: /tmp/merquepro)
 *     [--endpoint=<name>]           fetch only one (vehicles|inactive|tires|inspections)
 *     [--since=YYYY-MM-DD]          incremental: skip inspection pages older than this
 *     [--max-pages=N]               safety cap per endpoint (default: 500)
 *     [--page-size=N]               override page size if API allows it
 *     [--run-import]                after fetch, exec import-merquepro.ts --apply
 *     [--verbose]                   log per-page timing + sample row
 *
 * Re-running is safe: each full-dataset endpoint overwrites its file; the
 * paginated endpoints (tires_p*, inspections_p*) truncate prior files for
 * the same prefix so stale pages can't leak into the next import.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { URL as NodeURL } from 'node:url';
import { spawnSync } from 'node:child_process';

// =============================================================================
// Config
// =============================================================================

const ARGS = process.argv.slice(2);
const getFlag = (name: string): string | undefined => {
  const hit = ARGS.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '' : hit.slice(eq + 1);
};
const hasFlag = (name: string) => ARGS.includes(`--${name}`);

const OUT_DIR       = getFlag('out')       ?? '/tmp/merquepro';
const ONLY_ENDPOINT = getFlag('endpoint');                             // optional
const SINCE_ISO     = getFlag('since');                                // optional
const MAX_PAGES     = Number(getFlag('max-pages') ?? '500');
const PAGE_SIZE     = getFlag('page-size');                            // string or undef
const RUN_IMPORT    = hasFlag('run-import');
const VERBOSE       = hasFlag('verbose');

const TOKEN = process.env.MERQUELLANTAS_TOKEN?.trim();
if (!TOKEN) {
  console.error('MERQUELLANTAS_TOKEN env var is required. Set it in .env or your shell.');
  process.exit(2);
}

// Merquellantas exposes two subdomains for their reporting stack. The shared
// service hosts vehicle-registry endpoints; the reports service hosts
// inspection + tire-state reports.
const SHARED_BASE   = 'https://shared-mqplatform-prod.azurewebsites.net';
const REPORTS_BASE  = 'https://reports-mqplatform-prod.azurewebsites.net';

// Endpoint table. Each entry maps one Azure endpoint to one on-disk
// destination. `paginated: true` fans out to <prefix>_pN.json; otherwise a
// single <prefix>.json file.
//
// The importer expects these filenames verbatim:
//   - vehicles.json                     → /report/vehicles (full list)
//   - vehiclesWithoutTransaction.json   → /report/vehiclesWithoutTransaction
//   - tires_pN.json                     → /report/currentstatetirest (paginated)
//   - inspections_pN.json               → /report/inspection (paginated)
type EndpointSpec = {
  name:       'vehicles' | 'inactive' | 'tires' | 'inspections' | 'currentstate' | 'currentstateveh';
  base:       string;
  path:       string;
  filePrefix: string;    // output file prefix; gets _pN.json suffix when paginated
  paginated:  boolean;
  // Extra static query params (beyond Page / PageSize).
  extraQuery?: Record<string, string>;
  // Optional filter applied per row before persisting. Returns false to drop.
  rowFilter?: (row: any) => boolean;
};

const ENDPOINTS: EndpointSpec[] = [
  {
    name:       'vehicles',
    base:       SHARED_BASE,
    path:       '/api/report/vehicles',
    filePrefix: 'vehicles',
    paginated:  true,   // merged into vehicles.json at the end
  },
  {
    name:       'inactive',
    base:       SHARED_BASE,
    path:       '/api/report/vehiclesWithoutTransaction',
    filePrefix: 'vehiclesWithoutTransaction',
    paginated:  true,
  },
  {
    // Authoritative per-vehicle current state. The `state` field ("En
    // Operación" / "Fuera de Operación" / etc.) drives the importer's
    // orphan classification — anything other than "En Operación" lands
    // companyId=null + estadoOperacional=fuera_de_operacion. Same bearer
    // as the others; lives under /shared not /reports.
    name:       'currentstateveh',
    base:       SHARED_BASE,
    path:       '/api/report/currentstatevehicles',
    filePrefix: 'currentstateveh',             // → currentstateveh_pN.json
    paginated:  true,
  },
  {
    name:       'tires',
    base:       REPORTS_BASE,
    path:       '/api/report/tires',
    filePrefix: 'tires',                       // → tires_p0.json, tires_p1.json, ...
    paginated:  true,
  },
  {
    // Authoritative "current snapshot" per tire — carries tireStateId
    // (Desecho / Reencauche / …), per-axis current depths, commercialCost
    // per life, and averageDepth/minDepth. Import prefers values from
    // this endpoint over the plain `tires` list when both are present.
    // ClientType=2 filters to CPK-billable tires (the ones Merquellantas
    // actually tracks for us).
    name:       'currentstate',
    base:       REPORTS_BASE,
    path:       '/api/report/currentstatetires',
    filePrefix: 'currentstate',                // → currentstate_p0.json, …
    paginated:  true,
    extraQuery: { ClientType: '2' },
  },
  {
    name:       'inspections',
    base:       REPORTS_BASE,
    path:       '/api/report/inspection',
    filePrefix: 'inspections',                 // → inspections_p0.json, ...
    paginated:  true,
    // Incremental mode: drop rows older than --since. The API still returns
    // them (pagination ordering is newest-first per the spec), so we filter
    // client-side rather than trusting a server-side `date=>` query param
    // which may not exist.
    rowFilter: SINCE_ISO ? (row) => {
      const d = row?.date ? new Date(String(row.date)) : null;
      return d ? d.getTime() >= new Date(SINCE_ISO + 'T00:00:00Z').getTime() : true;
    } : undefined,
  },
];

// =============================================================================
// HTTP
// =============================================================================

// Merquellantas API quirks:
//   • The token is the raw Authorization value — NOT "Bearer <token>".
//     A Bearer prefix yields 401 "Usuario no autenticado".
//   • Node's fetch (undici) triggers a 500 on their backend — something
//     in the default header set (sec-fetch-*, Accept-Encoding, etc.) that
//     their ancient .NET stack chokes on. Using native https.request with
//     only the Authorization header works reliably.
function authFetch(url: string): Promise<any> {
  const u = new NodeURL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host:   u.host,
      path:   u.pathname + u.search,
      method: 'GET',
      headers: { Authorization: TOKEN },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        const status = res.statusCode ?? 0;
        if (status === 401) return reject(new Error(`401 Unauthorized from ${url} — check MERQUELLANTAS_TOKEN`));
        if (status < 200 || status >= 300) {
          return reject(new Error(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`));
        }
        if (!body.trim()) return resolve([]);
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Bad JSON from ${url}: ${(e as Error).message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Pulls every page of `<base><path>` until the server returns an empty array
// (or a non-array, which we also treat as terminal). Returns the full
// concatenated dataset AND, for paginated outputs, a list of per-page
// chunks so the caller can persist one file per page — matching the
// importer's `tires_p*` / `inspections_p*` shape.
type PageResult = { all: any[]; pages: any[][] };

async function fetchAllPages(spec: EndpointSpec): Promise<PageResult> {
  // We dedupe by `id` across pages because some Merquellantas endpoints
  // (vehicles, vehiclesWithoutTransaction) ignore the Page parameter and
  // return the entire dataset on every call — sometimes reshuffled, so a
  // hash compare alone isn't enough. Tracking unique IDs handles:
  //   • Full-dump endpoints (stop after page 0: zero new IDs on page 1).
  //   • True pagination (keep going while new IDs keep arriving).
  //   • Shuffled-full-dump (stop after page 0 even if hash differs).
  const all: any[] = [];
  const pages: any[][] = [];
  const seenIds = new Set<string | number>();

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(spec.base + spec.path);
    url.searchParams.set('Page', String(page));
    if (PAGE_SIZE) url.searchParams.set('PageSize', PAGE_SIZE);
    if (spec.extraQuery) {
      for (const [k, v] of Object.entries(spec.extraQuery)) url.searchParams.set(k, v);
    }

    const t0 = Date.now();
    const data = await authFetch(url.toString());

    if (!Array.isArray(data)) {
      if (page === 0) {
        throw new Error(`${spec.name} page 0 returned non-array (got ${typeof data}). Top-level keys: ${Object.keys(data ?? {}).join(', ')}`);
      }
      break;
    }
    if (data.length === 0) break;

    // Per-page dedup against the global seen-ID set. Rows with no `id`
    // fall back to a JSON-stringify fingerprint so they still dedupe.
    const fresh: any[] = [];
    for (const row of data) {
      const id = row?.id ?? JSON.stringify(row).slice(0, 80);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      fresh.push(row);
    }

    const filtered = spec.rowFilter ? fresh.filter(spec.rowFilter) : fresh;
    all.push(...filtered);
    // Only persist a page file if there's something new; otherwise we'd
    // create zero-row _pN.json leftovers on every shuffled-full-dump call.
    if (filtered.length > 0) pages.push(filtered);

    if (VERBOSE) {
      const keys = data[0] && typeof data[0] === 'object'
        ? Object.keys(data[0]).slice(0, 8).join(',') : '-';
      console.log(`  ${spec.name} p${page}: ${data.length} rows (${fresh.length} new, kept ${filtered.length}) in ${Date.now() - t0}ms [${keys}]`);
    }

    // Stop when this page contributed zero new IDs — either because the
    // dataset is exhausted (real pagination) or the endpoint is returning
    // the same rows on every call (full-dump).
    if (fresh.length === 0) break;
  }
  return { all, pages };
}

// =============================================================================
// Disk
// =============================================================================

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

// Remove any <prefix>_p*.json files from a previous run so leftover pages
// can't sneak into the import when today's dataset is smaller.
function purgePriorPages(prefix: string) {
  if (!fs.existsSync(OUT_DIR)) return;
  for (const f of fs.readdirSync(OUT_DIR)) {
    if (f.startsWith(prefix + '_p') && f.endsWith('.json')) {
      fs.unlinkSync(path.join(OUT_DIR, f));
    }
  }
}

function writeJson(filename: string, data: any) {
  const p = path.join(OUT_DIR, filename);
  fs.writeFileSync(p, JSON.stringify(data));
  const kb = Math.round(fs.statSync(p).size / 1024);
  console.log(`  wrote ${filename}: ${Array.isArray(data) ? `${data.length} rows` : 'object'} (${kb} KB)`);
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  ensureOutDir();
  console.log(`▶ fetch-merquellantas-api → ${OUT_DIR}`);
  if (SINCE_ISO)    console.log(`  incremental since: ${SINCE_ISO}`);
  if (ONLY_ENDPOINT) console.log(`  endpoint filter:   ${ONLY_ENDPOINT}`);

  const picked = ONLY_ENDPOINT
    ? ENDPOINTS.filter((e) => e.name === ONLY_ENDPOINT)
    : ENDPOINTS;
  if (picked.length === 0) {
    throw new Error(`Unknown endpoint ${ONLY_ENDPOINT}; valid: ${ENDPOINTS.map(e => e.name).join(', ')}`);
  }

  for (const spec of picked) {
    console.log(`\n● ${spec.name}  ${spec.base}${spec.path}`);
    const t0 = Date.now();
    const { all, pages } = await fetchAllPages(spec);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  ${all.length} total rows, ${pages.length} pages, ${elapsed}s`);

    if (spec.name === 'vehicles' || spec.name === 'inactive') {
      // Importer expects one consolidated file.
      writeJson(`${spec.filePrefix}.json`, all);
    } else {
      // Paginated on disk too — lets future incremental runs replace only
      // the most recent pages without re-writing gigabytes.
      purgePriorPages(spec.filePrefix);
      pages.forEach((chunk, i) => {
        writeJson(`${spec.filePrefix}_p${i}.json`, chunk);
      });
    }
  }

  console.log(`\n✓ fetch complete`);

  if (RUN_IMPORT) {
    console.log(`\n▶ running import-merquepro.ts --apply --skip-refresh`);
    const r = spawnSync('npx', ['ts-node', 'scripts/import-merquepro.ts', '--apply', '--skip-refresh'], {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
    if (r.status !== 0) {
      console.error(`importer exited with code ${r.status}`);
      process.exit(r.status ?? 1);
    }
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
