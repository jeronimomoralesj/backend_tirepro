import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { GoogleCalendarService } from '../integrations/google-calendar/google-calendar.service';
import { AutomationFlow, ActionType, FlowStatus, Prisma } from '@prisma/client';
import {
  wrapEmail, emailText, emailKvList, emailButton, emailCallout,
  emailDataTable, emailBarChart, emailPieList, emailGauge, emailMetricRow,
  emailDivider, emailLabel,
} from '../email/email-templates';

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
    const vars = await this.buildTemplateVars(ctx);

    // Build the action queue: primary action + up to 2 additional actions.
    const queue: Array<{ actionType: ActionType; actionConfig: Record<string, unknown> }> = [
      { actionType: flow.actionType, actionConfig: (flow.actionConfig as Record<string, unknown>) ?? {} },
    ];
    const extras = Array.isArray(flow.additionalActions) ? (flow.additionalActions as unknown[]) : [];
    for (const extra of extras.slice(0, 2)) {
      if (!extra || typeof extra !== 'object') continue;
      const e = extra as { actionType?: string; actionConfig?: Record<string, unknown> };
      if (!e.actionType || !(e.actionType in ActionType)) continue;
      queue.push({
        actionType: e.actionType as ActionType,
        actionConfig: e.actionConfig ?? {},
      });
    }

    const outputs: Record<string, unknown>[] = [];
    const errors: string[] = [];

    for (let i = 0; i < queue.length; i++) {
      const { actionType, actionConfig } = queue[i];
      try {
        const out = await this.runSingleAction(actionType, actionConfig, flow, vars, ctx);
        outputs.push({ step: i + 1, actionType, ...out });
      } catch (err: any) {
        const msg = err.message ?? 'Unknown error';
        errors.push(`[${i + 1}/${queue.length} ${actionType}] ${msg}`);
        outputs.push({ step: i + 1, actionType, error: msg });
        this.logger.error(`Flow ${flow.id} step ${i + 1} (${actionType}) failed: ${msg}`, err.stack);
      }
    }

    const success = errors.length === 0;
    const error = errors.length > 0 ? errors.join(' | ') : null;

    await this.prisma.flowRun.create({
      data: {
        flowId: flow.id,
        triggerPayload: ctx as unknown as Prisma.InputJsonValue,
        success,
        output: ({ steps: outputs } as unknown) as Prisma.InputJsonValue,
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

  private async runSingleAction(
    actionType: ActionType,
    config: Record<string, unknown>,
    flow: AutomationFlow,
    vars: Record<string, string>,
    ctx: ActionContext,
  ): Promise<Record<string, unknown>> {
    switch (actionType) {
      case ActionType.send_email: {
        const rawTo = this.interpolate((config.to as string) ?? '', vars);
        const recipients = rawTo.split(',').map(e => e.trim()).filter(Boolean);
        const subject = this.interpolate(
          (config.subject as string) ?? 'Alerta TirePro',
          vars,
        );
        const customBody = config.body as string | undefined;
        const reportBlocks = config.reportBlocks as unknown[] | undefined;
        const isScheduledReport = flow.triggerType === 'scheduled_cron' || !!reportBlocks?.length;
        let body: string;
        if (isScheduledReport) {
          body = await this.buildFleetReportEmail(ctx.companyId, customBody ?? '', vars, reportBlocks);
        } else if (customBody) {
          body = this.buildCustomEmailBody(customBody, vars);
        } else {
          body = this.buildEmailBody(vars);
        }
        for (const to of recipients.length ? recipients : [rawTo]) {
          await this.emailService.sendEmail(to, subject, body);
        }
        return { to: recipients, subject };
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
        return { to, sent };
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
        return { created: true };
      }

      case ActionType.create_calendar_event: {
        if (!this.googleCalendar) throw new Error('Google Calendar not configured');
        const calConfig = config;
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

        const attendees = Array.isArray(calConfig.attendees)
          ? (calConfig.attendees as string[]).filter(e => typeof e === 'string' && e.includes('@'))
          : [];
        const location = typeof calConfig.location === 'string' ? calConfig.location : undefined;

        const eventId = await this.googleCalendar.createEvent(ctx.companyId, {
          summary: title,
          description,
          startTime,
          durationMinutes: (calConfig.durationMinutes as number) ?? 60,
          ...(attendees.length > 0 && { attendees }),
          ...(location && { location }),
        });
        return { eventId, tireCount: allTireVars.length, attendees };
      }

      case ActionType.make_phone_call:
        this.logger.warn('Phone calls not yet implemented (Phase 4)');
        return { skipped: true, reason: 'not_implemented' };

      default:
        throw new Error(`Unknown action type: ${actionType}`);
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
    const interpolated = customBody ? this.interpolate(customBody, vars) : '';
    const paragraphs = interpolated.split('\n').filter(l => l.trim());

    const bodyParts: string[] = [];

    if (paragraphs.length > 0) {
      bodyParts.push(...paragraphs.map(p => emailText(p)));
    }

    if (bodyParts.length === 0) {
      const kvRows: Array<{ label: string; value: string }> = [];
      if (vars.vehiclePlaca) kvRows.push({ label: 'Vehiculo', value: vars.vehiclePlaca });
      if (vars.tireMarca) kvRows.push({ label: 'Llanta', value: `${vars.tireMarca} ${vars.tireDiseno ?? ''}`.trim() });
      if (vars.tireDepth) kvRows.push({ label: 'Profundidad', value: `${vars.tireDepth} mm` });
      if (vars.tireAlertLevel) kvRows.push({ label: 'Nivel', value: vars.tireAlertLevel });
      if (kvRows.length > 0) bodyParts.push(emailCallout({ tone: 'info', title: 'Datos de la llanta', body: emailKvList(kvRows) }));
    }

    bodyParts.push(emailButton('Ver en TirePro', 'https://tirepro.com.co/dashboard/resumen'));

    return wrapEmail({
      preheader: paragraphs[0]?.slice(0, 100) ?? 'Reporte de TirePro',
      accent: 'brand',
      title: 'Notificacion de flota',
      eyebrow: 'Agentes TirePro',
      body: bodyParts.join(''),
    });
  }

  private async buildFleetReportEmail(
    companyId: string,
    customBody: string,
    vars: Record<string, string>,
    reportBlocks?: unknown[],
  ): Promise<string> {
    const tires = await this.prisma.tire.findMany({
      where: { companyId },
      select: {
        marca: true,
        diseno: true,
        eje: true,
        vidaActual: true,
        currentProfundidad: true,
        currentCpk: true,
        lifetimeCpk: true,
        healthScore: true,
        alertLevel: true,
        kilometrosRecorridos: true,
        posicion: true,
        vehicle: { select: { placa: true, tipovhc: true } },
        costos: { select: { valor: true } },
      },
    });

    const bodyParts: string[] = [];

    if (customBody) {
      const interpolated = this.interpolate(customBody, vars);
      const paragraphs = interpolated.split('\n').filter(l => l.trim());
      bodyParts.push(...paragraphs.map(p => emailText(p)));
    }

    if (!tires.length) {
      bodyParts.push(emailCallout({ tone: 'info', title: 'Sin datos', body: emailText('No hay llantas registradas en la flota.') }));
      bodyParts.push(emailButton('Ver en TirePro', 'https://tirepro.com.co/dashboard/resumen'));
      return wrapEmail({ preheader: 'Reporte de flota', accent: 'brand', title: 'Reporte de flota', eyebrow: 'Agentes TirePro', body: bodyParts.join('') });
    }

    const fc = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`;
    const alertInm = tires.filter(t => t.currentProfundidad != null && t.currentProfundidad <= 2).length;
    const alert30 = tires.filter(t => t.currentProfundidad != null && t.currentProfundidad > 2 && t.currentProfundidad <= 4).length;
    const alert60 = tires.filter(t => t.currentProfundidad != null && t.currentProfundidad > 4 && t.currentProfundidad <= 6).length;
    const alertOpt = tires.length - alertInm - alert30 - alert60;
    const totalCost = tires.reduce((s, t) => s + t.costos.reduce((a, c) => a + (c.valor || 0), 0), 0);
    const totalKm = tires.reduce((s, t) => s + (t.kilometrosRecorridos || 0), 0);
    const profValues = tires.map(t => t.currentProfundidad).filter((p): p is number => p != null);
    const healthValues = tires.map(t => t.healthScore).filter((h): h is number => h != null);
    const avgProf = profValues.length ? (profValues.reduce((a, b) => a + b, 0) / profValues.length) : 0;
    const avgHealth = healthValues.length ? Math.round(healthValues.reduce((a, b) => a + b, 0) / healthValues.length) : 0;
    const fleetCpk = totalKm > 0 && totalCost > 0 ? (totalCost / totalKm) : 0;

    // -- KPI metrics row
    const metrics: { label: string; value: string; tone?: 'good' | 'warn' | 'bad' | 'neutral' }[] = [
      { label: 'Llantas', value: String(tires.length) },
      { label: 'Salud', value: `${avgHealth}/100`, tone: avgHealth >= 70 ? 'good' : avgHealth >= 40 ? 'warn' : 'bad' },
      { label: 'Prof. Prom.', value: `${avgProf.toFixed(1)}mm`, tone: avgProf >= 6 ? 'good' : avgProf >= 3 ? 'warn' : 'bad' },
    ];
    if (fleetCpk > 0) metrics.push({ label: 'CPK Flota', value: `$${fleetCpk.toFixed(1)}/km` });
    bodyParts.push(emailMetricRow(metrics));

    // -- Alert distribution (pie-style list)
    if (alertInm > 0 || alert30 > 0) {
      const alertData: { label: string; value: number; color: string }[] = [];
      if (alertInm > 0) alertData.push({ label: 'Cambio inmediato', value: alertInm, color: '#ef4444' });
      if (alert30 > 0) alertData.push({ label: 'Alerta 30 dias', value: alert30, color: '#f59e0b' });
      if (alert60 > 0) alertData.push({ label: 'Alerta 60 dias', value: alert60, color: '#0ea5e9' });
      alertData.push({ label: 'Optimo', value: alertOpt, color: '#10b981' });
      bodyParts.push(emailPieList({ title: 'Distribucion de alertas', data: alertData }));
    }

    // -- Critical tires table
    const criticals = tires
      .filter(t => t.currentProfundidad != null && t.currentProfundidad <= 4)
      .sort((a, b) => (a.currentProfundidad ?? 99) - (b.currentProfundidad ?? 99))
      .slice(0, 15);
    if (criticals.length > 0) {
      bodyParts.push(emailCallout({
        tone: alertInm > 0 ? 'danger' : 'warning',
        title: `${alertInm + alert30} llantas requieren atencion`,
        body: emailText(alertInm > 0 ? `${alertInm} necesitan cambio inmediato.` : `${alert30} en alerta a 30 dias.`),
      }));
      bodyParts.push(emailDataTable({
        title: 'Llantas criticas',
        columns: ['Vehiculo', 'Posicion', 'Prof.', 'Marca', 'Estado'],
        rows: criticals.map(t => [
          t.vehicle?.placa || 'N/A',
          String(t.posicion || '-'),
          `${t.currentProfundidad?.toFixed(1) ?? '?'}mm`,
          `${t.marca} ${t.diseno || ''}`.trim(),
          t.currentProfundidad != null && t.currentProfundidad <= 2 ? 'INMEDIATO' : '30 dias',
        ]),
        highlightCol: 2,
      }));
    }

    // -- CPK by brand (bar chart)
    const byBrand: Record<string, { n: number; cpkSum: number; cpkCount: number }> = {};
    for (const t of tires) {
      const b = t.marca || 'Otro';
      if (!byBrand[b]) byBrand[b] = { n: 0, cpkSum: 0, cpkCount: 0 };
      byBrand[b].n++;
      const cpk = t.lifetimeCpk ?? t.currentCpk;
      if (cpk != null && cpk > 0) { byBrand[b].cpkSum += cpk; byBrand[b].cpkCount++; }
    }
    const brandData = Object.entries(byBrand)
      .filter(([, v]) => v.cpkCount > 0)
      .sort((a, b) => a[1].cpkSum / a[1].cpkCount - b[1].cpkSum / b[1].cpkCount)
      .slice(0, 8)
      .map(([brand, v]) => ({ label: `${brand} (${v.n})`, value: Math.round(v.cpkSum / v.cpkCount) }));
    if (brandData.length > 1) {
      bodyParts.push(emailBarChart({ title: 'CPK por marca', unit: '$/km', data: brandData }));
    }

    // -- Tires by axle (pie list)
    const byEje: Record<string, number> = {};
    for (const t of tires) { byEje[t.eje || 'otro'] = (byEje[t.eje || 'otro'] || 0) + 1; }
    if (Object.keys(byEje).length > 1) {
      bodyParts.push(emailPieList({
        title: 'Distribucion por eje',
        data: Object.entries(byEje).sort((a, b) => b[1] - a[1]).map(([eje, n]) => ({ label: eje, value: n })),
      }));
    }

    // -- Tires by vida (pie list)
    const byVida: Record<string, number> = {};
    for (const t of tires) { byVida[t.vidaActual || 'nueva'] = (byVida[t.vidaActual || 'nueva'] || 0) + 1; }
    if (Object.keys(byVida).length > 1) {
      bodyParts.push(emailPieList({
        title: 'Distribucion por vida',
        data: Object.entries(byVida).sort((a, b) => b[1] - a[1]).map(([vida, n]) => ({ label: vida, value: n })),
      }));
    }

    // -- Vehicles with most critical tires
    const vehCritMap: Record<string, { placa: string; tipo: string; crit: number; total: number }> = {};
    for (const t of tires) {
      if (!t.vehicle?.placa) continue;
      const p = t.vehicle.placa;
      if (!vehCritMap[p]) vehCritMap[p] = { placa: p, tipo: t.vehicle.tipovhc || '-', crit: 0, total: 0 };
      vehCritMap[p].total++;
      if (t.currentProfundidad != null && t.currentProfundidad <= 4) vehCritMap[p].crit++;
    }
    const topVeh = Object.values(vehCritMap).filter(v => v.crit > 0).sort((a, b) => b.crit - a.crit).slice(0, 8);
    if (topVeh.length > 0) {
      bodyParts.push(emailDataTable({
        title: 'Vehiculos con llantas criticas',
        columns: ['Placa', 'Tipo', 'Criticas', 'Total'],
        rows: topVeh.map(v => [v.placa, v.tipo, String(v.crit), String(v.total)]),
        highlightCol: 2,
      }));
    }

    // -- Investment summary
    if (totalCost > 0) {
      bodyParts.push(emailKvList([
        { label: 'Inversion total', value: fc(totalCost), bold: true },
        { label: 'Km totales', value: totalKm >= 1e6 ? `${(totalKm / 1e6).toFixed(1)}M` : `${(totalKm / 1e3).toFixed(0)}K` },
        { label: 'CPK promedio flota', value: fleetCpk > 0 ? `$${fleetCpk.toFixed(1)}/km` : 'N/A' },
      ]));
    }

    bodyParts.push(emailDivider());
    bodyParts.push(emailText(`Reporte generado el ${new Date().toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' })}.`));
    bodyParts.push(emailButton('Ver dashboard completo', 'https://tirepro.com.co/dashboard/resumen'));

    const accent = alertInm > 0 ? 'danger' as const : alert30 > 0 ? 'warning' as const : 'brand' as const;
    return wrapEmail({
      preheader: `Flota: ${tires.length} llantas, ${alertInm + alert30} requieren atencion — ${vars.companyName ?? 'TirePro'}`,
      accent,
      title: 'Reporte de flota',
      eyebrow: 'Agentes TirePro',
      subtitle: vars.companyName ? `${vars.companyName} — ${new Date().toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' })}` : undefined,
      body: bodyParts.join(''),
    });
  }
}
