import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  InternalServerErrorException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PrismaService } from '../prisma/prisma.service';
import { AnaService } from './ana.service';
import { AnaMessageDto } from './dto/ana-message.dto';
import { AutomationService } from '../automation/automation.service';
import { GoogleCalendarService } from '../integrations/google-calendar/google-calendar.service';

type AuthReq = { user?: { companyId?: string; userId?: string; role?: string } };

@Controller('ana')
@UseGuards(JwtAuthGuard)
export class AnaController {
  private readonly log = new Logger(AnaController.name);

  constructor(
    private readonly anaSvc: AnaService,
    private readonly prisma: PrismaService,
    private readonly automationSvc: AutomationService,
    private readonly calendarSvc: GoogleCalendarService,
  ) {}

  /* ── Conversation CRUD ────────────────────────────────────────── */

  @Get('conversations')
  @SkipThrottle()
  async listConversations(@Req() req: AuthReq) {
    const { companyId, userId } = this.extractUser(req);
    return this.prisma.anaConversation.findMany({
      where: { companyId, userId },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
  }

  @Post('conversations')
  @HttpCode(HttpStatus.CREATED)
  async createConversation(
    @Req() req: AuthReq,
    @Body() body: { title?: string },
  ) {
    const { companyId, userId } = this.extractUser(req);
    return this.prisma.anaConversation.create({
      data: { companyId, userId, title: body?.title || 'Nueva conversación' },
      select: { id: true, title: true, updatedAt: true },
    });
  }

  @Get('conversations/:id')
  @SkipThrottle()
  async getConversation(@Req() req: AuthReq, @Param('id') id: string) {
    const { companyId, userId } = this.extractUser(req);
    const conv = await this.prisma.anaConversation.findFirst({
      where: { id, companyId, userId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!conv) throw new NotFoundException('Conversación no encontrada.');
    return conv;
  }

  @Patch('conversations/:id')
  async updateConversation(
    @Req() req: AuthReq,
    @Param('id') id: string,
    @Body() body: { title?: string },
  ) {
    const { companyId, userId } = this.extractUser(req);
    const conv = await this.prisma.anaConversation.findFirst({ where: { id, companyId, userId } });
    if (!conv) throw new NotFoundException('Conversación no encontrada.');
    return this.prisma.anaConversation.update({
      where: { id },
      data: { title: body.title ?? conv.title },
      select: { id: true, title: true, updatedAt: true },
    });
  }

  @Delete('conversations/:id')
  async deleteConversation(@Req() req: AuthReq, @Param('id') id: string) {
    const { companyId, userId } = this.extractUser(req);
    const conv = await this.prisma.anaConversation.findFirst({ where: { id, companyId, userId } });
    if (!conv) throw new NotFoundException('Conversación no encontrada.');
    await this.prisma.anaConversation.delete({ where: { id } });
    return { deleted: true };
  }

  private extractUser(req: AuthReq): { companyId: string; userId: string } {
    const companyId = req.user?.companyId;
    const userId = req.user?.userId;
    if (!companyId || !userId) throw new BadRequestException('No company/user.');
    return { companyId, userId };
  }

  /* ── Calendar confirm ─────────────────────────────────────────── */

  @Post('calendar/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmCalendarEvent(
    @Req() req: AuthReq,
    @Body() body: {
      title: string;
      startTimeISO: string;
      durationMinutes: number;
      description?: string;
      attendees?: string[];
    },
  ) {
    const companyId = req.user?.companyId;
    if (!companyId) throw new BadRequestException('No company.');
    const startTime = new Date(body.startTimeISO);
    if (isNaN(startTime.getTime())) throw new BadRequestException('Invalid startTime.');

    await this.calendarSvc.createEvent(companyId, {
      summary: body.title,
      description: body.description,
      startTime,
      durationMinutes: body.durationMinutes || 60,
      attendees: body.attendees,
    });

    const dateStr = startTime.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
    const timeStr = startTime.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
    return { success: true, message: `Evento "${body.title}" creado para el ${dateStr} a las ${timeStr}.` };
  }

  /* ── Chat (with persistence) ──────────────────────────────────── */

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  async chat(
    @Req() req: AuthReq,
    @Body() dto: AnaMessageDto,
  ) {
    const companyId = req.user?.companyId;
    const userId = req.user?.userId ?? '';
    if (!companyId) {
      throw new BadRequestException('No company associated with this user.');
    }

    try {
      const reply = await this.anaSvc.chat(
        companyId,
        dto.message,
        dto.history ?? [],
        dto.tireData ?? '',
      );

      const actions = await this.executeAnaActions(
        dto.message,
        reply.text,
        companyId,
        userId,
        req.user?.role ?? '',
      );

      if (actions.length > 0) {
        const hasPreview = actions.some(a => a.action === 'calendar_preview');
        if (!hasPreview) {
          const summaries = actions.map(a => {
            if (a.action === 'flow_created') return `He creado el flujo: ${a.result}. Puedes verlo y administrarlo en la página de Agentes.`;
            if (a.action === 'calendar_event_created') return `${a.result}`;
            if (a.action === 'calendar_conflict') return `${a.result}`;
            if (a.action === 'calendar_query') return `${a.result}`;
            if (a.action === 'calendar_error') return `${a.result}`;
            if (a.action === 'calendar_needs_info') return `${a.result}`;
            if (a.action === 'flow_error') return `No pude crear el flujo: ${a.result}`;
            return a.result;
          });
          reply.text = summaries.join('\n\n') + '\n\n¿Puedo ayudarte con algo más?';
        }

        for (const a of actions) {
          if (a.action === 'calendar_preview' && a.data) {
            reply.text = '¡Listo! Revisa los detalles del evento:';
            reply.blocks = [...(reply.blocks ?? []), { kind: 'calendarPreview', ...(a.data as object) }];
            reply.suggestions = null;
          }
          if (a.action === 'calendar_query' && a.data) {
            const d = a.data as { events: Array<{ summary: string; start: string; end: string }>; label: string; date: string };
            reply.blocks = [
              ...(reply.blocks ?? []),
              { kind: 'calendar', title: `Eventos ${d.label}`, date: d.date, events: d.events },
            ];
          }
          if (a.action === 'calendar_event_created') {
            reply.blocks = [
              ...(reply.blocks ?? []),
              { kind: 'callout', tone: 'good', title: 'Evento creado', text: a.result },
            ];
          }
          if (a.action === 'calendar_conflict') {
            reply.blocks = [
              ...(reply.blocks ?? []),
              { kind: 'callout', tone: 'warn', title: 'Conflicto de horario', text: a.result },
            ];
          }
          if (a.action === 'flow_created') {
            reply.blocks = [
              ...(reply.blocks ?? []),
              { kind: 'callout', tone: 'good', title: 'Flujo creado', text: `${a.result} — visible en la página de Agentes.` },
            ];
          }
        }
      }

      // Persist messages to DB
      let conversationId = dto.conversationId;
      try {
        if (!conversationId && userId) {
          const title = dto.message.length > 60 ? dto.message.slice(0, 60) + '…' : dto.message;
          const conv = await this.prisma.anaConversation.create({
            data: { companyId, userId, title },
          });
          conversationId = conv.id;
        }
        if (conversationId && userId) {
          await this.prisma.anaMessage.createMany({
            data: [
              { conversationId, role: 'user', text: dto.message },
              {
                conversationId,
                role: 'assistant',
                text: reply.text,
                blocks: reply.blocks ? (reply.blocks as any) : undefined,
                suggestions: reply.suggestions ? (reply.suggestions as any) : undefined,
              },
            ],
          });
          // Update title from first user message if this was a new conversation
          if (!dto.conversationId) {
            const title = dto.message.length > 60 ? dto.message.slice(0, 60) + '…' : dto.message;
            await this.prisma.anaConversation.update({
              where: { id: conversationId },
              data: { title },
            });
          }
        }
      } catch (err) {
        this.log.warn(`Failed to persist Ana message: ${(err as any)?.message}`);
      }

      return {
        ...reply,
        conversationId,
        ...(actions.length > 0 && { executedActions: actions }),
      };
    } catch {
      throw new InternalServerErrorException(
        'No se pudo conectar con Ana. Intenta de nuevo.',
      );
    }
  }

  private isCalendarQueryIntent(msg: string): boolean {
    const lo = msg.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/que\s*tengo|que\s*hay|mis\s*eventos/i.test(lo)) return true;
    if (/muestrame.*calendario/i.test(lo)) return true;
    if (/(tengo|hay).*calendario/i.test(lo)) return true;
    if (/calendario.*(?:hoy|manana|semana|lunes|martes|miercoles|jueves|viernes)/i.test(lo) && !/(agenda|crea|pon|programa)/i.test(lo)) return true;
    return false;
  }

  private isCalendarIntent(msg: string): boolean {
    if (this.isCalendarQueryIntent(msg)) return false;
    const lo = msg.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/agenda(r|me)/i.test(lo)) return true;
    if (/crea(r|me)?\s*(un\s*)?(evento|cita|reunion)/i.test(lo)) return true;
    if (/pon(er|me|lo)?\s*(en\s*)?(el\s*)?(mi\s*)?(calendario|calendar)/i.test(lo)) return true;
    if (/programa(r|me)?\s*(un\s*)?(evento|cita)/i.test(lo)) return true;
    if (/agrega(r|me)?\s*(un\s*)?(evento|cita)/i.test(lo)) return true;
    if (/agrega(r|me)?.*\b(calendario|calendar)\b/i.test(lo)) return true;
    if (/\b(create|add|schedule|book)\b.*\b(event|meeting|appointment|calendar)\b/i.test(lo)) return true;
    if (/\b(calendar|calendario)\b.*\b(event|evento|cita)\b/i.test(lo)) return true;
    return false;
  }

  private parseCalendarQueryRange(msg: string): { start: Date; end: Date; label: string } {
    const lo = msg.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const now = new Date();

    if (/manana/i.test(lo)) {
      const s = new Date(now); s.setDate(s.getDate() + 1); s.setHours(0, 0, 0, 0);
      const e = new Date(s); e.setHours(23, 59, 59, 999);
      return { start: s, end: e, label: 'para mañana' };
    }
    if (/semana/i.test(lo)) {
      const s = new Date(now); s.setHours(0, 0, 0, 0);
      const e = new Date(s); e.setDate(e.getDate() + 7); e.setHours(23, 59, 59, 999);
      return { start: s, end: e, label: 'de esta semana' };
    }

    const days: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 0 };
    for (const [name, dow] of Object.entries(days)) {
      if (lo.includes(name)) {
        const s = this.nextWeekday(dow); s.setHours(0, 0, 0, 0);
        const e = new Date(s); e.setHours(23, 59, 59, 999);
        return { start: s, end: e, label: `el ${name}` };
      }
    }

    const s = new Date(now); s.setHours(0, 0, 0, 0);
    const e = new Date(s); e.setHours(23, 59, 59, 999);
    return { start: s, end: e, label: 'para hoy' };
  }

  private isFlowIntent(msg: string): boolean {
    return /crea(r|me)?\s*(un\s*)?(flujo|agente|automatizaci)/i.test(msg)
      || /configura(r|me)?\s*(un\s*)?(flujo|alerta\s*automat)/i.test(msg);
  }

  private async executeAnaActions(
    userMessage: string,
    _anaReply: string,
    companyId: string,
    userId: string,
    role: string,
  ): Promise<Array<{ action: string; result: string; data?: unknown }>> {
    if (role !== 'admin') return [];
    const actions: Array<{ action: string; result: string; data?: unknown }> = [];

    if (this.isCalendarQueryIntent(userMessage)) {
      const conn = await this.prisma.integrationConnection.findFirst({
        where: { companyId, type: 'google_calendar', isActive: true },
      });
      if (!conn) {
        actions.push({ action: 'calendar_error', result: 'Google Calendar no está conectado. Ve a Agentes → haz clic en "Calendar → Conectar" primero.' });
      } else {
        try {
          const { start, end, label } = this.parseCalendarQueryRange(userMessage);
          const events = await this.calendarSvc.listEvents(companyId, start, end);
          if (events.length === 0) {
            actions.push({ action: 'calendar_query', result: `No tienes eventos ${label}.`, data: { events: [], label, date: start.toISOString() } });
          } else {
            actions.push({ action: 'calendar_query', result: `Tus eventos ${label}`, data: { events, label, date: start.toISOString() } });
          }
        } catch (err: any) {
          this.log.warn(`Ana calendar query failed: ${err.message}`);
          actions.push({ action: 'calendar_error', result: err.message });
        }
      }
      return actions;
    }

    if (this.isFlowIntent(userMessage)) {
      try {
        const flow = await this.detectAndCreateFlow(userMessage, companyId, userId);
        if (flow) actions.push({ action: 'flow_created', result: `"${flow.name}"` });
      } catch (err: any) {
        this.log.warn(`Ana flow creation failed: ${err.message}`);
        actions.push({ action: 'flow_error', result: err.message });
      }
    }

    if (this.isCalendarIntent(userMessage)) {
      if (!this.hasDateOrTimeHint(userMessage)) {
        actions.push({
          action: 'calendar_needs_info',
          result: '¡Claro! Para crear el evento necesito algunos datos:\n\n1. **¿Qué día?** (ej: mañana, el viernes, 2 de junio)\n2. **¿A qué hora?** (ej: 10am, 3pm)\n3. **¿Cuánto dura?** (por defecto 1 hora)\n4. **¿Algún detalle adicional?** — ubicación, enlace de reunión, personas a invitar\n\nDime y lo agendo por ti.',
        });
      } else {
        const conn = await this.prisma.integrationConnection.findFirst({
          where: { companyId, type: 'google_calendar', isActive: true },
        });
        if (!conn) {
          actions.push({ action: 'calendar_error', result: 'Google Calendar no está conectado. Ve a Agentes → haz clic en "Calendar → Conectar" primero.' });
        } else {
          try {
            const wantsTireInfo = /llanta|tire|critica|detalles|descripci|info/i.test(userMessage);
            const { eventTitle, startTime, description } = await this.parseCalendarDetails(userMessage, _anaReply, wantsTireInfo ? companyId : undefined);
            const durationMatch = userMessage.match(/(\d+)\s*hora/i);
            const durationMinutes = durationMatch ? parseInt(durationMatch[1]) * 60 : 60;
            const dateStr = startTime.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
            const timeStr = startTime.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
            const attendees = [...userMessage.matchAll(/[\w.-]+@[\w.-]+\.\w+/g)].map(m => m[0]);

            const conflicts: string[] = [];
            const endTime = new Date(startTime.getTime() + durationMinutes * 60_000);
            const existing = await this.calendarSvc.listEvents(companyId, startTime, endTime);
            for (const e of existing) {
              const s = new Date(e.start).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
              conflicts.push(`"${e.summary}" a las ${s}`);
            }

            actions.push({
              action: 'calendar_preview',
              result: '',
              data: {
                title: eventTitle,
                date: dateStr,
                time: timeStr,
                startTimeISO: startTime.toISOString(),
                durationMinutes,
                description,
                attendees,
                conflicts,
              },
            });
          } catch (err: any) {
            this.log.warn(`Ana calendar creation failed: ${err.message}`);
            actions.push({ action: 'calendar_error', result: err.message });
          }
        }
      }
    }


    return actions;
  }

  private async detectAndCreateFlow(
    message: string,
    companyId: string,
    userId: string,
  ) {
    let triggerType = 'tire_alert_level';
    let triggerConfig: Record<string, any> = { alertLevels: ['critical'] };
    let actionType = 'send_email';
    let actionConfig: Record<string, any> = {};

    const lo = message.toLowerCase();

    if (/cambio\s*inmediato|critica|profundidad.*2/i.test(lo)) {
      triggerConfig = { alertLevels: ['critical'] };
    } else if (/warning|30\s*d[ií]a/i.test(lo)) {
      triggerConfig = { alertLevels: ['critical', 'warning'] };
    } else if (/inspecci[oó]n/i.test(lo)) {
      triggerType = 'inspection_completed';
      triggerConfig = {};
    }

    if (/whatsapp|wsp|whats/i.test(lo)) {
      actionType = 'send_whatsapp';
      const phoneMatch = lo.match(/(\+?\d[\d\s\-]{8,})/);
      actionConfig = { to: phoneMatch ? phoneMatch[1].replace(/[\s\-]/g, '') : '' };
    } else if (/email|correo|mail/i.test(lo)) {
      actionType = 'send_email';
      const emailMatch = lo.match(/[\w.-]+@[\w.-]+\.\w+/);
      actionConfig = { to: emailMatch ? emailMatch[0] : '', subject: 'Alerta TirePro' };
    } else if (/calendar|calendario|cita|agendar/i.test(lo)) {
      actionType = 'create_calendar_event';
      actionConfig = { title: 'Cita TirePro — Cambio de llantas', durationMinutes: 60 };
    } else {
      actionType = 'create_notification';
      actionConfig = { priority: 2 };
    }

    const name =
      /cambio\s*inmediato|critica/i.test(lo)
        ? 'Alerta cambio inmediato'
        : 'Flujo creado por Ana';

    return this.automationSvc.createFlow(companyId, userId, {
      name,
      triggerType,
      triggerConfig,
      actionType,
      actionConfig,
    } as any);
  }

  private hasDateOrTimeHint(msg: string): boolean {
    const lo = msg.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/hoy|manana|pasado\s*manana/i.test(lo)) return true;
    if (/lunes|martes|miercoles|jueves|viernes|sabado|domingo/i.test(lo)) return true;
    if (/a\s*las?\s*\d/i.test(lo)) return true;
    if (/\d{1,2}[\/:]\d{2}/i.test(lo)) return true;
    if (/\d{1,2}\s*(am|pm)/i.test(lo)) return true;
    if (/proxim[oa]|siguiente|esta\s*semana|fin\s*de\s*semana/i.test(lo)) return true;
    return false;
  }

  private async parseCalendarDetails(message: string, conversationContext?: string, companyIdForTireData?: string): Promise<{ eventTitle: string; startTime: Date; description: string }> {
    let title = 'Cita TirePro';
    if (/cambio|llantas|reemplazo|comprar\s*llantas/i.test(message)) title = 'Cambio de llantas';
    if (/inspecci[oó]n/i.test(message)) title = 'Inspección de flota';
    if (/distribuidor|inter\b/i.test(message)) title = 'Visita distribuidor';
    if (/rotaci[oó]n/i.test(message)) title = 'Rotación de llantas';

    const contextMatch = message.match(/(?:para|ir\s*a)\s+(.{3,40?)(?:\s+(?:ma[ñn]ana|lunes|martes|mi[eé]rcoles|jueves|viernes|el\s|para\s|$))/i);
    if (contextMatch) {
      const raw = contextMatch[1].trim().replace(/^(hacer|una|un|la|el)\s+/i, '');
      if (raw.length > 3) title = raw.charAt(0).toUpperCase() + raw.slice(1);
    }

    let startTime = new Date();
    startTime.setDate(startTime.getDate() + 1);
    startTime.setHours(9, 0, 0, 0);

    if (/hoy/i.test(message)) {
      startTime = new Date();
      startTime.setHours(startTime.getHours() + 1, 0, 0, 0);
    } else if (/ma[ñn]ana/i.test(message)) {
      startTime = new Date();
      startTime.setDate(startTime.getDate() + 1);
      startTime.setHours(9, 0, 0, 0);
    } else if (/pasado\s*ma[ñn]ana/i.test(message)) {
      startTime = new Date();
      startTime.setDate(startTime.getDate() + 2);
      startTime.setHours(9, 0, 0, 0);
    } else {
      const days: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 0 };
      const lo = message.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
      for (const [name, dow] of Object.entries(days)) {
        if (lo.includes(name)) { startTime = this.nextWeekday(dow); break; }
      }
    }

    const timeMatch = message.match(/(?:a\s*las?\s*)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
      let h = parseInt(timeMatch[1]);
      if (timeMatch[3]?.toLowerCase() === 'pm' && h < 12) h += 12;
      if (timeMatch[3]?.toLowerCase() === 'am' && h === 12) h = 0;
      startTime.setHours(h, parseInt(timeMatch[2] ?? '0'), 0, 0);
    }

    let description = 'Creado por Ana — TirePro';

    if (companyIdForTireData) {
      try {
        const criticalTires = await this.prisma.tire.findMany({
          where: { companyId: companyIdForTireData, currentProfundidad: { lte: 4 } },
          select: {
            marca: true,
            diseno: true,
            dimension: true,
            currentProfundidad: true,
            currentCpk: true,
            projectedKmRemaining: true,
            eje: true,
            posicion: true,
            vehicle: { select: { placa: true } },
          },
          orderBy: { currentProfundidad: 'asc' },
          take: 20,
        });
        if (criticalTires.length) {
          const tireLines = criticalTires.map(t =>
            `• ${t.vehicle?.placa || '?'} — ${t.marca} ${t.diseno} (${t.dimension}) — ${t.currentProfundidad?.toFixed(1)}mm — Pos: ${t.posicion || '?'} — CPK: $${t.currentCpk?.toFixed(0) || '?'}`,
          );
          description = `${title}\n\nLlantas críticas (≤4mm) para compra/cambio:\n${tireLines.join('\n')}\n\nTotal: ${criticalTires.length} llantas requieren atención.\n\n— Creado por Ana · TirePro`;
        }
      } catch {
        this.log.warn('Failed to fetch tire data for calendar description');
      }
    } else if (conversationContext) {
      const contextLines = conversationContext
        .split('\n')
        .filter(l => l.trim())
        .slice(0, 20)
        .join('\n');
      if (contextLines.length > 10) {
        description = `${title}\n\nDetalles de Ana:\n${contextLines}\n\n— Creado por Ana · TirePro`;
      }
    }

    return { eventTitle: title, startTime, description };
  }

  private nextWeekday(day: number): Date {
    const d = new Date();
    d.setHours(9, 0, 0, 0);
    const diff = (day - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  @Get('vehicle-tires')
  @SkipThrottle()
  async vehicleTires(
    @Req() req: { user?: { companyId?: string } },
    @Query('placa') placa: string,
  ) {
    const companyId = req.user?.companyId;
    if (!companyId) throw new BadRequestException('No company.');
    if (!placa?.trim()) throw new BadRequestException('placa is required.');

    const vehicle = await this.prisma.vehicle.findFirst({
      where: {
        companyId,
        placa: { equals: placa.trim(), mode: 'insensitive' },
        archivedAt: null,
      },
      select: {
        id: true,
        placa: true,
        tipovhc: true,
        kilometrajeActual: true,
        configuracion: true,
        tires: {
          select: {
            id: true,
            placa: true,
            marca: true,
            diseno: true,
            dimension: true,
            eje: true,
            posicion: true,
            currentProfundidad: true,
            profundidadInicial: true,
            vidaActual: true,
            alertLevel: true,
            healthScore: true,
          },
          orderBy: { posicion: 'asc' },
        },
      },
    });

    if (!vehicle) throw new NotFoundException('Vehículo no encontrado.');
    return vehicle;
  }
}
