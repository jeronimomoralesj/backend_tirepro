import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';

const MODEL_ID = 'amazon.nova-lite-v1:0';

/* ═══════════════════════════════════════════════════════════════════════════
   SYSTEM PROMPT — teaches the model how to map Spanish descriptions
   into structured automation-flow configs.
   ═══════════════════════════════════════════════════════════════════════════ */

const SYSTEM_PROMPT = `Eres un asistente de TirePro que convierte descripciones en español de automatizaciones de flota en configuraciones JSON estructuradas.

TIPOS DE TRIGGER disponibles:
1. "tire_alert_level" — Se dispara cuando una llanta cambia a cierto nivel de alerta.
   triggerConfig: { "alertLevels": ["critical" | "warning" | "watch" | "ok"] }
   - "cambio inmediato" o "critica" → "critical". "30 dias" → "warning". "60 dias" → "watch". "optimo" → "ok".

2. "tire_depth_threshold" — Se dispara cuando la profundidad de una llanta cae por debajo de un umbral.
   triggerConfig: { "thresholdMm": <número en milímetros, SIEMPRE decimal, ej: 1.3, 2.0, 4.5. NUNCA multiplicar por 1000> }
   - "1.3mm" → thresholdMm: 1.3 (NO 1300). "2mm" → thresholdMm: 2.0. Las profundidades de llantas van de 0 a ~15mm.

3. "scheduled_cron" — Se dispara según un horario cron.
   triggerConfig: { "cron": "<expresión cron>", "timezone": "America/Bogota" }

4. "tire_eol_approaching" — Se dispara cuando la llanta se acerca al fin de vida.
   triggerConfig: { "daysThreshold": <número de días> }

5. "inspection_completed" — Se dispara cuando se completa una inspección.
   triggerConfig: { "alertLevelFilter": ["critical" | "warning" | "watch" | "ok"] } (opcional, vacío = todas)

TIPOS DE ACCIÓN disponibles:
1. "send_email" — Envía un correo electrónico.
   actionConfig: { "to": "<correo>", "subject": "Alerta: {{tireMarca}} {{tireDiseno}}", "body": "<cuerpo del email con variables de plantilla, opcional>" }
   - Si el usuario describe qué quiere que diga el email, genera el "body" con ese contenido usando las variables de plantilla.
   - Si no menciona el contenido, omite "body" y se usará la plantilla por defecto con datos de la llanta.

2. "send_whatsapp" — Envía un mensaje de WhatsApp.
   actionConfig: { "to": "<número con código de país, ej: +57...>" }

3. "create_calendar_event" — Crea un evento en Google Calendar.
   actionConfig: { "summary": "<título>", "description": "<descripción>", "durationMinutes": <número>, "delayDays": <días después del trigger, default 0>, "startHour": <hora 0-23, default 9>, "startMinute": <minuto 0-59, default 0> }
   - "para el siguiente día" → delayDays: 1. "en 3 días" → delayDays: 3. Sin mención → delayDays: 0.
   - "a las 7am" → startHour: 7. "a las 2:30pm" → startHour: 14, startMinute: 30. "a las 10am" → startHour: 10. Sin mención → startHour: 9.
   - En "description", incluye variables de plantilla: "Llanta {{tireMarca}} {{tireDiseno}} en vehículo {{vehiclePlaca}} — profundidad: {{tireDepth}}mm"

4. "make_phone_call" — Realiza una llamada telefónica.
   actionConfig: { "to": "<número>", "message": "<mensaje de voz>" }

5. "create_notification" — Crea una notificación interna en TirePro.
   actionConfig: { "priority": 1 | 2 | 3 }
   (1=info, 2=warning, 3=critical)

Variables de plantilla disponibles para subject/message: {{vehiclePlaca}}, {{tirePlaca}}, {{tireMarca}}, {{tireDiseno}}, {{tireDepth}}, {{tireAlertLevel}}, {{date}}, {{companyName}}.

REGLAS:
- Responde SOLO con JSON puro (sin markdown, sin \`\`\`).
- Si la solicitud ES posible con los triggers y acciones disponibles, usa esta estructura:
{
  "name": "<nombre corto descriptivo del flujo>",
  "triggerType": "<uno de los tipos de trigger>",
  "triggerConfig": { ... },
  "actionType": "<uno de los tipos de acción>",
  "actionConfig": { ... },
  "explanation": "<explicación breve en español de lo que hace el flujo>"
}
- Si la solicitud NO es posible (pide algo que no existe en los triggers/acciones, o es ambigua/sin sentido, o pide algo fuera del alcance como "comprar llantas", "modificar datos", "enviar SMS", "conectar con SAP", "llanta sin inspección por X días", "si el conductor no reporta", etc.), responde con:
{
  "impossible": true,
  "reason": "<explicación clara y amigable en español de POR QUÉ no es posible y QUÉ alternativas sí están disponibles>"
}
EJEMPLOS de triggers IMPOSIBLES: "cuando una llanta lleve X días sin inspección" (no existe ese trigger), "cuando el conductor no reporte" (no existe), "cuando baje la temperatura" (no existe), "cuando suba el precio" (no existe). Solo existen los 5 triggers listados arriba.

- Si la solicitud es AMBIGUA o necesitas más detalles para generar un buen flujo, responde con:
{
  "clarification": true,
  "question": "<pregunta específica en español para aclarar lo que necesitas>"
}
Ejemplo: si el usuario dice "alerta cuando haya un problema", pregunta qué tipo de problema (profundidad baja, alerta crítica, fin de vida, etc.).
- Elige el trigger y acción que mejor se ajusten a la descripción del usuario.
- Si la descripción no menciona un destinatario específico, usa placeholders descriptivos como "jefe@empresa.com" o "+573001234567".
- Si mencionan "cambio inmediato" o "critica", usa trigger "tire_alert_level" con alertLevels ["critical"].
- Si mencionan "profundidad menor a X mm", usa trigger "tire_depth_threshold".
- Si mencionan un horario (diario, semanal, etc.), usa trigger "scheduled_cron".
- Si mencionan "fin de vida" o "por acabarse", usa trigger "tire_eol_approaching".
- Si mencionan "inspección", usa trigger "inspection_completed".
- Si recibes un FLUJO ACTUAL junto con la solicitud, es una MODIFICACION. CONSERVA el trigger y la accion actuales y SOLO cambia lo que el usuario pide explicitamente. Si dice "cambia la hora a las 10am", SOLO modifica startHour en actionConfig, NO cambies el triggerType ni triggerConfig.
- IMPORTANTE: responde SOLO el JSON, nada mas.`;

/* ═══════════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════════ */

export interface AiFlowSuggestion {
  name: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  actionType: string;
  actionConfig: Record<string, unknown>;
  explanation: string;
  impossible?: boolean;
  reason?: string;
  clarification?: boolean;
  question?: string;
}

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICE
   ═══════════════════════════════════════════════════════════════════════════ */

@Injectable()
export class AiFlowBuilderService {
  private readonly client: BedrockRuntimeClient;
  private readonly log = new Logger(AiFlowBuilderService.name);

  private static readonly VALID_TRIGGERS = new Set([
    'tire_alert_level',
    'tire_depth_threshold',
    'scheduled_cron',
    'tire_eol_approaching',
    'inspection_completed',
  ]);

  private static readonly VALID_ACTIONS = new Set([
    'send_email',
    'send_whatsapp',
    'create_calendar_event',
    'make_phone_call',
    'create_notification',
  ]);

  constructor(private readonly config: ConfigService) {
    this.client = new BedrockRuntimeClient({
      region: config.get<string>('AWS_REGION') || 'us-east-1',
    });
  }

  async buildFlow(description: string, currentFlow?: Record<string, unknown>): Promise<AiFlowSuggestion> {
    const userMessage = currentFlow
      ? `FLUJO ACTUAL (solo modifica lo que el usuario pide, CONSERVA todo lo demas):\n${JSON.stringify(currentFlow, null, 2)}\n\nSOLICITUD DEL USUARIO: ${description}`
      : description;

    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [
        { role: 'user', content: [{ text: userMessage }] },
      ],
      inferenceConfig: {
        temperature: 0.3,
        maxTokens: 800,
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

    const parsed = this.parseResponse(raw);
    if (parsed.impossible || parsed.clarification) return parsed;
    this.validate(parsed);
    return parsed;
  }

  async buildReportBlocks(description: string, currentBlocks?: unknown[]): Promise<Record<string, unknown>> {
    const prompt = `Eres un asistente que genera secciones de reportes de email para una plataforma de gestion de llantas (TirePro).

El usuario describe que quiere ver en un reporte por email. Tu generas una lista de "blocks" que representan secciones del reporte.

TIPOS DE BLOCKS disponibles:
- {"kind":"table","title":"<titulo>","description":"<que datos incluir, ej: columnas Vehiculo, Marca, Profundidad, Alerta>"}
- {"kind":"kpis","title":"<titulo>","description":"<que metricas mostrar, ej: Total llantas, CPK promedio, Llantas criticas>"}
- {"kind":"bar","title":"<titulo>","description":"<que comparar, ej: CPK por marca, Llantas por eje>"}
- {"kind":"pie","title":"<titulo>","description":"<que distribucion mostrar, ej: Alertas por nivel, Llantas por vida>"}
- {"kind":"line","title":"<titulo>","description":"<que tendencia, ej: CPK ultimos 6 meses>"}
- {"kind":"gauge","title":"<titulo>","description":"<que indicador, ej: Salud general de flota>"}
- {"kind":"callout","title":"<titulo>","description":"<que alerta o mensaje destacado>"}

CONTEXTO TECNICO:
- CPK = costo por kilometro. Menor = mejor.
- Alertas: critical (cambio inmediato, <=2mm), warning (30 dias, 2-4mm), watch (60 dias, 4-6mm), ok (>6mm)
- Ejes: direccion, traccion, libre, remolque
- Vidas: nueva, reencauche1/2/3

REGLAS:
- Responde SOLO JSON: {"blocks":[...],"subject":"<asunto sugerido para el email>"}
- Cada block debe tener kind, title, description
- Si la solicitud no tiene sentido o pide algo imposible, responde: {"impossible":true,"reason":"<explicacion>"}
- ${currentBlocks ? `BLOQUES ACTUALES (agrega los nuevos sin eliminar estos a menos que el usuario lo pida):\n${JSON.stringify(currentBlocks)}` : 'No hay bloques actuales.'}
- IMPORTANTE: responde SOLO el JSON.`;

    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: prompt }],
      messages: [{ role: 'user', content: [{ text: description }] }],
      inferenceConfig: { temperature: 0.3, maxTokens: 1000 },
    });

    let raw: string;
    try {
      const res = await this.client.send(command);
      raw = res.output?.message?.content?.[0]?.text ?? '';
    } catch (err) {
      this.log.error('Bedrock report builder failed', (err as Error).message);
      throw err;
    }

    try {
      const obj = JSON.parse(extractJson(raw));
      return obj;
    } catch {
      this.log.warn('Failed to parse report builder response', raw);
      return { error: 'No se pudo generar el reporte. Intenta reformular.' };
    }
  }

  /* ─────────────────────────────────────────────────────────────────────── */

  private parseResponse(raw: string): AiFlowSuggestion {
    const json = extractJson(raw);
    let obj: Record<string, unknown>;

    try {
      obj = JSON.parse(json);
    } catch {
      this.log.warn('Failed to parse AI response as JSON', raw);
      throw new Error('El modelo no devolvió un JSON válido. Intenta reformular la descripción.');
    }

    if (obj.impossible) {
      return {
        impossible: true,
        reason: typeof obj.reason === 'string' ? obj.reason : 'Esta automatizacion no es posible con las opciones disponibles.',
        name: '', triggerType: '', triggerConfig: {}, actionType: '', actionConfig: {}, explanation: '',
      };
    }

    if (obj.clarification) {
      return {
        clarification: true,
        question: typeof obj.question === 'string' ? obj.question : 'Necesito mas detalles para crear este flujo.',
        name: '', triggerType: '', triggerConfig: {}, actionType: '', actionConfig: {}, explanation: '',
      };
    }

    return {
      name: typeof obj.name === 'string' ? obj.name : 'Flujo sin nombre',
      triggerType: String(obj.triggerType ?? ''),
      triggerConfig: (obj.triggerConfig && typeof obj.triggerConfig === 'object' && !Array.isArray(obj.triggerConfig))
        ? obj.triggerConfig as Record<string, unknown>
        : {},
      actionType: String(obj.actionType ?? ''),
      actionConfig: (obj.actionConfig && typeof obj.actionConfig === 'object' && !Array.isArray(obj.actionConfig))
        ? obj.actionConfig as Record<string, unknown>
        : {},
      explanation: typeof obj.explanation === 'string' ? obj.explanation : '',
    };
  }

  private validate(flow: AiFlowSuggestion): void {
    if (!AiFlowBuilderService.VALID_TRIGGERS.has(flow.triggerType)) {
      throw new Error(
        `Trigger type "${flow.triggerType}" no es válido. Tipos válidos: ${[...AiFlowBuilderService.VALID_TRIGGERS].join(', ')}`,
      );
    }
    if (!AiFlowBuilderService.VALID_ACTIONS.has(flow.actionType)) {
      throw new Error(
        `Action type "${flow.actionType}" no es válido. Tipos válidos: ${[...AiFlowBuilderService.VALID_ACTIONS].join(', ')}`,
      );
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function extractJson(s: string): string {
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  if (t.startsWith('{')) return t;
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) {
    return t.slice(first, last + 1);
  }
  return t;
}
