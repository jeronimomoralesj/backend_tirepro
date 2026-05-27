import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { GoogleCalendarService } from '../integrations/google-calendar/google-calendar.service';
import { AutomationFlow, ActionType, FlowStatus, Prisma } from '@prisma/client';

export interface ActionContext {
  tireId?: string;
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
          const body = this.buildEmailBody(vars);
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
          const title = this.interpolate((calConfig.title as string) ?? 'Cita TirePro — {{vehiclePlaca}}', vars);
          const eventId = await this.googleCalendar.createEvent(ctx.companyId, {
            summary: title,
            description: `Generado por Agentes TirePro.\n${vars.tireMarca ? `Llanta: ${vars.tireMarca} ${vars.tireDiseno ?? ''} — ${vars.tireDepth ?? '?'}mm` : ''}`,
            durationMinutes: (calConfig.durationMinutes as number) ?? 60,
          });
          output = { eventId };
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
    const lines = [
      `<h2 style="margin:0 0 12px;color:#0A183A;">Alerta de flota</h2>`,
    ];

    if (vars.vehiclePlaca)
      lines.push(`<p><strong>Vehículo:</strong> ${vars.vehiclePlaca}</p>`);
    if (vars.tirePlaca)
      lines.push(`<p><strong>Llanta:</strong> ${vars.tirePlaca}</p>`);
    if (vars.tireMarca)
      lines.push(
        `<p><strong>Marca/Diseño:</strong> ${vars.tireMarca} ${vars.tireDiseno ?? ''}</p>`,
      );
    if (vars.tireDepth)
      lines.push(`<p><strong>Profundidad:</strong> ${vars.tireDepth} mm</p>`);
    if (vars.tireAlertLevel)
      lines.push(
        `<p><strong>Nivel:</strong> ${vars.tireAlertLevel}</p>`,
      );
    lines.push(
      `<p style="margin-top:16px"><a href="https://tirepro.com.co/dashboard/resumen" style="background:#0A183A;color:white;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:bold;">Ver en TirePro</a></p>`,
    );
    lines.push(
      `<p style="margin-top:16px;font-size:12px;color:#666;">Generado por Agentes TirePro — ${vars.date ?? ''}</p>`,
    );

    return lines.join('\n');
  }
}
