import {
  Controller,
  Post,
  Get,
  Body,
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

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle()
  async chat(
    @Req() req: { user?: { companyId?: string; sub?: string; role?: string } },
    @Body() dto: AnaMessageDto,
  ) {
    const companyId = req.user?.companyId;
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
        req.user?.sub ?? '',
        req.user?.role ?? '',
      );

      if (actions.length > 0) {
        const summaries = actions.map(a => {
          if (a.action === 'flow_created') return `He creado el flujo: ${a.result}. Puedes verlo y administrarlo en la página de Agentes.`;
          if (a.action === 'calendar_event_created') return `${a.result}`;
          if (a.action === 'calendar_error') return `No pude crear el evento en Google Calendar: ${a.result}`;
          if (a.action === 'flow_error') return `No pude crear el flujo: ${a.result}`;
          return a.result;
        });
        reply.text = summaries.join('\n\n') + '\n\n¿Puedo ayudarte con algo más?';
      }

      return { ...reply, ...(actions.length > 0 && { executedActions: actions }) };
    } catch {
      throw new InternalServerErrorException(
        'No se pudo conectar con Ana. Intenta de nuevo.',
      );
    }
  }

  private isCalendarIntent(msg: string): boolean {
    const lo = msg.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return /agenda(r|me)?/i.test(lo) && /calendario|calendar/i.test(lo)
      || /agenda(r|me)?\s*(una\s*)?(cita|evento|reunion)/i.test(lo)
      || /crea(r|me)?\s*(un\s*)?(evento|cita|reunion)/i.test(lo) && /calendario|calendar/i.test(lo)
      || /pon(er|me|lo)?\s*(en\s*)?(el\s*)?(mi\s*)?(calendario|calendar)/i.test(lo)
      || /mi\s*calendario/i.test(lo) && /(agenda|crea|pon|programa)/i.test(lo);
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
  ): Promise<Array<{ action: string; result: string }>> {
    if (role !== 'admin') return [];
    const actions: Array<{ action: string; result: string }> = [];

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
      const conn = await this.prisma.integrationConnection.findFirst({
        where: { companyId, type: 'google_calendar', isActive: true },
      });
      if (!conn) {
        actions.push({ action: 'calendar_error', result: 'Google Calendar no está conectado. Ve a Agentes → haz clic en "Calendar → Conectar" primero.' });
      } else {
        try {
          const { eventTitle, startTime } = this.parseCalendarDetails(userMessage);
          const eventId = await this.calendarSvc.createEvent(companyId, {
            summary: eventTitle,
            description: 'Creado por Ana — TirePro',
            startTime,
            durationMinutes: 60,
          });
          const dateStr = startTime.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' });
          const timeStr = startTime.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
          actions.push({ action: 'calendar_event_created', result: `Evento "${eventTitle}" creado para el ${dateStr} a las ${timeStr}.` });
        } catch (err: any) {
          this.log.warn(`Ana calendar creation failed: ${err.message}`);
          actions.push({ action: 'calendar_error', result: err.message });
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

  private parseCalendarDetails(message: string): { eventTitle: string; startTime: Date } {
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

    return { eventTitle: title, startTime };
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
