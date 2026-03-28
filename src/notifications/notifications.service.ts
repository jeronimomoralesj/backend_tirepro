import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsappService } from '../whatsapp/whatsapp.service';
import { NotificationType, VidaValue } from '@prisma/client';
import * as crypto from 'crypto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsappService,
  ) {}

  // ── HMAC link signing ───────────────────────────────────────────────────────

  private generateConfirmationToken(notificationId: string): string {
    const secret = process.env.DRIVER_CONFIRM_SECRET || process.env.JWT_SECRET || 'fallback-secret';
    return crypto.createHmac('sha256', secret)
      .update(notificationId)
      .digest('hex')
      .substring(0, 16);
  }

  generateConfirmationUrl(notificationId: string): string {
    const token = this.generateConfirmationToken(notificationId);
    const base = process.env.FRONTEND_URL || 'https://tirepro.com.co';
    return `${base}/driver-action/${notificationId}?token=${token}`;
  }

  verifyConfirmationToken(notificationId: string, token: string): boolean {
    const expected = this.generateConfirmationToken(notificationId);
    if (token.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  }

  // ===========================================================================
  // CREATE
  // ===========================================================================

  async createNotification(data: {
    title:      string;
    message:    string;
    type:       'info' | 'warning' | 'critical';
    tireId?:    string;
    vehicleId?: string;
    companyId?: string;
    actionType?:    string;
    actionPayload?: Record<string, any>;
    actionLabel?:   string;
    groupKey?:      string;
    priority?:      number;
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
        tireId:    data.tireId    ?? null,
        vehicleId: data.vehicleId ?? null,
        companyId: data.companyId ?? null,
        actionType:    data.actionType    ?? null,
        actionPayload: data.actionPayload ?? undefined,
        actionLabel:   data.actionLabel   ?? null,
        groupKey:      data.groupKey      ?? null,
        priority:      data.priority      ?? 0,
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
  // ACTIONABLE
  // ===========================================================================

  async getPublicNotification(notificationId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      select: {
        id: true,
        title: true,
        message: true,
        actionLabel: true,
        executed: true,
        executedAt: true,
        driverConfirmed: true,
        driverConfirmedAt: true,
        vehicle: { select: { placa: true } },
        tire: { select: { placa: true, marca: true, posicion: true } },
      },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

  async getActionableByCompany(companyId: string) {
    return this.prisma.notification.findMany({
      where:   { companyId, executed: false },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      include: {
        tire:    { select: { placa: true, marca: true, posicion: true, alertLevel: true } },
        vehicle: { select: { placa: true, drivers: true } },
      },
    });
  }

  async executeAction(notificationId: string, executedBy: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.executed) throw new BadRequestException('Notification already executed');

    const payload = (notification.actionPayload ?? {}) as Record<string, any>;

    switch (notification.actionType) {
      case 'rotate': {
        const { tireId, toPosition } = payload;
        if (tireId && toPosition !== undefined) {
          await this.prisma.tire.update({
            where: { id: tireId },
            data:  { posicion: toPosition },
          });
        }
        break;
      }

      case 'remove_from_service': {
        const { tireId } = payload;
        if (tireId) {
          const tire = await this.prisma.tire.findUnique({
            where:  { id: tireId },
            select: { currentProfundidad: true },
          });
          await this.prisma.tire.update({
            where: { id: tireId },
            data: {
              vehicleId: null,
              posicion:  0,
              ...(tire && tire.currentProfundidad !== null && tire.currentProfundidad < 2
                ? { vidaActual: VidaValue.fin }
                : {}),
            },
          });
        }
        break;
      }

      case 'retread': {
        const { tireId } = payload;
        if (tireId) {
          await this.prisma.tire.update({
            where: { id: tireId },
            data:  { vehicleId: null, posicion: 0 },
          });
        }
        break;
      }

      // adjust_pressure, inspect, replace — informational, just mark executed
      default:
        break;
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data:  { executed: true, executedAt: new Date(), executedBy },
    });
  }

  async markSentToDriver(notificationId: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id: notificationId },
      include: {
        tire:    { select: { placa: true, posicion: true } },
        vehicle: { select: { placa: true, drivers: true } },
      },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    // Send WhatsApp to all drivers on this vehicle
    const drivers = (notification.vehicle as any)?.drivers ?? [];
    const vehiclePlaca = (notification.vehicle as any)?.placa ?? 'N/A';
    const tirePosition = String(notification.tire?.posicion ?? '?');
    const action = notification.actionLabel || notification.title || 'Revisar llanta';
    const confirmLink = this.generateConfirmationUrl(notificationId);

    for (const driver of drivers) {
      if (!driver.telefono) continue;
      try {
        await this.whatsapp.sendDriverAlert(
          driver.telefono,
          vehiclePlaca,
          tirePosition,
          action,
          confirmLink,
        );
        this.logger.log(`WhatsApp sent to driver ${driver.nombre} (${driver.telefono}) for notification ${notificationId}`);
      } catch (err: any) {
        this.logger.warn(`WhatsApp failed for driver ${driver.nombre}: ${err.message}`);
      }
    }

    return this.prisma.notification.update({
      where: { id: notificationId },
      data:  { sentToDriver: true, sentToDriverAt: new Date() },
    });
  }

  async confirmDriverAction(notificationId: string, token: string) {
    if (!this.verifyConfirmationToken(notificationId, token)) {
      throw new ForbiddenException('Invalid confirmation link');
    }

    const notification = await this.prisma.notification.findUnique({
      where:  { id: notificationId },
      select: { id: true },
    });
    if (!notification) throw new NotFoundException('Notification not found');

    return this.prisma.notification.update({
      where: { id: notificationId },
      data: {
        driverConfirmed:   true,
        driverConfirmedAt: new Date(),
        executed:          true,
        executedAt:        new Date(),
        executedBy:        'driver',
      },
    });
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