import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { KpiMetric, KpiPeriod, Prisma } from '@prisma/client';

export interface CreateKpiDto {
  companyId:   string;
  userId?:     string | null;
  metric:      KpiMetric;
  period:      KpiPeriod;
  periodStart: string; // ISO date
  periodEnd:   string; // ISO date
  target:      number;
  notas?:      string;
}

export interface UpdateKpiDto {
  metric?:      KpiMetric;
  period?:      KpiPeriod;
  periodStart?: string;
  periodEnd?:   string;
  target?:      number;
  notas?:       string;
  userId?:      string | null;
}

/**
 * Admin-facing KPI targets. Each TeamKpi declares a per-metric target for a
 * time window, optionally scoped to a single user (null → company-wide).
 * Completion is computed on read by counting matching Inspeccion rows.
 */
@Injectable()
export class TeamKpisService {
  constructor(private readonly prisma: PrismaService) {}

  private toDate(s: string, label: string): Date {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`Invalid date for ${label}: ${s}`);
    }
    return d;
  }

  async create(dto: CreateKpiDto, createdById?: string) {
    if (!dto.companyId) throw new BadRequestException('companyId is required');
    if (!(dto.target > 0)) throw new BadRequestException('target must be > 0');
    const periodStart = this.toDate(dto.periodStart, 'periodStart');
    const periodEnd   = this.toDate(dto.periodEnd, 'periodEnd');
    if (periodEnd <= periodStart) {
      throw new BadRequestException('periodEnd must be after periodStart');
    }
    return this.prisma.teamKpi.create({
      data: {
        companyId:   dto.companyId,
        userId:      dto.userId ?? null,
        metric:      dto.metric,
        period:      dto.period,
        periodStart, periodEnd,
        target:      dto.target,
        notas:       dto.notas,
        createdById: createdById ?? null,
      },
    });
  }

  async update(id: string, dto: UpdateKpiDto) {
    const existing = await this.prisma.teamKpi.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('KPI not found');
    const data: Prisma.TeamKpiUpdateInput = {};
    if (dto.metric      !== undefined) data.metric      = dto.metric;
    if (dto.period      !== undefined) data.period      = dto.period;
    if (dto.target      !== undefined) data.target      = dto.target;
    if (dto.notas       !== undefined) data.notas       = dto.notas;
    if (dto.periodStart !== undefined) data.periodStart = this.toDate(dto.periodStart, 'periodStart');
    if (dto.periodEnd   !== undefined) data.periodEnd   = this.toDate(dto.periodEnd,   'periodEnd');
    if (dto.userId      !== undefined) {
      data.user = dto.userId
        ? { connect:    { id: dto.userId } }
        : { disconnect: true };
    }
    return this.prisma.teamKpi.update({ where: { id }, data });
  }

  async delete(id: string) {
    await this.prisma.teamKpi.delete({ where: { id } });
    return { ok: true };
  }

  /**
   * List KPIs for a company with their live progress. Two optional filters:
   *   • activeOn (ISO date) — only KPIs whose window contains this date
   *   • includeExpired (bool) — include past windows too (default false
   *     when activeOn is set, true otherwise).
   */
  async listWithProgress(companyId: string, opts?: {
    activeOn?: string;
    includeExpired?: boolean;
    userId?: string | null;
  }) {
    if (!companyId) throw new BadRequestException('companyId is required');
    const where: Prisma.TeamKpiWhereInput = { companyId };
    if (opts?.userId !== undefined) where.userId = opts.userId;
    if (opts?.activeOn) {
      const d = this.toDate(opts.activeOn, 'activeOn');
      where.periodStart = { lte: d };
      where.periodEnd   = { gte: d };
    } else if (opts?.includeExpired === false) {
      where.periodEnd = { gte: new Date() };
    }

    const kpis = await this.prisma.teamKpi.findMany({
      where,
      orderBy: [{ periodStart: 'desc' }, { metric: 'asc' }],
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    if (kpis.length === 0) return [];

    // Collect all unique windows so we can batch the inspection fetch.
    // One query covers every KPI — we filter per-KPI in memory afterwards.
    const earliest = new Date(Math.min(...kpis.map(k => k.periodStart.getTime())));
    const latest   = new Date(Math.max(...kpis.map(k => k.periodEnd.getTime())));

    const inspections = await this.prisma.inspeccion.findMany({
      where: {
        tire: { companyId },
        inspeccionadoPorId: { not: null },
        fecha: { gte: earliest, lt: latest },
      },
      select: {
        fecha:              true,
        tireId:             true,
        inspeccionadoPorId: true,
        tire: {
          select: {
            vehicleId: true,
            vehicle: { select: { companyId: true } },
          },
        },
      },
    });

    return kpis.map(kpi => {
      const inWindow = inspections.filter(
        i => i.fecha >= kpi.periodStart
          && i.fecha <  kpi.periodEnd
          && (!kpi.userId || i.inspeccionadoPorId === kpi.userId),
      );
      const tireIds    = new Set<string>();
      const vehicleIds = new Set<string>();
      const clientIds  = new Set<string>();
      for (const i of inWindow) {
        tireIds.add(i.tireId);
        if (i.tire?.vehicleId) vehicleIds.add(i.tire.vehicleId);
        if (i.tire?.vehicle?.companyId) clientIds.add(i.tire.vehicle.companyId);
      }
      const actual =
        kpi.metric === 'vehicles_inspected' ? vehicleIds.size :
        kpi.metric === 'clients_inspected'  ? clientIds.size  :
        /* tires_inspected */                 tireIds.size;
      const pct = kpi.target > 0
        ? Math.min(100, Math.round((actual / kpi.target) * 100))
        : 0;
      return { ...kpi, actual, pct };
    });
  }
}
