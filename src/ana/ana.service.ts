import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message,
} from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = 'amazon.nova-lite-v1:0';

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

function buildSystemPrompt(tireData: string): string {
  return `Eres Ana, analista de llantas de TirePro. Español colombiano, conciso (1-3 frases).

CONTEXTO LLANTAS:
- CPK = costo total acumulado / km totales recorridos (todas las vidas)
- CPK Proyectado = costo total / km proyectados (considerando profundidad restante hasta límite legal 2mm)
- Profundidad siempre baja (solo sube con reencauche)
- Clasificación alertas: inmediato(≤2mm) 30d(2-4mm) 60d(4-6mm) óptimo(>6mm)
- Ejes: dirección, tracción, arrastre
- Vidas: nueva, reencauche1, reencauche2, etc.
- KM llanta = KM vehículo actual - último KM registrado + KM acumulados previos

TIREDATA:
${tireData || 'No hay datos de llantas cargados.'}

RESPONDE SOLO JSON PURO (sin markdown, sin \`\`\`): {"text":"...","blocks":[...],"suggestions":[{"label":"...","intent":"..."}]}

${BLOCK_SCHEMA}

REGLAS:
- text corto (1-3 frases). NO repitas cifras que ya van en un block.
- blocks combina lo necesario. Compuestas → varios blocks.
- Si no pidieron datos (saludo, charla), blocks:[].
- Elegir formato: pie=parte/todo, bar=comparar, line=tiempo, table=lista detallada, gauge=1%, kpis=2-6 números, callout=alerta.
- Solo números del TIREDATA. NO inventes.
- suggestions opcional, máx 3.
- Saludo/identidad: preséntate como Ana de TirePro y blocks:[].
- IMPORTANTE: responde SOLO el objeto JSON, nada más.`;
}

type AnaReply = {
  text: string;
  blocks: unknown[];
  suggestions: { label: string; intent: string }[] | null;
};

@Injectable()
export class AnaService {
  private readonly client: BedrockRuntimeClient;
  private readonly log = new Logger(AnaService.name);

  constructor(private config: ConfigService) {
    this.client = new BedrockRuntimeClient({
      region: config.get<string>('AWS_REGION') || 'us-east-1',
    });
  }

  async chat(
    message: string,
    history: { role: string; text: string }[] = [],
    tireData = '',
  ): Promise<AnaReply> {
    const systemPrompt = buildSystemPrompt(tireData);

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
        maxTokens: 1200,
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

    let parsed: { text?: unknown; blocks?: unknown; suggestions?: unknown } = {};
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
}

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
