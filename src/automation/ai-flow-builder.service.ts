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
   triggerConfig: { "alertLevels": ["inmediato" | "30d" | "60d" | "optimo"] }

2. "tire_depth_threshold" — Se dispara cuando la profundidad de una llanta cae por debajo de un umbral.
   triggerConfig: { "thresholdMm": <número en milímetros, SIEMPRE decimal, ej: 1.3, 2.0, 4.5. NUNCA multiplicar por 1000> }
   - "1.3mm" → thresholdMm: 1.3 (NO 1300). "2mm" → thresholdMm: 2.0. Las profundidades de llantas van de 0 a ~15mm.

3. "scheduled_cron" — Se dispara según un horario cron.
   triggerConfig: { "cron": "<expresión cron>", "timezone": "America/Bogota" }

4. "tire_eol_approaching" — Se dispara cuando la llanta se acerca al fin de vida.
   triggerConfig: { "daysThreshold": <número de días> }

5. "inspection_completed" — Se dispara cuando se completa una inspección.
   triggerConfig: { "alertLevelFilter": ["inmediato" | "30d" | "60d" | "optimo"] } (opcional, vacío = todas)

TIPOS DE ACCIÓN disponibles:
1. "send_email" — Envía un correo electrónico.
   actionConfig: { "to": "<correo>", "subject": "Alerta: {{tireMarca}} {{tireDiseno}}" }

2. "send_whatsapp" — Envía un mensaje de WhatsApp.
   actionConfig: { "to": "<número con código de país, ej: +57...>" }

3. "create_calendar_event" — Crea un evento en Google Calendar.
   actionConfig: { "summary": "<título>", "description": "<descripción del evento>", "durationMinutes": <número>, "delayDays": <número de días después del trigger para programar el evento, default 0 = mismo día> }
   - Si el usuario dice "para el siguiente día" o "al día siguiente", usa delayDays: 1.
   - Si dice "en 3 días", usa delayDays: 3. Si no menciona cuándo, usa delayDays: 0.
   - En "description", incluye las variables de plantilla relevantes para dar contexto. Ejemplo: "Llanta {{tireMarca}} {{tireDiseno}} en vehículo {{vehiclePlaca}} — profundidad: {{tireDepth}}mm"

4. "make_phone_call" — Realiza una llamada telefónica.
   actionConfig: { "to": "<número>", "message": "<mensaje de voz>" }

5. "create_notification" — Crea una notificación interna en TirePro.
   actionConfig: { "priority": 1 | 2 | 3 }
   (1=info, 2=warning, 3=critical)

Variables de plantilla disponibles para subject/message: {{vehiclePlaca}}, {{tirePlaca}}, {{tireMarca}}, {{tireDiseno}}, {{tireDepth}}, {{tireAlertLevel}}, {{date}}, {{companyName}}.

REGLAS:
- Responde SOLO con JSON puro (sin markdown, sin \`\`\`).
- Estructura exacta:
{
  "name": "<nombre corto descriptivo del flujo>",
  "triggerType": "<uno de los tipos de trigger>",
  "triggerConfig": { ... },
  "actionType": "<uno de los tipos de acción>",
  "actionConfig": { ... },
  "explanation": "<explicación breve en español de lo que hace el flujo>"
}
- Elige el trigger y acción que mejor se ajusten a la descripción del usuario.
- Si la descripción no menciona un destinatario específico, usa placeholders descriptivos como "jefe@empresa.com" o "+573001234567".
- Si mencionan "cambio inmediato", usa trigger "tire_alert_level" con alertLevels ["inmediato"].
- Si mencionan "profundidad menor a X mm", usa trigger "tire_depth_threshold".
- Si mencionan un horario (diario, semanal, etc.), usa trigger "scheduled_cron".
- Si mencionan "fin de vida" o "por acabarse", usa trigger "tire_eol_approaching".
- Si mencionan "inspección", usa trigger "inspection_completed".
- IMPORTANTE: responde SOLO el JSON, nada más.`;

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

  async buildFlow(description: string): Promise<AiFlowSuggestion> {
    const command = new ConverseCommand({
      modelId: MODEL_ID,
      system: [{ text: SYSTEM_PROMPT }],
      messages: [
        { role: 'user', content: [{ text: description }] },
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
    this.validate(parsed);
    return parsed;
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
