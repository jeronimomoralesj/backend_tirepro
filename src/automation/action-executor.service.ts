import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { GoogleCalendarService } from '../integrations/google-calendar/google-calendar.service';
import { AutomationFlow, ActionType, FlowStatus, Prisma } from '@prisma/client';
import { wrapEmail, emailText, emailKvList, emailButton, emailCallout } from '../email/email-templates';

export interface ActionContext {
  tireId?: string;
  tireIds?: string[];
  companyId: string;
}

@Injectable()
export class ActionExecutorService {
  private readonly logger = new Logger(ActionExecutorService.name);
  private static readonly MAX_CONSECUTIVE_ERRORS = 5;

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly whatsappService: WhatsappService,
    @Optional() private readonly googleCalendar?: GoogleCalendarService,
  ) {}

  async execute(flow: AutomationFlow, ctx: ActionContext): Promise<void> {
    const start = Date.now();
    let success = false;
    let output: Record<string, unknown> | null = null;
    let error: string | null = null;

    try {
      const vars = await this.buildTemplateVars(ctx);
      const config = flow.actionConfig as Record<string, unknown>;

      switch (flow.actionType) {
        case ActionType.send_email: {
          const to = this.interpolate((config.to as string) ?? '', vars);
          const subject = this.interpolate(
            (config.subject as string) ?? 'Alerta TirePro',
            vars,
          );
          const customBody = config.body as string | undefined;
          const body = customBody
            ? this.buildCustomEmailBody(customBody, vars)
            : this.buildEmailBody(vars);
          await this.emailService.sendEmail(to, subject, body);
          output = { to, subject };
          break;
        }

        case ActionType.send_whatsapp: {
          const to = (config.to as string) ?? '';
          const vehiclePlaca = vars.vehiclePlaca ?? 'N/A';
          const position = vars.position ?? 'N/A';
          const action = `Alerta: ${vars.tireMarca ?? ''} ${vars.tireDiseno ?? ''} — profundidad ${vars.tireDepth ?? '?'}mm`;
          const link = `https://tirepro.com.co/dashboard/resumen`;
          const sent = await this.whatsappService.sendDriverAlert(
            to,
            vehiclePlaca,
            position,
            action,
            link,
          );
          output = { to, sent };
          break;
        }

        case ActionType.create_notification: {
          const priority = (config.priority as number) ?? 2;
          if (ctx.tireId) {
            await this.prisma.notification.create({
              data: {
                title: `Agente: ${flow.name}`,
                message: `Flujo automático ejecutado para llanta ${vars.tirePlaca ?? ctx.tireId}`,
                type: priority >= 3 ? 'critical' : priority >= 2 ? 'warning' : 'info',
                companyId: ctx.companyId,
                tireId: ctx.tireId,
                priority,
              },
            });
          }
          output = { created: true };
          break;
        }

        case ActionType.create_calendar_event: {
          if (!this.googleCalendar) throw new Error('Google Calendar not configured');
          const calConfig = flow.actionConfig as Record<string, unknown>;
          const delayDays = typeof calConfig.delayDays === 'number' ? calConfig.delayDays : 0;
          const startHour = typeof calConfig.startHour === 'number' ? calConfig.startHour : 9;
          const startMinute = typeof calConfig.startMinute === 'number' ? calConfig.startMinute : 0;
          const startTime = new Date();
          startTime.setDate(startTime.getDate() + (delayDays > 0 ? delayDays : 1));
          startTime.setHours(startHour, startMinute, 0, 0);

          const tireIds = ctx.tireIds && ctx.tireIds.length > 1 ? ctx.tireIds : (ctx.tireId ? [ctx.tireId] : []);
          const allTireVars = await Promise.all(tireIds.map(id => this.buildTemplateVars({ tireId: id, companyId: ctx.companyId })));

          const title = allTireVars.length > 1
            ? `Alerta TirePro — ${allTireVars.length} llantas requieren atencion`
            : this.interpolate((calConfig.summary as string) ?? (calConfig.title as string) ?? 'Alerta TirePro — {{vehiclePlaca}}', vars);

          let description: string;
          if (allTireVars.length > 1) {
            const lines = allTireVars.map((tv, i) => {
              const parts = [
                `Llanta ${i + 1}:`,
                tv.tireMarca ? `${tv.tireMarca} ${tv.tireDiseno ?? ''}`.trim() : null,
                tv.tireDepth ? `Profundidad: ${tv.tireDepth}mm` : null,
                tv.vehiclePlaca ? `Vehiculo: ${tv.vehiclePlaca}` : null,
                tv.position ? `Posicion: ${tv.position}` : null,
                tv.tirePlaca ? `ID: ${tv.tirePlaca}` : null,
                tv.tireAlertLevel ? `Nivel: ${tv.tireAlertLevel}` : null,
              ].filter(Boolean);
              return parts.join(' | ');
            });
            description = `${allTireVars.length} llantas activaron esta alerta:\n\n${lines.join('\n')}\n\n— Generado por Agentes TirePro`;
          } else if (calConfig.description) {
            description = this.interpolate(calConfig.description as string, vars);
          } else {
            description = `Generado por Agentes TirePro.\n${vars.tireMarca ? `Llanta: ${vars.tireMarca} ${vars.tireDiseno ?? ''} — ${vars.tireDepth ?? '?'}mm\nVehiculo: ${vars.vehiclePlaca ?? 'N/A'}\nPosicion: ${vars.position ?? 'N/A'}\nID: ${vars.tirePlaca ?? 'N/A'}` : ''}`;
          }

          const eventId = await this.googleCalendar.createEvent(ctx.companyId, {
            summary: title,
            description,
            startTime,
            durationMinutes: (calConfig.durationMinutes as number) ?? 60,
          });
          output = { eventId, tireCount: allTireVars.length };
          break;
        }

        case ActionType.make_phone_call:
          this.logger.warn('Phone calls not yet implemented (Phase 4)');
          output = { skipped: true, reason: 'not_implemented' };
          break;
      }

      success = true;
    } catch (err: any) {
      error = err.message ?? 'Unknown error';
      this.logger.error(
        `Flow ${flow.id} action failed: ${error}`,
        err.stack,
      );
    }

    await this.prisma.flowRun.create({
      data: {
        flowId: flow.id,
        triggerPayload: ctx as unknown as Prisma.InputJsonValue,
        success,
        output: (output ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        error,
        durationMs: Date.now() - start,
        entityType: ctx.tireId ? 'tire' : 'company',
        entityId: ctx.tireId ?? ctx.companyId,
      },
    });

    await this.prisma.automationFlow.update({
      where: { id: flow.id },
      data: {
        lastRunAt: new Date(),
        runCount: { increment: 1 },
        ...(error
          ? { errorCount: { increment: 1 }, lastError: error }
          : { lastError: null }),
      },
    });

    if (error) {
      const updated = await this.prisma.automationFlow.findUnique({
        where: { id: flow.id },
        select: { errorCount: true },
      });
      if (
        updated &&
        updated.errorCount >= ActionExecutorService.MAX_CONSECUTIVE_ERRORS
      ) {
        await this.prisma.automationFlow.update({
          where: { id: flow.id },
          data: { status: FlowStatus.error },
        });
        this.logger.warn(
          `Flow ${flow.id} auto-paused after ${updated.errorCount} consecutive errors`,
        );
      }
    }
  }

  private async buildTemplateVars(
    ctx: ActionContext,
  ): Promise<Record<string, string>> {
    const vars: Record<string, string> = {
      date: new Date().toLocaleDateString('es-CO'),
    };

    if (ctx.companyId) {
      const company = await this.prisma.company.findUnique({
        where: { id: ctx.companyId },
        select: { name: true },
      });
      if (company) vars.companyName = company.name;
    }

    if (ctx.tireId) {
      const tire = await this.prisma.tire.findUnique({
        where: { id: ctx.tireId },
        select: {
          placa: true,
          marca: true,
          diseno: true,
          dimension: true,
          posicion: true,
          currentProfundidad: true,
          alertLevel: true,
          vehicle: { select: { placa: true } },
        },
      });
      if (tire) {
        vars.tirePlaca = tire.placa;
        vars.tireMarca = tire.marca;
        vars.tireDiseno = tire.diseno ?? '';
        vars.tireDimension = tire.dimension ?? '';
        vars.tireDepth = tire.currentProfundidad?.toFixed(1) ?? '?';
        vars.tireAlertLevel = tire.alertLevel;
        vars.position = String(tire.posicion);
        vars.vehiclePlaca = tire.vehicle?.placa ?? 'N/A';
      }
    }

    return vars;
  }

  private interpolate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (_, key) => {
      const flat = key.replace('.', '');
      const camel =
        flat.charAt(0).toLowerCase() +
        flat
          .slice(1)
          .replace(/([A-Z])/g, (m: string) => m);
      return vars[camel] ?? vars[key] ?? `{{${key}}}`;
    });
  }

  private buildEmailBody(vars: Record<string, string>): string {
    const kvRows: Array<{ label: string; value: string }> = [];
    if (vars.vehiclePlaca) kvRows.push({ label: 'Vehiculo', value: vars.vehiclePlaca });
    if (vars.tirePlaca) kvRows.push({ label: 'Llanta', value: vars.tirePlaca });
    if (vars.tireMarca) kvRows.push({ label: 'Marca / Diseno', value: `${vars.tireMarca} ${vars.tireDiseno ?? ''}`.trim() });
    if (vars.tireDepth) kvRows.push({ label: 'Profundidad', value: `${vars.tireDepth} mm` });
    if (vars.tireAlertLevel) kvRows.push({ label: 'Nivel de alerta', value: vars.tireAlertLevel });
    if (vars.position) kvRows.push({ label: 'Posicion', value: vars.position });

    const tone = vars.tireAlertLevel === 'inmediato' ? 'danger' as const : vars.tireAlertLevel === '30d' ? 'warning' as const : 'brand' as const;

    return wrapEmail({
      preheader: `Alerta de flota — ${vars.companyName ?? 'TirePro'}`,
      accent: tone === 'danger' ? 'danger' : tone === 'warning' ? 'warning' : 'brand',
      title: 'Alerta de flota',
      eyebrow: 'Agentes TirePro',
      body: [
        kvRows.length > 0 ? emailKvList(kvRows) : '',
        emailButton('Ver en TirePro', 'https://tirepro.com.co/dashboard/resumen'),
      ].join(''),
    });
  }

  private buildCustomEmailBody(customBody: string, vars: Record<string, string>): string {
    const interpolated = this.interpolate(customBody, vars);
    const paragraphs = interpolated.split('\n').filter(l => l.trim());

    const kvRows: Array<{ label: string; value: string }> = [];
    if (vars.vehiclePlaca) kvRows.push({ label: 'Vehiculo', value: vars.vehiclePlaca });
    if (vars.tireMarca) kvRows.push({ label: 'Llanta', value: `${vars.tireMarca} ${vars.tireDiseno ?? ''}`.trim() });
    if (vars.tireDepth) kvRows.push({ label: 'Profundidad', value: `${vars.tireDepth} mm` });
    if (vars.tireAlertLevel) kvRows.push({ label: 'Nivel', value: vars.tireAlertLevel });

    return wrapEmail({
      preheader: paragraphs[0]?.slice(0, 100) ?? 'Notificacion de TirePro',
      accent: 'brand',
      title: 'Notificacion de flota',
      eyebrow: 'Agentes TirePro',
      body: [
        ...paragraphs.map(p => emailText(p)),
        kvRows.length > 0 ? emailCallout({ tone: 'info', title: 'Datos de la llanta', body: emailKvList(kvRows) }) : '',
        emailButton('Ver en TirePro', 'https://tirepro.com.co/dashboard/resumen'),
      ].join(''),
    });
  }
}
