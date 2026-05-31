import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import * as XLSX from 'xlsx';
import { AiUsageService } from '../ai-usage/ai-usage.service';

/** Who is making the analyze call — for AI usage logging/quota. */
export type AiUsageContext = { companyId: string; userId?: string | null };

const MODEL_ID = 'amazon.nova-lite-v1:0';

/* ═══════════════════════════════════════════════════════════════════════════
   CANONICAL FIELD SPEC
   These are the system fields the bulk-upload pipeline understands. The values
   match the canonical targets used by HEADER_MAP_A / HEADER_MAP_B in
   tire.service.ts, so a row keyed by `field` resolves directly via getCell.
   ═══════════════════════════════════════════════════════════════════════════ */

export interface CanonicalField {
  field: string;
  label: string;        // human label (es-CO) for the UI dropdown
  description: string;  // hint given to the AI + shown in the UI
  required?: boolean;   // part of the minimum set for a usable tire
}

export const CANONICAL_FIELDS: CanonicalField[] = [
  { field: 'llanta',              label: 'Número / ID de llanta',  description: 'Identificador o serie única de la llanta (casco). Ej: "A123", "045".' },
  { field: 'placa_vehiculo',      label: 'Placa del vehículo',     description: 'Placa del vehículo donde está montada la llanta. Ej: "ABC-123".', required: true },
  { field: 'marca',               label: 'Marca',                  description: 'Fabricante de la llanta. Ej: "Michelin", "Continental".', required: true },
  { field: 'diseno_original',     label: 'Diseño / Modelo',        description: 'Diseño o modelo de la banda de rodamiento. Ej: "XZA2", "HDR2".' },
  { field: 'dimension',           label: 'Dimensión / Medida',     description: 'Medida de la llanta. Ej: "295/80R22.5", "12R22.5".', required: true },
  { field: 'eje',                 label: 'Eje / Ubicación',        description: 'Eje donde va: dirección, tracción, libre, remolque o repuesto.' },
  { field: 'posicion',            label: 'Posición',               description: 'Posición numérica de la rueda en el vehículo. Ej: 1, 2, 3.', required: true },
  { field: 'vida',                label: 'Vida / Estado',          description: 'Vida actual: nueva, reencauche1, reencauche2, reencauche3 o fin.' },
  { field: 'profundidad_int',     label: 'Profundidad interior',   description: 'Profundidad de labrado en la zona INTERIOR, en mm. Ej: 12.5', required: true },
  { field: 'profundidad_cen',     label: 'Profundidad central',    description: 'Profundidad de labrado en la zona CENTRAL, en mm.' },
  { field: 'profundidad_ext',     label: 'Profundidad exterior',   description: 'Profundidad de labrado en la zona EXTERIOR, en mm.' },
  { field: 'profundidad_inicial', label: 'Profundidad inicial (RTD)', description: 'Profundidad original de fábrica / RTD, en mm.' },
  { field: 'costo',               label: 'Costo',                  description: 'Costo de la llanta en COP. Ej: "$1.900.000".' },
  { field: 'fecha_instalacion',   label: 'Fecha de instalación',   description: 'Fecha de montaje de la llanta.' },
  { field: 'fecha_inspeccion',    label: 'Fecha de inspección',    description: 'Fecha de la última inspección / medición.' },
  { field: 'kilometros_llanta',   label: 'Kilómetros de la llanta', description: 'Km acumulados por la llanta.' },
  { field: 'kilometros_vehiculo', label: 'Kilometraje del vehículo', description: 'Odómetro / km actual del vehículo.' },
  { field: 'tipovhc',             label: 'Tipo de vehículo',       description: 'Clase de vehículo. Ej: "Tractomula", "Camión", "Buseta".' },
  { field: 'presion_psi',         label: 'Presión (PSI)',          description: 'Presión de inflado en PSI.' },
  { field: 'imageurl',            label: 'URL de imagen',          description: 'URL de una foto de la llanta (opcional).' },
  { field: 'marca_banda',         label: 'Marca de banda (reencauche)', description: 'Marca de la banda de reencauche. Solo para reencauches.' },
  { field: 'banda_name',          label: 'Banda (reencauche)',     description: 'Nombre/diseño de la banda de reencauche.' },
  { field: 'novedad',             label: 'Novedad',                description: 'Evento o novedad: "cambio", "nueva llanta", etc. Señala reemplazo.' },
  { field: 'serie',               label: 'Serie',                  description: 'Número de serie del casco (alternativo al ID de llanta).' },
];

const VALID_FIELDS = new Set(CANONICAL_FIELDS.map(f => f.field));
const REQUIRED_FIELDS = CANONICAL_FIELDS.filter(f => f.required).map(f => f.field);

export type IssueSeverity = 'error' | 'warning';

export interface MappingIssue {
  severity: IssueSeverity;
  scope: 'column' | 'row' | 'file';
  ref?: string;          // header name or row index this refers to
  message: string;       // es-CO, user facing
}

export interface MappingResult {
  /** sourceHeader -> canonicalField (or null when the AI couldn't place it) */
  mapping: Record<string, string | null>;
  confidence: number;            // 0..1 overall confidence
  issues: MappingIssue[];
  /** required canonical fields that no column maps to */
  missingRequired: string[];
  fields: CanonicalField[];      // catalog, so the UI dropdown has one source of truth
  aiUsed: boolean;               // false when the AI was unavailable and we fell back
}

/* ═══════════════════════════════════════════════════════════════════════════
   PROMPT
   ═══════════════════════════════════════════════════════════════════════════ */

function buildPrompt(headers: string[], sampleRows: Record<string, unknown>[]): string {
  const fieldList = CANONICAL_FIELDS.map(
    f => `- "${f.field}"${f.required ? ' (REQUERIDO)' : ''}: ${f.label} — ${f.description}`,
  ).join('\n');

  return `Eres un experto en datos de flotas de llantas de TirePro. Recibes las columnas de un archivo de carga masiva (Excel/CSV) con estructura DESCONOCIDA y debes mapear cada columna del archivo a un CAMPO CANÓNICO del sistema, y detectar errores en los datos.

CAMPOS CANÓNICOS DISPONIBLES (usa EXACTAMENTE estos identificadores):
${fieldList}

REGLAS DE MAPEO:
1. Para cada columna del archivo, decide a qué campo canónico corresponde. Usa el NOMBRE de la columna y los VALORES de ejemplo para decidir.
2. Si una columna no corresponde a ningún campo canónico, mapéala a null.
3. NO inventes campos. Solo usa los identificadores de la lista.
4. Dos columnas distintas NO deben mapear al mismo campo, salvo profundidades (int/cen/ext) que son campos distintos.
5. Presta atención a unidades y formatos en los valores de ejemplo (mm, PSI, fechas, moneda COP con puntos de miles).

DETECCIÓN DE ERRORES (issues): reporta problemas que veas en los datos de ejemplo:
- "error": falta una columna para un campo REQUERIDO; profundidades imposibles (negativas, >40mm); fechas inválidas; columna requerida vacía en todas las filas.
- "warning": posibles unidades equivocadas; valores fuera de rango; formato de fecha ambiguo; columnas duplicadas; valores sospechosos.

COLUMNAS DEL ARCHIVO:
${JSON.stringify(headers)}

FILAS DE EJEMPLO (primeras filas):
${JSON.stringify(sampleRows, null, 0)}

Responde ÚNICAMENTE con JSON válido, sin texto adicional, con esta forma EXACTA:
{
  "mapping": { "<nombre exacto de columna del archivo>": "<campo_canonico o null>" },
  "confidence": 0.0,
  "issues": [ { "severity": "error|warning", "scope": "column|row|file", "ref": "<columna o # fila opcional>", "message": "<mensaje claro en español>" } ]
}
El objeto "mapping" DEBE incluir TODAS las columnas del archivo como llaves.`;
}

function extractJson(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  if (t.startsWith('{')) return t;
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) return t.slice(first, last + 1);
  return t;
}

@Injectable()
export class BulkMappingService {
  private readonly client: BedrockRuntimeClient;
  private readonly log = new Logger(BulkMappingService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly aiUsage: AiUsageService,
  ) {
    this.client = new BedrockRuntimeClient({
      region: config.get<string>('AWS_REGION') || 'us-east-1',
    });
  }

  /**
   * Parse an uploaded workbook (first sheet) and analyze its columns. Returns
   * the AI mapping plus a small preview the UI can render. Never throws.
   */
  async analyzeWorkbook(
    buffer: Buffer,
    ctx?: AiUsageContext,
  ): Promise<MappingResult & { headers: string[]; sampleRows: Record<string, string>[]; totalRows: number }> {
    let rows: Record<string, string>[] = [];
    try {
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = sheet ? XLSX.utils.sheet_to_json(sheet, { raw: false, defval: '' }) : [];
    } catch (err) {
      this.log.error('Bulk mapping: could not parse workbook', (err as Error).message);
    }

    const headers = rows.length ? Object.keys(rows[0]) : [];
    const sampleRows = rows.slice(0, 8);
    const result = await this.analyzeFile(headers, rows.slice(0, 15), ctx);
    return { ...result, headers, sampleRows, totalRows: rows.length };
  }

  /**
   * Ask the AI to map arbitrary file headers to canonical fields and flag
   * data errors. Never throws — on any failure it returns an empty mapping
   * (mapping all headers to null) so the caller can fall back to the
   * pipeline's own fuzzy matching.
   */
  async analyzeFile(
    headers: string[],
    sampleRows: Record<string, unknown>[],
    ctx?: AiUsageContext,
  ): Promise<MappingResult> {
    const cleanHeaders = headers.filter(h => h != null && String(h).trim() !== '');

    if (cleanHeaders.length === 0) {
      return {
        mapping: {},
        confidence: 0,
        issues: [{ severity: 'error', scope: 'file', message: 'El archivo no tiene columnas legibles.' }],
        missingRequired: REQUIRED_FIELDS,
        fields: CANONICAL_FIELDS,
        aiUsed: false,
      };
    }

    let raw = '';
    try {
      const command = new ConverseCommand({
        modelId: MODEL_ID,
        messages: [{ role: 'user', content: [{ text: buildPrompt(cleanHeaders, sampleRows.slice(0, 15)) }] }],
        inferenceConfig: { temperature: 0, maxTokens: 2000 },
      });
      const res = await this.client.send(command);
      raw = res.output?.message?.content?.[0]?.text ?? '';
      if (ctx?.companyId) {
        await this.aiUsage.record({
          companyId: ctx.companyId,
          userId: ctx.userId,
          feature: 'bulk_analyze',
          model: MODEL_ID,
          inputTokens: res.usage?.inputTokens ?? 0,
          outputTokens: res.usage?.outputTokens ?? 0,
        });
      }
    } catch (err) {
      this.log.error('Bedrock mapping call failed', (err as Error).message);
      return this.fallback(cleanHeaders, 'La asistencia de IA no está disponible; revisa el mapeo manualmente.');
    }

    let parsed: { mapping?: unknown; confidence?: unknown; issues?: unknown };
    try {
      parsed = JSON.parse(extractJson(raw));
    } catch {
      this.log.warn('Bulk mapping: could not parse AI JSON');
      return this.fallback(cleanHeaders, 'No se pudo interpretar la respuesta de la IA; revisa el mapeo manualmente.');
    }

    return this.normalize(parsed, cleanHeaders);
  }

  /** Validate + clamp the raw AI output into a safe MappingResult. */
  private normalize(
    parsed: { mapping?: unknown; confidence?: unknown; issues?: unknown },
    headers: string[],
  ): MappingResult {
    const mapping: Record<string, string | null> = {};
    const usedFields = new Set<string>();
    const rawMap = (parsed.mapping ?? {}) as Record<string, unknown>;

    for (const h of headers) {
      const target = rawMap[h];
      if (typeof target === 'string' && VALID_FIELDS.has(target)) {
        // Avoid two columns claiming the same single-value field (depths excepted)
        const isDepth = target.startsWith('profundidad_');
        if (!isDepth && usedFields.has(target)) {
          mapping[h] = null;
        } else {
          mapping[h] = target;
          usedFields.add(target);
        }
      } else {
        mapping[h] = null;
      }
    }

    const issues: MappingIssue[] = Array.isArray(parsed.issues)
      ? (parsed.issues as unknown[])
          .map(raw => {
            const i = raw as Record<string, unknown>;
            const severity: IssueSeverity = i.severity === 'error' ? 'error' : 'warning';
            const scope = i.scope === 'row' || i.scope === 'file' ? i.scope : 'column';
            const message = typeof i.message === 'string' ? i.message.trim() : '';
            if (!message) return null;
            return { severity, scope, ref: typeof i.ref === 'string' ? i.ref : undefined, message } as MappingIssue;
          })
          .filter((x): x is MappingIssue => x !== null)
      : [];

    const missingRequired = REQUIRED_FIELDS.filter(f => !usedFields.has(f));
    for (const f of missingRequired) {
      const label = CANONICAL_FIELDS.find(c => c.field === f)?.label ?? f;
      if (!issues.some(i => i.ref === f)) {
        issues.push({
          severity: 'error',
          scope: 'file',
          ref: f,
          message: `No se encontró ninguna columna para el campo requerido "${label}".`,
        });
      }
    }

    let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
    confidence = Math.max(0, Math.min(1, confidence));

    return { mapping, confidence, issues, missingRequired, fields: CANONICAL_FIELDS, aiUsed: true };
  }

  private fallback(headers: string[], message: string): MappingResult {
    const mapping: Record<string, string | null> = {};
    for (const h of headers) mapping[h] = null;
    return {
      mapping,
      confidence: 0,
      issues: [{ severity: 'warning', scope: 'file', message }],
      missingRequired: REQUIRED_FIELDS,
      fields: CANONICAL_FIELDS,
      aiUsed: false,
    };
  }
}
