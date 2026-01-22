// src/notifications/notifications.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  /**
   * LEGACY — Create notification
   */
  async createNotification(data: {
    title: string;
    message: string;
    type: 'info' | 'warning' | 'critical';
    tireId?: string;
    vehicleId?: string;
    companyId?: string;
  }) {
    return this.prisma.notification.create({
      data: {
        ...data,
        seen: false,
        timestamp: new Date(),
      },
    });
  }

  /**
   * LEGACY — Simple list by company
   */
  async getAll(companyId: string) {
    return this.prisma.notification.findMany({
      where: { companyId },
      orderBy: { timestamp: 'desc' },
    });
  }

  /**
   * LEGACY — Mark as seen
   */
  async markAsSeen(id: string) {
    return this.prisma.notification.update({
      where: { id },
      data: { seen: true },
    });
  }

  /**
   * LEGACY — Older dashboards depend on this
   */
  async getByCompany(companyId: string) {
    return this.prisma.notification.findMany({
      where: { companyId },
      orderBy: { timestamp: 'desc' },
      include: {
        tire: { select: { placa: true } },
        vehicle: { select: { placa: true } },
      },
    });
  }

  /**
   * NEW — Distributor dashboard aggregation
   * Returns ONLY unseen notifications
   */
async getByCompanyIds(companyIds: string[]) {
    return this.prisma.notification.findMany({
      where: { companyId: { in: companyIds } },
      orderBy: { timestamp: 'desc' },
      include: {
        company: true, // include company info
        vehicle: {
          select: {
            id: true,
            placa: true, // include vehicle plate
          },
        },
      },
    });
  }

  /**
   * LEGACY — Cleanup helper
   */
  async deleteByTire(tireId: string) {
    await this.prisma.notification.deleteMany({
      where: { tireId },
    });
  }
}
