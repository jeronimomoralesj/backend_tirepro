// src/notifications/notifications.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

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

  async getAll(companyId: string) {
    return this.prisma.notification.findMany({
      where: { companyId },
      orderBy: { timestamp: 'desc' },
    });
  }

  async markAsSeen(id: string) {
    return this.prisma.notification.update({
      where: { id },
      data: { seen: true },
    });
  }

async getByCompanyId(companyId: string) {
  return this.prisma.notification.findMany({
    where: { companyId },
    orderBy: { timestamp: 'desc' },
  });
}

async getByCompany(companyId: string) {
return this.prisma.notification.findMany({
  where: { companyId },
  orderBy: { timestamp: 'desc' },
  include: {
    tire: {
      select: { placa: true },
    },
    vehicle: {
      select: { placa: true },
    },
  },
});
}

async deleteByTire(tireId: string) {
  await this.prisma.notification.deleteMany({
    where: { tireId },
  });
}

}
