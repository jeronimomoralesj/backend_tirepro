import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { PrismaService } from '../prisma/prisma.service';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = 'amazon.nova-lite-v1:0';
const DATASET_TTL_MS = 120_000; // cache fleet data for 2 min

/* ═══════════════════════════════════════════════════════════════════════════
   SYSTEM PROMPT
   ═══════════════════════════════════════════════════════════════════════════ */

const BLOCK_SCHEMA = `Bloques disponibles (copia la forma EXACTA):
- {"kind":"kpis","title":"Resumen","items":[{"label":"Total","value":"245","hint":"+3%","tone":"good"}]}
- {"kind":"bar","title":"CPK por marca","unit":"$/km","data":[{"label":"Michelin","value":42},{"label":"Continental","value":48}]}
- {"kind":"line","title":"CPK 6 meses","unit":"$","data":[{"label":"Ene","value":45},{"label":"Feb","value":42}]}
- {"kind":"pie","title":"Mix marcas","data":[{"label":"Continental","value":48},{"label":"Michelin","value":32}]}
- {"kind":"table","title":"Críticas","columns":["Placa","Posición","Profundidad","Plazo"],"rows":[["ABC-123","Dir.Izq","2.1mm","Inmediato"]]}
- {"kind":"gauge","title":"Salud flota","value":78,"label":"4 críticas"}
- {"kind":"callout","tone":"warn","text":"3 llantas requieren cambio inmediato."}

PROHIBIDO: campos "keys","values","labels","colors" como arrays sueltos. Datos SIEMPRE en "data" (o "items" para kpis, "rows" para table).
orientation en bar: "vertical"|"horizontal". tone: good|warn|bad|info|neutral.`;

function buildSystemPrompt(dataset: string): string {
  return `Eres Ana, la analista experta de llantas más completa de TirePro. Español colombiano, profesional pero cercana.

ROL:
- Eres una experta mundial en gestión de flotas y llantas comerciales.
- Puedes generar reportes, análisis, proyecciones, benchmarks, y gráficos de CUALQUIER tipo.
- Respondes con datos reales del TIREDATA — nunca inventas números.
- Si el usuario pide un reporte, genera múltiples blocks combinados (kpis + bar + table, etc).

CONTEXTO TÉCNICO:
- CPK = costo total acumulado / km totales recorridos (todas las vidas). Menor = mejor.
- CPK Proyectado = costo total / km proyectados (hasta límite legal 2mm)
- Profundidad siempre baja (solo sube con reencauche). Límite legal: 2mm.
- Clasificación alertas: inmediato(≤2mm) 30d(2-4mm) 60d(4-6mm) óptimo(>6mm)
- Ejes: direccion, traccion, libre, remolque, repuesto
- Vidas: nueva, reencauche1, reencauche2, reencauche3, fin
- Health score: 0-100 (profundidad 50%, tendencia CPK 30%, irregularidad 20%)
- ROI reencauche: retreadRoiRatio < 1.0 = reencauche rinde más que comprar nueva

TIREDATA:
${dataset}

RESPONDE SOLO JSON PURO (sin markdown, sin \`\`\`): {"text":"...","blocks":[...],"suggestions":[{"label":"...","intent":"..."}]}

${BLOCK_SCHEMA}

REGLAS:
- text conciso (1-4 frases). NO repitas cifras que ya van en blocks.
- Para reportes: combina múltiples blocks (kpis + gráfico + tabla).
- Para comparaciones: usa bar chart horizontal.
- Para distribuciones: usa pie chart.
- Para tendencias temporales: usa line chart.
- Para listados detallados: usa table.
- Para métricas clave: usa kpis (2-6 items).
- Para alertas urgentes: usa callout con tone apropiado.
- blocks combina lo necesario. Reportes complejos → 3-5 blocks.
- Si no pidieron datos (saludo, charla), blocks:[].
- Solo números del TIREDATA. NO inventes.
- suggestions opcional, máx 3. Sugiere análisis relacionados relevantes.
- Saludo/identidad: preséntate como Ana de TirePro y blocks:[].
- IMPORTANTE: responde SOLO el objeto JSON, nada más.`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE
   ═══════════════════════════════════════════════════════════════════════════ */

type AnaReply = {
  text: string;
  blocks: unknown[];
  suggestions: { label: string; intent: string }[] | null;
};

@Injectable()
export class AnaService {
  private readonly client: BedrockRuntimeClient;
  private readonly log = new Logger(AnaService.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    @Inject(CACHE_MANAGER) private cache: Cache,
  ) {
    this.client = new BedrockRuntimeClient({
      region: config.get<string>('AWS_REGION') || 'us-east-1',
    });
  }

  async chat(
    companyId: string,
    message: string,
    history: { role: string; text: string }[] = [],
    tireDataFallback = '',
  ): Promise<AnaReply> {
    let dataset: string;
    if (companyId) {
      dataset = await this.getFleetDataset(companyId);
    } else {
      dataset = tireDataFallback || 'No hay datos de llantas cargados.';
    }

    const systemPrompt = buildSystemPrompt(dataset);

    const messages: Message[] = [];
    for (const m of history.slice(-8)) {
      if (!m?.text) continue;
      messages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: [{ text: m.text }],
      });
    }
    messages.push({ role: 'user', content: [{ text: message }] });

    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: systemPrompt }],
      messages,
      inferenceConfig: {
        temperature: 0.55,
        maxTokens: 2000,
      },
    });

    let raw: string;
    try {
      const res = await this.client.send(command);
      raw = res.output?.message?.content?.[0]?.text ?? '';
    } catch (err) {
      this.log.error('Bedrock call failed', (err as Error).message);
      throw err;
    }

    let parsed: { text?: unknown; blocks?: unknown; suggestions?: unknown } =
      {};
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch {
      parsed = { text: raw || 'Entendido.' };
    }

    return {
      text:
        typeof parsed.text === 'string' && parsed.text.trim()
          ? parsed.text.trim()
          : 'Entendido.',
      blocks: normalizeBlocks(parsed.blocks),
      suggestions: normalizeSuggestions(parsed.suggestions),
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     FLEET DATASET BUILDER — queries DB and returns compact text for prompt
     ═══════════════════════════════════════════════════════════════════════ */

  private async getFleetDataset(companyId: string): Promise<string> {
    const cacheKey = `ana:dataset:${companyId}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached) return cached;

    const dataset = await this.buildFleetDataset(companyId);
    await this.cache.set(cacheKey, dataset, DATASET_TTL_MS);
    return dataset;
  }

  private async buildFleetDataset(companyId: string): Promise<string> {
    const [
      tires,
      vehicles,
      recentSnapshots,
      benchmarks,
      costBreakdown,
    ] = await Promise.all([
      this.prisma.tire.findMany({
        where: { companyId },
        select: {
          id: true,
          marca: true,
          diseno: true,
          dimension: true,
          eje: true,
          vidaActual: true,
          profundidadInicial: true,
          currentProfundidad: true,
          currentCpk: true,
          lifetimeCpk: true,
          currentPresionPsi: true,
          healthScore: true,
          alertLevel: true,
          kilometrosRecorridos: true,
          projectedKmRemaining: true,
          projectedDateEOL: true,
          projectedDaysToLimit: true,
          degradationRateMmPerDay: true,
          cpkTrend: true,
          posicion: true,
          vehicle: { select: { placa: true, tipovhc: true, kilometrajeActual: true, cliente: true } },
          costos: { select: { valor: true, concepto: true } },
        },
      }),
      this.prisma.vehicle.findMany({
        where: { companyId, archivedAt: null },
        select: {
          id: true,
          placa: true,
          tipovhc: true,
          kilometrajeActual: true,
          kmMensualReal: true,
          cliente: true,
          _count: { select: { tires: true } },
        },
      }),
      this.prisma.companySnapshot.findMany({
        where: { companyId },
        orderBy: { fecha: 'desc' },
        take: 6,
        select: {
          fecha: true,
          totalTires: true,
          tiresCritical: true,
          tiresWarning: true,
          tiresWatch: true,
          tiresOk: true,
          avgCpk: true,
          avgHealthScore: true,
          totalFleetCost: true,
          bestBrand: true,
          worstBrand: true,
          retreadRoiFlota: true,
        },
      }),
      this.prisma.tireBenchmark.findMany({
        take: 20,
        orderBy: { sampleSize: 'desc' },
        select: {
          marca: true,
          diseno: true,
          dimension: true,
          avgCpk: true,
          avgKmPorVida: true,
          retreadRoiRatio: true,
          sampleSize: true,
          precioPromedio: true,
        },
      }),
      this.prisma.tireCosto.groupBy({
        by: ['concepto'],
        where: { tire: { companyId } },
        _sum: { valor: true },
        _count: true,
      }),
    ]);

    if (!tires.length) return 'Sin datos de llantas para esta flota.';

    const L: string[] = [];
    const fc = (n: number) =>
      n >= 1e6
        ? `$${(n / 1e6).toFixed(1)}M`
        : n >= 1e3
          ? `$${(n / 1e3).toFixed(0)}K`
          : `$${n.toFixed(0)}`;

    // ── Fleet overview ──
    const totalCost = tires.reduce(
      (s, t) => s + t.costos.reduce((a, c) => a + (c.valor || 0), 0),
      0,
    );
    const totalKm = tires.reduce((s, t) => s + (t.kilometrosRecorridos || 0), 0);
    const alertInm = tires.filter(
      (t) => t.currentProfundidad != null && t.currentProfundidad <= 2,
    ).length;
    const alert30 = tires.filter(
      (t) =>
        t.currentProfundidad != null &&
        t.currentProfundidad > 2 &&
        t.currentProfundidad <= 4,
    ).length;
    const alert60 = tires.filter(
      (t) =>
        t.currentProfundidad != null &&
        t.currentProfundidad > 4 &&
        t.currentProfundidad <= 6,
    ).length;
    const alertOpt = tires.length - alertInm - alert30 - alert60;

    const profValues = tires
      .map((t) => t.currentProfundidad)
      .filter((p): p is number => p != null);
    const healthValues = tires
      .map((t) => t.healthScore)
      .filter((h): h is number => h != null);

    L.push(
      `FLOTA: ${tires.length} llantas, ${vehicles.length} vehículos, ${fc(totalCost)} inversión, ${totalKm >= 1e6 ? `${(totalKm / 1e6).toFixed(1)}M` : `${(totalKm / 1e3).toFixed(0)}K`} km`,
    );
    L.push(`ALERTAS: Inmediato:${alertInm} 30d:${alert30} 60d:${alert60} Óptimo:${alertOpt}`);
    if (profValues.length)
      L.push(
        `PROFUNDIDAD: prom=${(profValues.reduce((a, b) => a + b, 0) / profValues.length).toFixed(1)}mm min=${Math.min(...profValues).toFixed(1)}mm`,
      );
    if (healthValues.length)
      L.push(
        `SALUD: prom=${Math.round(healthValues.reduce((a, b) => a + b, 0) / healthValues.length)}/100`,
      );
    if (totalKm > 0 && totalCost > 0)
      L.push(`CPK FLOTA: $${(totalCost / totalKm).toFixed(1)}/km`);

    // ── Brand performance ──
    const byBrand: Record<
      string,
      { n: number; cpkSum: number; cpkCount: number; healthSum: number; healthCount: number }
    > = {};
    for (const t of tires) {
      const b = t.marca || 'Otro';
      if (!byBrand[b])
        byBrand[b] = { n: 0, cpkSum: 0, cpkCount: 0, healthSum: 0, healthCount: 0 };
      byBrand[b].n++;
      const cpk = t.lifetimeCpk ?? t.currentCpk;
      if (cpk != null && cpk > 0) {
        byBrand[b].cpkSum += cpk;
        byBrand[b].cpkCount++;
      }
      if (t.healthScore != null) {
        byBrand[b].healthSum += t.healthScore;
        byBrand[b].healthCount++;
      }
    }
    const brandEntries = Object.entries(byBrand)
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 10);
    L.push(
      `\nMARCAS[n/CPK/salud]: ${brandEntries.map(([b, v]) => `${b}:${v.n}/${v.cpkCount > 0 ? `$${(v.cpkSum / v.cpkCount).toFixed(0)}` : '-'}/${v.healthCount > 0 ? Math.round(v.healthSum / v.healthCount) : '-'}`).join(' ')}`,
    );

    // ── Design performance ──
    const byDesign: Record<
      string,
      { n: number; cpkSum: number; cpkCount: number; dim: string }
    > = {};
    for (const t of tires) {
      const key = `${t.marca} ${t.diseno || '?'}`;
      if (!byDesign[key])
        byDesign[key] = { n: 0, cpkSum: 0, cpkCount: 0, dim: t.dimension };
      byDesign[key].n++;
      const cpk = t.lifetimeCpk ?? t.currentCpk;
      if (cpk != null && cpk > 0) {
        byDesign[key].cpkSum += cpk;
        byDesign[key].cpkCount++;
      }
    }
    const designEntries = Object.entries(byDesign)
      .filter(([, v]) => v.cpkCount > 0)
      .sort((a, b) => a[1].cpkSum / a[1].cpkCount - b[1].cpkSum / b[1].cpkCount)
      .slice(0, 12);
    if (designEntries.length)
      L.push(
        `DISEÑOS[n/CPK/dim]: ${designEntries.map(([d, v]) => `${d}:${v.n}/$${(v.cpkSum / v.cpkCount).toFixed(0)}/${v.dim}`).join(' ')}`,
      );

    // ── Axle breakdown ──
    const byEje: Record<string, { n: number; cpkSum: number; cpkCount: number }> =
      {};
    for (const t of tires) {
      const e = t.eje || 'otro';
      if (!byEje[e]) byEje[e] = { n: 0, cpkSum: 0, cpkCount: 0 };
      byEje[e].n++;
      const cpk = t.lifetimeCpk ?? t.currentCpk;
      if (cpk != null && cpk > 0) {
        byEje[e].cpkSum += cpk;
        byEje[e].cpkCount++;
      }
    }
    L.push(
      `EJES[n/CPK]: ${Object.entries(byEje).map(([e, v]) => `${e}:${v.n}/${v.cpkCount > 0 ? `$${(v.cpkSum / v.cpkCount).toFixed(0)}` : '-'}`).join(' ')}`,
    );

    // ── Vida breakdown ──
    const byVida: Record<string, { n: number; cpkSum: number; cpkCount: number }> =
      {};
    for (const t of tires) {
      const v = t.vidaActual || 'nueva';
      if (!byVida[v]) byVida[v] = { n: 0, cpkSum: 0, cpkCount: 0 };
      byVida[v].n++;
      const cpk = t.lifetimeCpk ?? t.currentCpk;
      if (cpk != null && cpk > 0) {
        byVida[v].cpkSum += cpk;
        byVida[v].cpkCount++;
      }
    }
    L.push(
      `VIDAS[n/CPK]: ${Object.entries(byVida).map(([v, d]) => `${v}:${d.n}/${d.cpkCount > 0 ? `$${(d.cpkSum / d.cpkCount).toFixed(0)}` : '-'}`).join(' ')}`,
    );

    // ── Dimension breakdown ──
    const byDim: Record<string, number> = {};
    for (const t of tires) {
      const d = t.dimension || '?';
      byDim[d] = (byDim[d] || 0) + 1;
    }
    L.push(
      `DIMENSIONES: ${Object.entries(byDim).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d, n]) => `${d}:${n}`).join(' ')}`,
    );

    // ── Cost breakdown ──
    if (costBreakdown.length) {
      L.push(
        `\nCOSTOS: ${costBreakdown.map((c) => `${c.concepto || 'otro'}:${fc(c._sum.valor || 0)}(${c._count})`).join(' ')}`,
      );
    }

    // ── Critical tires (prof ≤ 4mm) ──
    const criticals = tires
      .filter((t) => t.currentProfundidad != null && t.currentProfundidad <= 4)
      .sort((a, b) => (a.currentProfundidad ?? 99) - (b.currentProfundidad ?? 99))
      .slice(0, 25);
    if (criticals.length) {
      L.push(`\nCRÍTICAS(${criticals.length}/${alertInm + alert30}):`);
      L.push('Vehículo|Llanta|Prof|Eje|CPK|Salud|EOL');
      for (const t of criticals) {
        const cpk = t.lifetimeCpk ?? t.currentCpk;
        const eol = t.projectedDateEOL
          ? new Date(t.projectedDateEOL).toISOString().slice(0, 10)
          : '-';
        L.push(
          `${t.vehicle?.placa || '?'}|${t.marca} ${t.diseno}|${t.currentProfundidad?.toFixed(1)}mm|${t.eje}|${cpk != null ? `$${cpk.toFixed(0)}` : '-'}|${t.healthScore ?? '-'}|${eol}`,
        );
      }
    }

    // ── Projections ──
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 86400000);
    const in60 = new Date(now.getTime() + 60 * 86400000);
    const eol30 = tires.filter(
      (t) => t.projectedDateEOL && new Date(t.projectedDateEOL) <= in30,
    ).length;
    const eol60 = tires.filter(
      (t) =>
        t.projectedDateEOL &&
        new Date(t.projectedDateEOL) > in30 &&
        new Date(t.projectedDateEOL) <= in60,
    ).length;
    const avgDegradation = tires
      .filter((t) => t.degradationRateMmPerDay != null && t.degradationRateMmPerDay > 0)
      .map((t) => t.degradationRateMmPerDay!);
    L.push(`\nPROYECCIONES:`);
    L.push(`Cambio en 30 días: ${eol30} llantas`);
    L.push(`Cambio en 60 días: ${eol60} llantas adicionales`);
    if (avgDegradation.length)
      L.push(
        `Desgaste promedio: ${(avgDegradation.reduce((a, b) => a + b, 0) / avgDegradation.length).toFixed(3)} mm/día`,
      );

    // ── Vehicle summary (top by critical count) ──
    const vehMap: Record<
      string,
      { placa: string; tipo: string; tireCount: number; critCount: number; cpkSum: number; cpkCount: number }
    > = {};
    for (const t of tires) {
      if (!t.vehicle?.placa) continue;
      const p = t.vehicle.placa;
      if (!vehMap[p])
        vehMap[p] = {
          placa: p,
          tipo: t.vehicle.tipovhc || '?',
          tireCount: 0,
          critCount: 0,
          cpkSum: 0,
          cpkCount: 0,
        };
      vehMap[p].tireCount++;
      if (
        t.currentProfundidad != null &&
        t.currentProfundidad <= 4
      )
        vehMap[p].critCount++;
      const cpk = t.lifetimeCpk ?? t.currentCpk;
      if (cpk != null && cpk > 0) {
        vehMap[p].cpkSum += cpk;
        vehMap[p].cpkCount++;
      }
    }
    const topVehicles = Object.values(vehMap)
      .sort((a, b) => b.critCount - a.critCount || b.tireCount - a.tireCount)
      .slice(0, 15);
    if (topVehicles.length) {
      L.push(`\nVEHÍCULOS(top15):`);
      L.push('Placa|Tipo|Llantas|Críticas|CPK');
      for (const v of topVehicles) {
        L.push(
          `${v.placa}|${v.tipo}|${v.tireCount}|${v.critCount}|${v.cpkCount > 0 ? `$${(v.cpkSum / v.cpkCount).toFixed(0)}` : '-'}`,
        );
      }
    }

    // ── Benchmarks ──
    const fleetDesigns = new Set(
      tires.map((t) => `${t.marca}|${t.diseno}|${t.dimension}`),
    );
    const relevantBenchmarks = benchmarks.filter((b) =>
      fleetDesigns.has(`${b.marca}|${b.diseno}|${b.dimension}`),
    );
    if (relevantBenchmarks.length) {
      L.push(`\nBENCHMARK INDUSTRIA:`);
      L.push('Llanta|CPK industria|KM prom|ROI reencauche|Muestra');
      for (const b of relevantBenchmarks.slice(0, 15)) {
        L.push(
          `${b.marca} ${b.diseno} ${b.dimension}|${b.avgCpk != null ? `$${b.avgCpk.toFixed(0)}` : '-'}|${b.avgKmPorVida != null ? `${(b.avgKmPorVida / 1000).toFixed(0)}K` : '-'}|${b.retreadRoiRatio != null ? b.retreadRoiRatio.toFixed(2) : '-'}|${b.sampleSize}`,
        );
      }
    }

    // ── Historical trends ──
    if (recentSnapshots.length) {
      L.push(`\nTENDENCIA(${recentSnapshots.length} períodos, reciente→antiguo):`);
      L.push('Fecha|Llantas|Críticas|CPK|Salud|Inversión|MejorMarca');
      for (const s of recentSnapshots) {
        L.push(
          `${new Date(s.fecha).toISOString().slice(0, 10)}|${s.totalTires}|${s.tiresCritical}|${s.avgCpk != null ? `$${s.avgCpk.toFixed(0)}` : '-'}|${s.avgHealthScore != null ? Math.round(s.avgHealthScore) : '-'}|${s.totalFleetCost != null ? fc(s.totalFleetCost) : '-'}|${s.bestBrand || '-'}`,
        );
      }
    }

    // ── Clients (if any) ──
    const clientSet = new Set<string>();
    for (const v of vehicles) {
      if (v.cliente) clientSet.add(v.cliente);
    }
    if (clientSet.size > 1) {
      L.push(`\nCLIENTES: ${[...clientSet].join(', ')}`);
    }

    const result = L.join('\n');
    this.log.debug(`Fleet dataset for ${companyId}: ${result.length} chars`);
    return result;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS — JSON normalization (same logic as the old route.ts)
   ═══════════════════════════════════════════════════════════════════════════ */

function stripCodeFence(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
  }
  return trimmed;
}

const ALLOWED_KINDS = new Set([
  'kpis', 'bar', 'line', 'pie', 'table', 'gauge', 'callout',
]);

function normalizeBlocks(b: unknown): unknown[] {
  if (!Array.isArray(b)) return [];
  const out: unknown[] = [];
  for (const item of b) {
    if (!item || typeof item !== 'object') continue;
    const coerced = coerceBlock(item as Record<string, unknown>);
    if (coerced) out.push(coerced);
  }
  return out;
}

function coerceBlock(
  x: Record<string, unknown>,
): Record<string, unknown> | null {
  const kind = x.kind;
  if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind)) return null;
  const out: Record<string, unknown> = { ...x, kind };

  if (kind === 'bar' || kind === 'line' || kind === 'pie') {
    out.data = coerceXY(out.data, out);
    if (!Array.isArray(out.data) || out.data.length === 0) return null;
  } else if (kind === 'kpis') {
    if (!Array.isArray(out.items)) {
      const alt = (out.data ?? out.kpis) as unknown;
      if (Array.isArray(alt)) out.items = alt;
    }
    if (!Array.isArray(out.items) || (out.items as unknown[]).length === 0)
      return null;
  } else if (kind === 'table') {
    if (!Array.isArray(out.columns) || !Array.isArray(out.rows)) return null;
  } else if (kind === 'gauge') {
    const v = out.value;
    if (typeof v !== 'number') {
      const n = Number(v);
      if (Number.isFinite(n)) out.value = n;
      else return null;
    }
  } else if (kind === 'callout') {
    if (typeof out.text !== 'string' || !out.text) return null;
  }
  return out;
}

function coerceXY(
  data: unknown,
  container: Record<string, unknown>,
): unknown {
  if (Array.isArray(data) && data.length > 0 && data.every(isLabelValue))
    return data;
  const keys = (container.keys ?? container.labels ?? container.categories) as unknown;
  const values = (container.values ?? container.amounts ?? container.counts) as unknown;
  if (Array.isArray(keys) && Array.isArray(values)) {
    return keys.map((k, i) => ({
      label: String(k),
      value: Number((values as unknown[])[i]) || 0,
    }));
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return Object.entries(data as Record<string, unknown>).map(
      ([label, value]) => ({ label, value: Number(value) || 0 }),
    );
  }
  return [];
}

function isLabelValue(d: unknown): boolean {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  return (
    (typeof o.label === 'string' || typeof o.name === 'string') &&
    (typeof o.value === 'number' || typeof o.amount === 'number')
  );
}

function normalizeSuggestions(
  s: unknown,
): AnaReply['suggestions'] {
  if (!Array.isArray(s)) return null;
  const out: { label: string; intent: string }[] = [];
  for (const it of s) {
    if (!it || typeof it !== 'object') continue;
    const o = it as { label?: unknown; intent?: unknown };
    if (
      typeof o.label === 'string' &&
      typeof o.intent === 'string' &&
      o.label.trim() &&
      o.intent.trim()
    ) {
      out.push({ label: o.label.trim(), intent: o.intent.trim() });
    }
    if (out.length >= 3) break;
  }
  return out.length ? out : null;
}
