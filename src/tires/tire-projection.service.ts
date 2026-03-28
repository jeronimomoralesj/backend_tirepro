import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TireAlertLevel } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class TireProjectionService {
  private readonly logger = new Logger(TireProjectionService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async updateAllProjections() {
    this.logger.log('Starting daily tire projection update...');

    const tires = await this.prisma.tire.findMany({
      where: {
        vehicleId: { not: null },
        vidaActual: { not: 'fin' },
        lastInspeccionDate: { not: null },
      },
      select: {
        id: true,
        profundidadInicial: true,
        currentProfundidad: true,
        lastInspeccionDate: true,
        vidaActual: true,
        marca: true,
        diseno: true,
        dimension: true,
        inspecciones: {
          orderBy: { fecha: 'desc' },
          take: 5,
          select: { fecha: true, profundidadInt: true, profundidadCen: true, profundidadExt: true },
        },
      },
    });

    let updated = 0;
    const now = new Date();

    for (const tire of tires) {
      try {
        const degradationRate = await this.computeDegradationRate(tire);
        if (degradationRate === null || degradationRate <= 0) continue;

        const daysSinceInspection = Math.max(0,
          (now.getTime() - new Date(tire.lastInspeccionDate!).getTime()) / 86400000,
        );

        const lastDepth = tire.currentProfundidad ?? tire.profundidadInicial;
        const projectedDepth = Math.max(0, lastDepth - degradationRate * daysSinceInspection);

        const mmToLimit = Math.max(0, projectedDepth - 2);
        const daysToLimit = degradationRate > 0 ? Math.round(mmToLimit / degradationRate) : 9999;

        const projectedAlert = this.deriveAlertFromDepth(projectedDepth, tire.profundidadInicial);
        const projectedHealth = this.computeHealthFromDepth(projectedDepth, tire.profundidadInicial);

        await this.prisma.tire.update({
          where: { id: tire.id },
          data: {
            projectedProfundidad: Math.round(projectedDepth * 100) / 100,
            projectedAlertLevel: projectedAlert,
            projectedHealthScore: projectedHealth,
            projectedDaysToLimit: daysToLimit,
            degradationRateMmPerDay: Math.round(degradationRate * 10000) / 10000,
            projectionUpdatedAt: now,
          },
        });
        updated++;
      } catch (err: any) {
        this.logger.warn(`Failed projection for tire ${tire.id}: ${err.message}`);
      }
    }

    this.logger.log(`Projection update complete: ${updated}/${tires.length} tires updated`);
  }

  /**
   * Compute degradation rate in mm/day.
   * Method 1: Actual inspection history (most accurate)
   * Method 2: TireBenchmark from master catalog (industry data for this SKU)
   * Method 3: TireMasterCatalog km estimates (2,500+ SKUs)
   * Method 4: Conservative fallback
   */
  private async computeDegradationRate(tire: any): Promise<number | null> {
    const inspections = tire.inspecciones ?? [];
    const KM_PER_DAY = 6000 / 30; // ~200 km/day average for Colombian fleets

    // Method 1: Use actual inspection history
    if (inspections.length >= 2) {
      const newest = inspections[0];
      const oldest = inspections[inspections.length - 1];

      const depthNewest = (newest.profundidadInt + newest.profundidadCen + newest.profundidadExt) / 3;
      const depthOldest = (oldest.profundidadInt + oldest.profundidadCen + oldest.profundidadExt) / 3;
      const daysBetween = (new Date(newest.fecha).getTime() - new Date(oldest.fecha).getTime()) / 86400000;

      if (daysBetween > 7 && depthOldest > depthNewest) {
        return (depthOldest - depthNewest) / daysBetween;
      }
    }

    // Method 2: Use TireBenchmark aggregated data
    const benchmark = await this.prisma.tireBenchmark.findFirst({
      where: {
        marca: { equals: tire.marca, mode: 'insensitive' },
        diseno: { equals: tire.diseno, mode: 'insensitive' },
        dimension: { equals: tire.dimension, mode: 'insensitive' },
      },
      select: { avgKmPorVida: true, avgMmDesgaste: true, avgDesgastePor1000km: true },
    });

    if (benchmark?.avgDesgastePor1000km && benchmark.avgDesgastePor1000km > 0) {
      return (benchmark.avgDesgastePor1000km / 1000) * KM_PER_DAY;
    }

    if (benchmark?.avgKmPorVida && benchmark?.avgMmDesgaste && benchmark.avgKmPorVida > 0) {
      const daysPerVida = benchmark.avgKmPorVida / KM_PER_DAY;
      return benchmark.avgMmDesgaste / daysPerVida;
    }

    // Method 3: Use TireMasterCatalog (2,500+ SKUs from master.xlsx)
    const catalog = await this.prisma.tireMasterCatalog.findFirst({
      where: {
        marca: { equals: tire.marca, mode: 'insensitive' },
        dimension: { equals: tire.dimension, mode: 'insensitive' },
      },
      select: { kmEstimadosReales: true, rtdMm: true },
    });

    if (catalog?.kmEstimadosReales && catalog?.rtdMm && catalog.kmEstimadosReales > 0) {
      const totalWear = catalog.rtdMm - 2; // RTD to legal limit
      const daysForLife = catalog.kmEstimadosReales / KM_PER_DAY;
      if (daysForLife > 0 && totalWear > 0) {
        return totalWear / daysForLife;
      }
    }

    // Method 4: Conservative fallback
    const totalWear = (tire.profundidadInicial ?? 14) - 2;
    return totalWear / 365;
  }

  private deriveAlertFromDepth(depth: number, initial: number): TireAlertLevel {
    if (depth <= 2) return TireAlertLevel.critical;
    if (depth <= 4) return TireAlertLevel.warning;
    const ratio = depth / initial;
    if (ratio <= 0.35) return TireAlertLevel.watch;
    return TireAlertLevel.ok;
  }

  private computeHealthFromDepth(depth: number, initial: number): number {
    const ratio = Math.max(0, Math.min(1, (depth - 2) / (initial - 2)));
    return Math.round(ratio * 100);
  }
}
