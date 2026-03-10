import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationType } from '@prisma/client';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ===========================================================================
  // CREATE
  // ===========================================================================

  async createNotification(data: {
    title:     string;
    message:   string;
    type:      'info' | 'warning' | 'critical';
    tireId?:   string;
    vehicleId?: string;
    companyId?: string;
  }) {
    // Map string literal → NotificationType enum
    const typeMap: Record<string, NotificationType> = {
      info:     NotificationType.info,
      warning:  NotificationType.warning,
      critical: NotificationType.critical,
    };

    return this.prisma.notification.create({
      data: {
        title:     data.title,
        message:   data.message,
        type:      typeMap[data.type] ?? NotificationType.info,
        seen:      false,
        // createdAt is set automatically by the schema @default(now())
        tireId:    data.tireId    ?? null,
        vehicleId: data.vehicleId ?? null,
        companyId: data.companyId ?? null,
      },
    });
  }

  // ===========================================================================
  // READ
  // ===========================================================================

  /**
   * Simple list by company — used by existing company dashboards.
   * orderBy: createdAt (replaces removed `timestamp` field)
   */
  async getAll(companyId: string) {
    return this.prisma.notification.findMany({
      where:   { companyId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Rich list with tire + vehicle placa — used by older dashboards.
   */
  async getByCompany(companyId: string) {
    return this.prisma.notification.findMany({
      where:   { companyId },
      orderBy: { createdAt: 'desc' },
      include: {
        tire:    { select: { placa: true, marca: true, alertLevel: true } },
        vehicle: { select: { placa: true } },
      },
    });
  }

  /**
   * Unseen notifications only — used by notification badges.
   */
  async getUnseen(companyId: string) {
    return this.prisma.notification.findMany({
      where:   { companyId, seen: false },
      orderBy: { createdAt: 'desc' },
      include: {
        tire:    { select: { placa: true, alertLevel: true } },
        vehicle: { select: { placa: true } },
      },
    });
  }

  /**
   * Distributor dashboard — aggregates notifications across multiple companies.
   */
  async getByCompanyIds(companyIds: string[]) {
    return this.prisma.notification.findMany({
      where:   { companyId: { in: companyIds } },
      orderBy: { createdAt: 'desc' },
      include: {
        company: { select: { id: true, name: true } },
        vehicle: { select: { id: true, placa: true } },
        tire:    { select: { placa: true, alertLevel: true } },
      },
    });
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  async markAsSeen(id: string) {
    const notification = await this.prisma.notification.findUnique({
      where:  { id },
      select: { id: true },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    return this.prisma.notification.update({
      where: { id },
      data:  { seen: true },
    });
  }

  async markAllSeenByCompany(companyId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { companyId, seen: false },
      data:  { seen: true },
    });
    return { message: `${count} notifications marked as seen` };
  }

  // ===========================================================================
  // DELETE
  // ===========================================================================

  async deleteByTire(tireId: string) {
    await this.prisma.notification.deleteMany({ where: { tireId } });
  }

  async deleteById(id: string) {
    const notification = await this.prisma.notification.findUnique({
      where:  { id },
      select: { id: true },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    await this.prisma.notification.delete({ where: { id } });
    return { message: 'Notification deleted' };
  }

  async deleteAllByCompany(companyId: string) {
    const { count } = await this.prisma.notification.deleteMany({
      where: { companyId },
    });
    return { message: `${count} notifications deleted` };
  }
}