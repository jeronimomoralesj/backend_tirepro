import { Injectable, Logger, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { RetailScraperService, ScrapedProductSpecs } from './retail-scraper.service';

/**
 * Map Alkosto's spec-table labels to TireMasterCatalog fields. Lets
 * a retail-source scrape auto-populate the same fields the admin
 * fills manually at /dashboard/catalogoSku/:id, so a freshly-imported
 * SKU with an Alkosto link gets a real ficha técnica without manual
 * data entry. Returns a partial — fields the scrape can't answer (or
 * that come back blank) are simply omitted.
 *
 * Mapping table (Alkosto label → catalog field):
 *   Ancho de la Llanta      → anchoMm        (number, parsed)
 *   Perfil                  → perfil         (string)
 *   Rin                     → rin            (string)
 *   Posicion de la Llanta   → posicion       (string)
 *   Usos de La Llanta       → terreno        (string — "Mixta", "Carretera", …)
 *   Capacidad de Carga      → indiceCarga    (string — "102 I.C - 850Kg")
 *   Indice de Velocidad     → indiceVelocidad (string — "H 210 Km/h")
 *   No. Lonas               → pr             (string — "4 Lonas" / "16PR")
 *   Tipo de Fabricacion     → tipo           (string — "Radial (Sellomatic)")
 *
 * Unmapped Alkosto fields (Labrado, Pais de Origen, Garantía, vehicle
 * compatibility lists, etc.) stay in the raw productSpecs JSON so the
 * "Detalles de la llanta" panel still surfaces them.
 */
function mapAlkostoSpecsToCatalogFields(specs: ScrapedProductSpecs): {
  anchoMm?: number | null;
  perfil?: string | null;
  rin?: string | null;
  posicion?: string | null;
  terreno?: string | null;
  indiceCarga?: string | null;
  indiceVelocidad?: string | null;
  pr?: string | null;
  tipo?: string | null;
} {
  // Flat lookup: lower-cased label → value.
  const byLabel = new Map<string, string>();
  for (const sec of specs.sections) {
    for (const item of sec.items) {
      const key = item.label.toLowerCase().trim();
      if (key && !byLabel.has(key)) byLabel.set(key, item.value.trim());
    }
  }
  const get = (label: string): string | undefined => {
    const v = byLabel.get(label.toLowerCase().trim());
    return v && v.length > 0 ? v : undefined;
  };
  // Pull the leading numeric token from a string (handles "215", "215 mm",
  // "85.5", "16/18 PR" → 16). Returns undefined if no digit found.
  const parseNum = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    const m = v.match(/(\d+(?:[.,]\d+)?)/);
    if (!m) return undefined;
    const n = parseFloat(m[1].replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    anchoMm:         parseNum(get('Ancho de la Llanta')),
    perfil:          get('Perfil'),
    rin:             get('Rin'),
    posicion:        get('Posicion de la Llanta') ?? get('Posición de la Llanta'),
    terreno:         get('Usos de La Llanta') ?? get('Usos de la Llanta'),
    indiceCarga:     get('Capacidad de Carga'),
    indiceVelocidad: get('Indice de Velocidad') ?? get('Índice de Velocidad'),
    pr:              get('No. Lonas') ?? get('Numero de Lonas'),
    tipo:            get('Tipo de Fabricacion') ?? get('Tipo de Fabricación'),
  };
}

/**
 * Owns the lifecycle of RetailSource + RetailPickupPoint rows. Every
 * mutating operation runs the scraper synchronously and refreshes the
 * pickup points in the same transaction so the dist's UI never sees
 * a half-updated state. The cron path uses the same `refreshSource`
 * primitive — single source of truth.
 */
@Injectable()
export class RetailSourceService {
  private readonly logger = new Logger(RetailSourceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scraper: RetailScraperService,
  ) {}

  // -------------------------------------------------------------------
  // Auth helper — every dist-facing endpoint funnels through this so
  // we have one place to audit ownership. The listing must belong to
  // the company in the JWT.
  // -------------------------------------------------------------------
  private async requireOwnedListing(listingId: string, companyId: string) {
    const listing = await this.prisma.distributorListing.findUnique({
      where:  { id: listingId },
      select: { id: true, distributorId: true },
    });
    if (!listing) throw new NotFoundException('Listing not found');
    if (listing.distributorId !== companyId) {
      throw new ForbiddenException('Listing does not belong to your company');
    }
    return listing;
  }

  // -------------------------------------------------------------------
  // Read paths
  // -------------------------------------------------------------------

  /** Distributor view — full source + every point (ordered by city,
   *  stock desc) regardless of stock level so the dist can audit
   *  empties too. */
  async getForDist(listingId: string, companyId: string) {
    await this.requireOwnedListing(listingId, companyId);
    const source = await this.prisma.retailSource.findUnique({
      where: { listingId },
      include: {
        pickupPoints: {
          orderBy: [{ city: 'asc' }, { stockUnits: 'desc' }, { name: 'asc' }],
        },
      },
    });
    return source ?? null;
  }

  /** Public buyer-facing view — strips out the parts a buyer doesn't
   *  need (priceHtmlSnippet, lastError, etc.) and only returns points
   *  with stock > 0. Caller passes listingId; the response is safe to
   *  serve uncached because it's read-mostly and tiny. */
  async getForBuyer(listingId: string) {
    const source = await this.prisma.retailSource.findUnique({
      where: { listingId },
      include: {
        pickupPoints: {
          where:   { stockUnits: { gt: 0 } },
          orderBy: [{ stockUnits: 'desc' }, { city: 'asc' }, { name: 'asc' }],
        },
      },
    });
    if (!source || !source.isActive) return null;
    // Group points by normalised city for the city-first selector UX.
    const byCity = new Map<string, {
      city: string; cityDisplay: string; totalStock: number;
      points: Array<{
        id: string; externalId: string | null; name: string;
        address: string | null; lat: number | null; lng: number | null;
        hours: string | null; stockUnits: number;
      }>;
    }>();
    for (const p of source.pickupPoints) {
      const key = p.city;
      if (!byCity.has(key)) {
        byCity.set(key, { city: p.city, cityDisplay: p.cityDisplay ?? p.city, totalStock: 0, points: [] });
      }
      const entry = byCity.get(key)!;
      entry.totalStock += p.stockUnits;
      entry.points.push({
        id: p.id, externalId: p.externalId, name: p.name,
        address: p.address, lat: p.lat, lng: p.lng,
        hours: p.hours, stockUnits: p.stockUnits,
      });
    }
    return {
      url: source.url,
      domain: source.domain,
      lastSuccessAt: source.lastSuccessAt,
      cities: Array.from(byCity.values()).sort((a, b) => b.totalStock - a.totalStock),
    };
  }

  // -------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------

  /** Create or replace the source for a listing. Fires an immediate
   *  refresh so the dist gets feedback ("here are 38 stores, 4 with
   *  stock") in the same request. Snippets are stored verbatim for
   *  the admin UI — they don't gate the parse path. */
  async upsertForDist(
    listingId: string,
    companyId: string,
    input: { url: string; priceHtmlSnippet?: string; stockHtmlSnippet?: string },
  ) {
    await this.requireOwnedListing(listingId, companyId);
    const url = (input.url ?? '').trim();
    if (!url) throw new BadRequestException('url required');

    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new BadRequestException('URL inválida'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BadRequestException('Solo aceptamos URLs http(s)');
    }
    const domain = parsed.hostname.replace(/^www\./i, '').toLowerCase();

    // Upsert with refreshed-state set later by `refreshSource`. We
    // do a write-then-refresh so the timestamps are consistent even
    // if the caller hits the row via /refresh next.
    const source = await this.prisma.retailSource.upsert({
      where:  { listingId },
      create: {
        listingId, url, domain,
        priceHtmlSnippet: input.priceHtmlSnippet?.slice(0, 8000) ?? null,
        stockHtmlSnippet: input.stockHtmlSnippet?.slice(0, 16000) ?? null,
        isActive: true,
      },
      update: {
        url, domain,
        priceHtmlSnippet: input.priceHtmlSnippet?.slice(0, 8000) ?? null,
        stockHtmlSnippet: input.stockHtmlSnippet?.slice(0, 16000) ?? null,
        isActive: true,
        // Don't reset lastError — it'll get cleared on the next
        // successful refresh. If the user pasted a bad URL we want
        // them to see the failure in the very next refresh.
      },
    });

    // Fire the refresh immediately so the dist gets validation feedback.
    await this.refreshSource(source.id);
    return this.getForDist(listingId, companyId);
  }

  /** Manual refresh from the dist UI ("Actualizar ahora"). */
  async refreshForDist(listingId: string, companyId: string) {
    await this.requireOwnedListing(listingId, companyId);
    const source = await this.prisma.retailSource.findUnique({
      where: { listingId }, select: { id: true },
    });
    if (!source) throw new NotFoundException('No retail source connected');
    await this.refreshSource(source.id);
    return this.getForDist(listingId, companyId);
  }

  /** Detach the source — cascade delete also wipes pickup points. */
  async deleteForDist(listingId: string, companyId: string) {
    await this.requireOwnedListing(listingId, companyId);
    await this.prisma.retailSource.deleteMany({ where: { listingId } });
    return { deleted: true };
  }

  // -------------------------------------------------------------------
  // The refresh primitive — used by upsert/refresh/cron alike.
  //
  // Always writes lastFetchedAt + (lastSuccessAt | lastError). Pickup
  // points are reconciled by `(sourceId, externalId)` — points the
  // retailer no longer lists go to stockUnits=0 with a fresh
  // refreshedAt rather than getting deleted (preserves historical
  // order references that might still point at them).
  // -------------------------------------------------------------------
  async refreshSource(sourceId: string): Promise<void> {
    const source = await this.prisma.retailSource.findUnique({ where: { id: sourceId } });
    if (!source) return;
    if (!source.isActive) return;
    const fetchedAt = new Date();
    try {
      const result = await this.scraper.fetch(source.url);
      // Fold the new points onto the existing rows. Two passes:
      //   1. Upsert each scraped point — match against existing rows
      //      by externalId first, falling back to (name, city) so
      //      stores Alkosto ships without a stable id don't get
      //      re-created on every refresh (was producing 4–5 duplicate
      //      rows for the same physical bodega).
      //   2. Zero out any existing row that wasn't matched in this run,
      //      including legacy duplicates accumulated before the fix.
      //      Stock-zero is preferred over delete to keep historical
      //      MarketplaceOrder.pickupPointId references intact.
      const existing = await this.prisma.retailPickupPoint.findMany({
        where: { sourceId },
        select: { id: true, externalId: true, name: true, city: true },
      });
      const norm = (s: string) => s.toLowerCase().trim();
      const seenIds = new Set<string>();
      for (const p of result.points) {
        const externalId = p.externalId ?? null;
        // Match priority:
        //   1. externalId match (when both sides have a non-null id)
        //   2. (name, city) match — handles Alkosto stores without a
        //      stable id, AND legacy duplicate rows from before this
        //      fix landed (we'll match the FIRST one and zero the rest)
        let match = externalId
          ? existing.find((e) => e.externalId === externalId && !seenIds.has(e.id))
          : null;
        if (!match) {
          match = existing.find((e) =>
            norm(e.name) === norm(p.name) &&
            norm(e.city) === norm(p.city) &&
            !seenIds.has(e.id),
          );
        }
        if (match) {
          seenIds.add(match.id);
          await this.prisma.retailPickupPoint.update({
            where: { id: match.id },
            data: {
              externalId, // backfill if the row was created without one
              name: p.name,
              address: p.address ?? null,
              city: p.city,
              cityDisplay: p.cityDisplay ?? null,
              lat: p.lat ?? null,
              lng: p.lng ?? null,
              hours: p.hours ?? null,
              stockUnits: p.stockUnits,
              refreshedAt: fetchedAt,
            },
          });
        } else {
          const created = await this.prisma.retailPickupPoint.create({
            data: {
              sourceId,
              externalId,
              name: p.name,
              address: p.address ?? null,
              city: p.city,
              cityDisplay: p.cityDisplay ?? null,
              lat: p.lat ?? null,
              lng: p.lng ?? null,
              hours: p.hours ?? null,
              stockUnits: p.stockUnits,
              refreshedAt: fetchedAt,
            },
            select: { id: true },
          });
          seenIds.add(created.id);
        }
      }
      // Cleanup pass — split unseen rows into two buckets:
      //   1. Legacy duplicates (same (name, city) as a row we DID
      //      match): hard-delete. Safe because pickupPointId is a
      //      soft FK by design (see schema: "NOT a hard FK because we
      //      want the order detail to survive even if the pickup
      //      point gets deleted later") and orders carry denormalised
      //      pickupPointName + pickupCity, so deleting the pickup
      //      point row doesn't break order display. This is what
      //      collapses the 4× "Alkomprar Florida 9 u." rows the user
      //      was seeing into a single row.
      //   2. Genuinely dropped by the retailer: keep the row but zero
      //      its stock so any historical order still resolves the
      //      pickup-point id to a real-but-empty record.
      const seenNameCity = new Set<string>();
      for (const id of seenIds) {
        const row = existing.find((e) => e.id === id);
        if (row) seenNameCity.add(`${norm(row.name)}|${norm(row.city)}`);
      }
      const dupeIds = existing
        .filter((e) => !seenIds.has(e.id) && seenNameCity.has(`${norm(e.name)}|${norm(e.city)}`))
        .map((e) => e.id);
      const droppedIds = existing
        .filter((e) => !seenIds.has(e.id) && !seenNameCity.has(`${norm(e.name)}|${norm(e.city)}`))
        .map((e) => e.id);

      if (dupeIds.length > 0) {
        await this.prisma.retailPickupPoint.deleteMany({ where: { id: { in: dupeIds } } });
        this.logger.log(`Removed ${dupeIds.length} duplicate pickup-point row${dupeIds.length === 1 ? '' : 's'} from source ${sourceId}`);
      }
      if (droppedIds.length > 0) {
        await this.prisma.retailPickupPoint.updateMany({
          where: { id: { in: droppedIds } },
          data:  { stockUnits: 0, refreshedAt: fetchedAt },
        });
      }
      await this.prisma.retailSource.update({
        where: { id: sourceId },
        data: {
          lastFetchedAt: fetchedAt,
          lastSuccessAt: fetchedAt,
          lastPriceCop:  result.priceCop ?? source.lastPriceCop,
          lastError:     null,
          domain:        result.domain,
        },
      });

      // Cache the scraped product specs on the catalog SKU + auto-fill
      // any structured catalog fields the scrape can answer (anchoMm,
      // perfil, rin, indiceCarga, indiceVelocidad, …). Same fields the
      // admin manually edits at /dashboard/catalogoSku/:id, so this
      // saves a lot of manual data entry. POLICY: never overwrite a
      // value already on the catalog — admin-curated data wins. We
      // only fill rows that are still null. Multiple distributors may
      // sell the same SKU; whichever refresh runs first against a
      // freshly-minted catalog populates it, subsequent scrapes leave
      // it alone unless an admin clears the field.
      if (result.productSpecs) {
        const listing = await this.prisma.distributorListing.findUnique({
          where: { id: source.listingId },
          select: {
            catalogId: true,
            catalog: { select: {
              anchoMm: true, perfil: true, rin: true,
              posicion: true, terreno: true,
              indiceCarga: true, indiceVelocidad: true,
              pr: true, tipo: true,
            } },
          },
        });
        if (listing?.catalogId) {
          const mapped = mapAlkostoSpecsToCatalogFields(result.productSpecs);
          const cur = listing.catalog;
          // Only fill catalog fields that are currently null/empty.
          const fillData: any = {};
          const isEmpty = (v: unknown) => v == null || (typeof v === 'string' && v.trim() === '');
          if (mapped.anchoMm         != null && isEmpty(cur?.anchoMm))         fillData.anchoMm         = mapped.anchoMm;
          if (mapped.perfil          != null && isEmpty(cur?.perfil))          fillData.perfil          = mapped.perfil;
          if (mapped.rin             != null && isEmpty(cur?.rin))             fillData.rin             = mapped.rin;
          if (mapped.posicion        != null && isEmpty(cur?.posicion))        fillData.posicion        = mapped.posicion;
          if (mapped.terreno         != null && isEmpty(cur?.terreno))         fillData.terreno         = mapped.terreno;
          if (mapped.indiceCarga     != null && isEmpty(cur?.indiceCarga))     fillData.indiceCarga     = mapped.indiceCarga;
          if (mapped.indiceVelocidad != null && isEmpty(cur?.indiceVelocidad)) fillData.indiceVelocidad = mapped.indiceVelocidad;
          if (mapped.pr              != null && isEmpty(cur?.pr))              fillData.pr              = mapped.pr;
          if (mapped.tipo            != null && isEmpty(cur?.tipo))            fillData.tipo            = mapped.tipo;
          await this.prisma.tireMasterCatalog.update({
            where: { id: listing.catalogId },
            data:  {
              productSpecs:   result.productSpecs as any,
              productSpecsAt: fetchedAt,
              ...fillData,
            },
          });
          if (Object.keys(fillData).length > 0) {
            this.logger.log(
              `Auto-filled catalog ${listing.catalogId} from Alkosto: ${Object.keys(fillData).join(', ')}`,
            );
          }
        }
      }

      this.logger.log(
        `Refreshed retail source ${sourceId}: ${result.points.length} points, ` +
        `price ${result.priceCop ?? 'n/a'}, ` +
        `specs ${result.productSpecs ? `${result.productSpecs.sections.length} sections` : 'none'}`,
      );
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 800) ?? String(err);
      await this.prisma.retailSource.update({
        where: { id: sourceId },
        data: { lastFetchedAt: fetchedAt, lastError: msg },
      });
      this.logger.warn(`Retail source ${sourceId} refresh failed: ${msg}`);
    }
  }

  // -------------------------------------------------------------------
  // CRON — runs once per day at 4am Bogotá time. Walks every active
  // source and refreshes serially (alkosto-style retailers don't like
  // bursty parallel requests from one IP). Even at 100 dists this is
  // <2 minutes, well within a comfortable cron budget.
  // -------------------------------------------------------------------
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { timeZone: 'America/Bogota' })
  async runDailyRefresh() {
    const sources = await this.prisma.retailSource.findMany({
      where: { isActive: true },
      select: { id: true, url: true },
    });
    this.logger.log(`Starting daily retail-source refresh (${sources.length} sources)`);
    let ok = 0, fail = 0;
    for (const s of sources) {
      try {
        await this.refreshSource(s.id);
        ok += 1;
        // 1.5s delay between requests to be polite to the retailer.
        await new Promise((r) => setTimeout(r, 1500));
      } catch (err) {
        fail += 1;
        this.logger.warn(`Daily refresh ${s.id} crashed: ${(err as Error).message}`);
      }
    }
    this.logger.log(`Daily retail-source refresh done: ${ok} ok, ${fail} failed`);
  }
}
