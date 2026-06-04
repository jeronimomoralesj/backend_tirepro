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
import { AiUsageService } from '../ai-usage/ai-usage.service';

const MODEL_ID = 'amazon.nova-lite-v1:0';
const DATASET_TTL_MS = 300_000; // cache fleet data for 5 min

/* ═══════════════════════════════════════════════════════════════════════════
   SYSTEM PROMPT
   ═══════════════════════════════════════════════════════════════════════════ */

const BLOCK_SCHEMA = `Bloques disponibles (copia la forma EXACTA):
- {"kind":"kpis","title":"Resumen","items":[{"label":"Total","value":"245","hint":"+3%","tone":"good"}]}
- {"kind":"bar","title":"CPK por marca","unit":"$/km","data":[{"label":"Michelin","value":42},{"label":"Continental","value":48}]}
- {"kind":"line","title":"CPK 6 meses","unit":"$/km","data":[{"label":"Ene","value":45},{"label":"Feb","value":42}]}
- {"kind":"area","title":"Profundidad promedio 6 meses","unit":"mm","data":[{"label":"Ene","value":12},{"label":"Feb","value":11.2}]}
- {"kind":"pie","title":"Mix marcas","data":[{"label":"Continental","value":48},{"label":"Michelin","value":32}]}
- {"kind":"scatter","title":"CPK vs Km recorridos","xLabel":"Km","yLabel":"CPK","xUnit":"km","yUnit":"$/km","data":[{"x":50000,"y":42,"label":"Michelin"},{"x":35000,"y":55,"label":"Continental"}]}
- {"kind":"radar","title":"Salud por eje","data":[{"label":"Direccion","value":85},{"label":"Traccion","value":62},{"label":"Libre","value":90}]}
- {"kind":"table","title":"Criticas","columns":["Placa","Posicion","Profundidad","Plazo"],"rows":[["ABC-123","Dir.Izq","2.1mm","Inmediato"]]}
- {"kind":"gauge","title":"Salud flota","value":78,"label":"4 criticas"}
- {"kind":"callout","tone":"warn","text":"3 llantas requieren cambio inmediato."}

PROHIBIDO: campos "keys","values","labels","colors" como arrays sueltos. Datos SIEMPRE en "data" (o "items" para kpis, "rows" para table).
OBLIGATORIO en bar/line/area: "title" debe describir que se mide. "unit" SIEMPRE presente — indica la unidad del eje Y (ej: "$/km", "mm", "llantas", "%", "$COP").
OBLIGATORIO en scatter: "xLabel" y "yLabel" para los ejes, "xUnit"/"yUnit" para unidades. "data" usa campos "x","y" (numeros) y "label" opcional.
OBLIGATORIO en radar: "data" con "label" y "value". Opcional "fullMark" para el maximo de cada eje.
OBLIGATORIO en pie: "title" describe la distribucion.
OBLIGATORIO: todo grafico debe tener "title" descriptivo y "unit" cuando aplique.
orientation en bar: "vertical"|"horizontal". tone: good|warn|bad|info|neutral.`;

function buildSystemPrompt(dataset: string): string {
  return `Eres Ana, analista experta de llantas de TirePro. Español colombiano, profesional y concisa.

REGLA #0 — ACCIONES Y CIERRE:
- NUNCA le digas al usuario que vaya a otra pantalla, dashboard, o interfaz para ver datos. TÚ eres la que responde con los datos. Si tienes los datos en TIREDATA, úsalos directamente.
- Si preguntan sobre inspecciones recientes, CONSULTA la sección INSPECCIONES de TIREDATA y responde con los datos reales.
- Si piden HACER/REGISTRAR una inspección: responde con entusiasmo ("¡Vamos a inspeccionar!"). El sistema mostrará el formulario automáticamente.
- Si piden SUBIR un archivo/Excel de llantas: responde con entusiasmo. El sistema mostrará el formulario de carga.
- Si piden ROTAR/MOVER llantas: responde con entusiasmo. El sistema mostrará el panel de rotación.
- NUNCA digas "ve a la app", "usa los botones", o "hazlo desde la interfaz" — TÚ puedes iniciar estas acciones.
- SIEMPRE termina tu "text" con "\\n\\n¿Puedo ayudarte con algo más?" o variación natural.
- NUNCA finjas crear o modificar datos de llantas/vehículos.
- Si piden CREAR flujos de automatización: responde SOLO "Procesando..." en "text". El sistema ejecuta la acción y reemplaza tu texto.
- Si PREGUNTAN qué hay en su calendario, qué eventos tienen, o consultas de lectura: responde normalmente. El sistema agregará los datos reales.

REGLA CALENDARIO — CREAR EVENTOS:
- NUNCA digas "Procesando..." para eventos de calendario.
- El sistema mostrará automáticamente una tarjeta de confirmación con los detalles del evento. No necesitas confirmar nada tú.
- Si el usuario quiere crear un evento pero NO ha dado fecha u hora, pregúntale los detalles que falten.
- Si el usuario ya dio fecha y hora, responde brevemente (ej: "¡Perfecto, aquí van los detalles!"). El sistema agrega la tarjeta.

REGLA #1 — CONSISTENCIA:
- SOLO números EXACTOS de TIREDATA. NUNCA inventes ni redondees.
- Conteos entre blocks deben coincidir exactamente con TIREDATA.

REGLA #2 — SIEMPRE BLOCKS Y SUGGESTIONS:
- Toda respuesta con datos DEBE incluir blocks. Sin blocks cuando hay datos = INCORRECTO.
- suggestions OBLIGATORIO (3 análisis relacionados). Solo omitir en saludos puros.
- Saludo sin datos → blocks:[], suggestions con 3 opciones de análisis.

REGLA #3 — VISUALIZACIÓN INTELIGENTE:
Analiza la INTENCIÓN del usuario y elige blocks:

VALOR PUNTUAL ("¿cuál es el CPK?", "¿cuántas?", "promedio"):
→ kpis con número destacado. Si hay desglose por categoría, agregar bar debajo.

MÁS DETALLES / PROFUNDIZAR ("ver más", "detalle", "desglose", "profundizar"):
→ table detallada + gráfico complementario. NUNCA solo texto.

TABLA ESPECÍFICA ("muéstrame en tabla", "tabla con", "detállame"):
→ OBLIGATORIO generar un block table. Usa las columnas que el usuario pide. Rellena rows con datos EXACTOS de TIREDATA. Si pide "vehículo, posición, profundidad" → columns:["Vehículo","Posición","Profundidad"], rows con datos reales. NUNCA ignores un pedido de tabla.

COMPARACIÓN ("por marca", "por eje", "X vs Y"):
→ kpis resumen arriba + bar chart comparativo.

CORRELACIÓN ("CPK vs km", "relación entre", "costo vs uso"):
→ scatter chart con xLabel/yLabel descriptivos. Ideal para ver relación entre dos variables numéricas.

DISTRIBUCIÓN ("mix", "proporción", "composición"):
→ pie chart + kpis con total.

PERFIL MULTIDIMENSIONAL ("salud por eje", "estado por categoría", "comparar dimensiones"):
→ radar chart. Ideal para comparar múltiples métricas en una sola vista (ej: salud por eje, rendimiento por marca en varias métricas).

TENDENCIA ("evolución", "histórico", "últimos meses"):
→ area chart si es una sola serie con tendencia suave. line chart si hay puntos discretos importantes. Ambos + kpis resumen.

ALERTAS ("críticas", "cambio inmediato", "urgente"):
→ callout alerta + table listado detallado con columnas: Vehículo, Posición, Profundidad, Marca, Diseño.

RESUMEN ("resumen", "estado general", "cómo está"):
→ kpis (3-5 métricas) + gauge salud + radar por ejes + callout si hay alertas.

CLAVE: pregunta sobre UN número → kpis (NO gráfico solo para un dato).
CLAVE: usa scatter SOLO cuando ambos ejes son numéricos (no categorías). Para categorías usa bar.

CONTEXTO TÉCNICO:
- CPK = CPK PROYECTADO por defecto (costo total / km proyectados al límite legal de 2mm). Menor = mejor.
- TODOS los valores de CPK en TIREDATA YA están proyectados — úsalos tal cual, NO los recalcules.
- Usa SIEMPRE el CPK proyectado. SOLO usa el "CPK actual/real" si el usuario lo pide EXPLÍCITAMENTE (ej: "CPK actual", "CPK real", "CPK a hoy"); en ese caso usa la línea "CPK FLOTA (actual/real)".
- Al mostrar CPK no necesitas aclarar "proyectado" — es el valor estándar.
- Profundidad: límite legal 2mm.
- Alertas: inmediato(≤2mm) 30d(2-4mm) 60d(4-6mm) óptimo(>6mm)
- "Críticas" = SOLO inmediato (≤2mm).
- Ejes: direccion, traccion, libre, remolque, repuesto
- Vidas: nueva, reencauche1/2/3, fin
- Health score: 0-100

TIREDATA:
${dataset}

FORMATO: responde SOLO JSON puro (sin markdown, sin \`\`\`):
{"text":"...","blocks":[...],"suggestions":[{"label":"...","intent":"..."}]}

${BLOCK_SCHEMA}

REGLAS DE FORMATO:
- text: 1-3 frases con insight + cierre. NO repitas cifras de blocks.
- suggestions: OBLIGATORIO 3, relacionados al tema. label corto, intent la pregunta completa.
- bar: orientation "horizontal" si >4 categorías.
- gauge: "value" 0-100, "label" con contexto.
- Reportes completos: combinar 3-5 blocks (kpis + gráfico + tabla).
- Saludo → blocks:[], suggestions con opciones iniciales.
- IMPORTANTE: responde SOLO el JSON, nada más.`;
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
    private readonly aiUsage: AiUsageService,
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
    userId?: string,
  ): Promise<AnaReply> {
    let dataset: string;
    if (companyId) {
      dataset = await this.getFleetDataset(companyId);
    } else {
      dataset = tireDataFallback || 'No hay datos de llantas cargados.';
    }

    const systemPrompt = buildSystemPrompt(dataset);

    const messages: Message[] = [];
    for (const m of history.slice(-6)) {
      if (!m?.text) continue;
      messages.push({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: [{ text: m.text }],
      });
    }
    messages.push({ role: 'user', content: [{ text: message }] });

    // Nova-lite frequently replies in prose instead of the required JSON, which
    // makes JSON.parse fail and silently drops every block/suggestion. Prefilling
    // the assistant turn with "{" forces the model to start a JSON object — the
    // single biggest reliability win for getting tables/graphs back. If the model
    // ever rejects the trailing assistant turn, we retry once without the prefill.
    const send = (withPrefill: boolean) => {
      const msgs: Message[] = withPrefill
        ? [...messages, { role: 'assistant', content: [{ text: '{' }] }]
        : messages;
      return this.client.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: systemPrompt }],
          messages: msgs,
          // maxTokens bumped from 1500 → 4000: a full report (kpis + chart +
          // a 15-row table) easily exceeds 1500 tokens, and truncation produces
          // invalid JSON that parses to an empty-blocks fallback.
          inferenceConfig: { temperature: 0.4, maxTokens: 4000 },
        }),
      );
    };

    let raw: string;
    let usedPrefill = true;
    try {
      let res;
      try {
        res = await send(true);
      } catch (prefillErr) {
        this.log.warn(
          `Bedrock prefill call failed, retrying without prefill: ${(prefillErr as Error).message}`,
        );
        usedPrefill = false;
        res = await send(false);
      }
      raw = res.output?.message?.content?.[0]?.text ?? '';
      // Log the call + token usage (this also increments the request quota).
      await this.aiUsage.record({
        companyId,
        userId,
        feature: 'chat',
        model: MODEL_ID,
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
      });
    } catch (err) {
      this.log.error('Bedrock call failed', (err as Error).message);
      throw err;
    }

    // When the model honors the prefill it continues *after* the "{", so its
    // output starts with the first key (e.g. `"text":`). Re-attach the brace
    // before parsing. If it returned a full object anyway, leave it untouched.
    let jsonText = raw.trim();
    if (usedPrefill && !jsonText.startsWith('{') && !jsonText.startsWith('```')) {
      jsonText = '{' + jsonText;
    }

    let parsed: { text?: unknown; blocks?: unknown; suggestions?: unknown } =
      {};
    try {
      parsed = JSON.parse(extractJson(jsonText));
    } catch {
      // Surface the raw output so prod logs reveal *why* parsing failed instead
      // of silently degrading to a no-blocks, fallback-suggestions reply.
      this.log.warn(`Ana JSON parse failed. Raw output: ${raw.slice(0, 600)}`);
      parsed = { text: salvageText(raw) };
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

  async getFleetDataset(companyId: string): Promise<string> {
    const cacheKey = `ana:dataset:${companyId}`;
    const cached = await this.cache.get<string>(cacheKey);
    if (cached) return cached;

    const dataset = await this.buildFleetDataset(companyId);
    await this.cache.set(cacheKey, dataset, DATASET_TTL_MS);
    return dataset;
  }

  private async buildFleetDataset(companyId: string): Promise<string> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);
    const sevenDaysAgo = new Date(today.getTime() - 7 * 86_400_000);

    const [
      tires,
      vehicles,
      recentSnapshots,
      benchmarks,
      costBreakdown,
      todayInspections,
      recentInspections,
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
          // Latest inspection carries the projected CPK (cost / projected-km-to-2mm),
          // which is the default CPK Ana should report. There is no cpkProyectado
          // column on Tire — it lives only on Inspeccion.
          inspecciones: {
            select: { cpkProyectado: true },
            orderBy: { fecha: 'desc' },
            take: 1,
          },
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
      this.prisma.inspeccion.findMany({
        where: { tire: { companyId }, fecha: { gte: today, lte: todayEnd } },
        select: {
          id: true,
          fecha: true,
          profundidadInt: true,
          tire: { select: { marca: true, diseno: true, posicion: true, vehicle: { select: { placa: true } } } },
          inspeccionadoPorNombre: true,
          source: true,
        },
        orderBy: { fecha: 'desc' },
        take: 50,
      }),
      this.prisma.inspeccion.findMany({
        where: { tire: { companyId }, fecha: { gte: sevenDaysAgo, lt: today } },
        select: {
          id: true,
          fecha: true,
          profundidadInt: true,
          tire: { select: { marca: true, diseno: true, posicion: true, vehicle: { select: { placa: true } } } },
          inspeccionadoPorNombre: true,
        },
        orderBy: { fecha: 'desc' },
        take: 30,
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

    // CPK reported to Ana defaults to the PROJECTED CPK (latest inspection's
    // cpkProyectado), falling back to lifetime/current CPK only when no
    // projection exists. Projected CPK amortizes cost over the tire's full
    // expected life, so it's lower and more representative than the actual CPK,
    // which runs high for tires that haven't covered many km yet.
    const cpkOf = (t: {
      inspecciones?: { cpkProyectado: number | null }[];
      lifetimeCpk: number | null;
      currentCpk: number | null;
    }): number | null => {
      const proy = t.inspecciones?.[0]?.cpkProyectado;
      if (proy != null && proy > 0) return proy;
      const fallback = t.lifetimeCpk ?? t.currentCpk;
      return fallback != null && fallback > 0 ? fallback : null;
    };

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
    // Default CPK = average projected CPK across tires. The actual/real CPK
    // (cost / km driven) is kept as a secondary line for when the user asks
    // for it explicitly.
    const projCpks = tires
      .map((t) => cpkOf(t))
      .filter((v): v is number => v != null);
    if (projCpks.length)
      L.push(
        `CPK FLOTA (proyectado, por defecto): $${(projCpks.reduce((a, b) => a + b, 0) / projCpks.length).toFixed(1)}/km`,
      );
    if (totalKm > 0 && totalCost > 0)
      L.push(`CPK FLOTA (actual/real, solo si lo piden): $${(totalCost / totalKm).toFixed(1)}/km`);

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
      const cpk = cpkOf(t);
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
      const cpk = cpkOf(t);
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
      const cpk = cpkOf(t);
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
      const cpk = cpkOf(t);
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
      .slice(0, 15);
    if (criticals.length) {
      L.push(`\nCRÍTICAS(${criticals.length}/${alertInm + alert30}):`);
      L.push('Vehículo|Llanta|Prof|Eje|CPK|Salud|EOL');
      for (const t of criticals) {
        const cpk = cpkOf(t);
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
      const cpk = cpkOf(t);
      if (cpk != null && cpk > 0) {
        vehMap[p].cpkSum += cpk;
        vehMap[p].cpkCount++;
      }
    }
    const topVehicles = Object.values(vehMap)
      .sort((a, b) => b.critCount - a.critCount || b.tireCount - a.tireCount)
      .slice(0, 10);
    if (topVehicles.length) {
      L.push(`\nVEHÍCULOS(top10):`);
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
      for (const b of relevantBenchmarks.slice(0, 10)) {
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

    // ── Inspections ──
    const todayDateStr = today.toISOString().slice(0, 10);
    if (todayInspections.length) {
      L.push(`\nINSPECCIONES HOY (${todayDateStr}): ${todayInspections.length} registros`);
      L.push('Vehículo|Llanta|Posición|Profundidad|Inspector|Hora');
      for (const ins of todayInspections) {
        const hora = new Date(ins.fecha).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        L.push(
          `${ins.tire?.vehicle?.placa || '?'}|${ins.tire?.marca || '?'} ${ins.tire?.diseno || ''}|${ins.tire?.posicion || '?'}|${ins.profundidadInt != null ? `${ins.profundidadInt}mm` : '-'}|${ins.inspeccionadoPorNombre || ins.source || '-'}|${hora}`,
        );
      }
    } else {
      L.push(`\nINSPECCIONES HOY (${todayDateStr}): 0 — No hay inspecciones registradas hoy.`);
    }

    if (recentInspections.length) {
      L.push(`\nINSPECCIONES ÚLTIMOS 7 DÍAS: ${recentInspections.length} registros`);
      L.push('Fecha|Vehículo|Llanta|Profundidad|Inspector');
      for (const ins of recentInspections.slice(0, 15)) {
        const fechaStr = new Date(ins.fecha).toISOString().slice(0, 10);
        L.push(
          `${fechaStr}|${ins.tire?.vehicle?.placa || '?'}|${ins.tire?.marca || '?'} ${ins.tire?.diseno || ''}|${ins.profundidadInt != null ? `${ins.profundidadInt}mm` : '-'}|${ins.inspeccionadoPorNombre || '-'}`,
        );
      }
    }

    const result = L.join('\n');
    this.log.debug(`Fleet dataset for ${companyId}: ${result.length} chars`);
    return result;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS — JSON normalization (same logic as the old route.ts)
   ═══════════════════════════════════════════════════════════════════════════ */

// When JSON parsing fails entirely, pull a clean user-facing message out of the
// raw output instead of dumping JSON fragments into the chat bubble.
function salvageText(raw: string): string {
  const m = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return m[1];
    }
  }
  const t = raw.trim();
  // Pure prose (no JSON braces) is a fine answer; JSON-ish junk is not.
  return t && !t.includes('{') ? t : 'Entendido.';
}

function extractJson(s: string): string {
  let t = s.trim();
  // Strip markdown code fences
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Slice from the first { to the last } — this strips both leading prose and
  // any trailing text the model appends after the JSON object (which would
  // otherwise break JSON.parse even when the output starts with "{").
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return t.slice(first, last + 1);
  }
  return t;
}

const ALLOWED_KINDS = new Set([
  'kpis', 'bar', 'line', 'area', 'pie', 'scatter', 'radar', 'table', 'gauge', 'callout',
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

  if (kind === 'bar' || kind === 'line' || kind === 'pie' || kind === 'area') {
    out.data = coerceXY(out.data, out);
    if (!Array.isArray(out.data) || out.data.length === 0) return null;
  } else if (kind === 'scatter') {
    if (!Array.isArray(out.data) || out.data.length === 0) return null;
    out.data = (out.data as Record<string, unknown>[]).filter(
      (d) => typeof d.x === 'number' && typeof d.y === 'number',
    );
    if ((out.data as unknown[]).length === 0) return null;
  } else if (kind === 'radar') {
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
    // Model sometimes sends columns as `data` with {label,value} pairs
    if (!Array.isArray(out.columns) && Array.isArray(out.data)) {
      const d = out.data as { label?: string }[];
      if (d.length > 0 && typeof d[0]?.label === 'string') {
        out.columns = d.map((item) => String(item.label || ''));
      }
    }
    if (!Array.isArray(out.columns) || !Array.isArray(out.rows)) return null;
    // Model sometimes sends rows as objects ({Placa:"ABC",Prof:"2mm"}) instead
    // of arrays. The frontend only renders array rows, so coerce them by column.
    const cols = out.columns as string[];
    out.rows = (out.rows as unknown[]).map((r) => {
      if (Array.isArray(r)) return r;
      if (r && typeof r === 'object') {
        const obj = r as Record<string, unknown>;
        return cols.map((c) => obj[c] ?? '');
      }
      return [r];
    });
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
  // Normalize {label|name, value|amount} entries — including numeric strings
  // like "42" which the model often emits and which would otherwise drop the
  // whole chart block (recharts needs real numbers).
  if (Array.isArray(data) && data.length > 0 && data.every(isLabelValue)) {
    return data.map((d) => {
      const o = d as Record<string, unknown>;
      return {
        ...o,
        label: String(o.label ?? o.name ?? ''),
        value: toNum(o.value ?? o.amount),
      };
    });
  }
  const keys = (container.keys ?? container.labels ?? container.categories) as unknown;
  const values = (container.values ?? container.amounts ?? container.counts) as unknown;
  if (Array.isArray(keys) && Array.isArray(values)) {
    return keys.map((k, i) => ({
      label: String(k),
      value: toNum((values as unknown[])[i]),
    }));
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return Object.entries(data as Record<string, unknown>).map(
      ([label, value]) => ({ label, value: toNum(value) }),
    );
  }
  return [];
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    // Tolerate "42", "$48", "1,234", "12.5mm" etc.
    const n = Number(v.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isLabelValue(d: unknown): boolean {
  if (!d || typeof d !== 'object') return false;
  const o = d as Record<string, unknown>;
  const hasLabel = typeof o.label === 'string' || typeof o.name === 'string';
  const hasValue =
    typeof o.value === 'number' ||
    typeof o.amount === 'number' ||
    (typeof o.value === 'string' && o.value.trim() !== '') ||
    (typeof o.amount === 'string' && o.amount.trim() !== '');
  return hasLabel && hasValue;
}

const FALLBACK_SUGGESTIONS: { label: string; intent: string }[] = [
  { label: 'Resumen de flota', intent: 'Dame un resumen general de mi flota.' },
  { label: 'Llantas críticas', intent: '¿Qué llantas necesitan cambio inmediato?' },
  { label: 'CPK por marca', intent: '¿Cuál es el CPK promedio por marca?' },
];

function normalizeSuggestions(
  s: unknown,
): AnaReply['suggestions'] {
  if (!Array.isArray(s)) return FALLBACK_SUGGESTIONS;
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
  return out.length ? out : FALLBACK_SUGGESTIONS;
}
