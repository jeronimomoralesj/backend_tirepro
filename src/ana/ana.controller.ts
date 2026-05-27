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

      return { ...reply, ...(actions.length > 0 && { executedActions: actions }) };
    } catch {
      throw new InternalServerErrorException(
        'No se pudo conectar con Ana. Intenta de nuevo.',
      );
    }
  }

  private async executeAnaActions(
    userMessage: string,
    anaReply: string,
    companyId: string,
    userId: string,
    role: string,
  ): Promise<Array<{ action: string; result: string }>> {
    if (role !== 'admin') return [];

    const lo = (userMessage + ' ' + anaReply)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    const actions: Array<{ action: string; result: string }> = [];

    if (
      /crea(r|me)?\s*(un\s*)?(flujo|agente|automatizaci)/i.test(userMessage) ||
      /configura(r|me)?\s*(un\s*)?(flujo|alerta\s*automat)/i.test(userMessage)
    ) {
      try {
        const flow = await this.detectAndCreateFlow(userMessage, companyId, userId);
        if (flow) actions.push({ action: 'flow_created', result: `Flujo "${flow.name}" creado` });
      } catch (err: any) {
        this.log.warn(`Ana flow creation failed: ${err.message}`);
      }
    }

    if (
      /agenda(r|me)?\s*(una\s*)?(cita|evento|reunion)/i.test(userMessage) ||
      /crea(r|me)?\s*(un\s*)?(evento|cita)\s*(en\s*)?(el\s*)?(calendario|calendar)/i.test(userMessage) ||
      /pon(er|me)?\s*(en\s*)?(el\s*)?(calendario|calendar)/i.test(userMessage)
    ) {
      try {
        const event = await this.createCalendarEvent(userMessage, companyId);
        if (event) actions.push({ action: 'calendar_event_created', result: event });
      } catch (err: any) {
        this.log.warn(`Ana calendar creation failed: ${err.message}`);
        actions.push({ action: 'calendar_error', result: err.message });
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

  private async createCalendarEvent(
    message: string,
    companyId: string,
  ): Promise<string | null> {
    if (!this.calendarSvc.isConfigured()) {
      throw new Error('Google Calendar no está conectado. Ve a Agentes para conectarlo.');
    }

    let title = 'Cita TirePro';
    let durationMinutes = 60;

    if (/cambio|llantas|reemplazo/i.test(message)) title = 'Cambio de llantas — TirePro';
    if (/inspecci[oó]n/i.test(message)) title = 'Inspección de flota — TirePro';
    if (/distribuidor/i.test(message)) title = 'Cita con distribuidor — TirePro';

    const hourMatch = message.match(/(\d+)\s*hora/i);
    if (hourMatch) durationMinutes = parseInt(hourMatch[1]) * 60;
    const minMatch = message.match(/(\d+)\s*min/i);
    if (minMatch) durationMinutes = parseInt(minMatch[1]);

    let startTime = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (/ma[ñn]ana/i.test(message)) {
      startTime = new Date();
      startTime.setDate(startTime.getDate() + 1);
      startTime.setHours(9, 0, 0, 0);
    } else if (/lunes/i.test(message)) {
      startTime = this.nextWeekday(1);
    } else if (/martes/i.test(message)) {
      startTime = this.nextWeekday(2);
    } else if (/mi[eé]rcoles/i.test(message)) {
      startTime = this.nextWeekday(3);
    } else if (/jueves/i.test(message)) {
      startTime = this.nextWeekday(4);
    } else if (/viernes/i.test(message)) {
      startTime = this.nextWeekday(5);
    }

    const eventId = await this.calendarSvc.createEvent(companyId, {
      summary: title,
      description: 'Creado por Ana — TirePro',
      startTime,
      durationMinutes,
    });

    return eventId ? `Evento "${title}" creado en Google Calendar` : null;
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
