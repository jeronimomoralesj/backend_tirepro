// src/notifications/notifications.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * LEGACY — Used by existing company dashboards
   * GET /notifications/:companyId
   */
  @Get(':companyId')
  async getAll(@Param('companyId') companyId: string) {
    return this.notificationsService.getAll(companyId);
  }

  /**
   * LEGACY — Mark notification as seen
   * PATCH /notifications/seen/:id
   */
  @Patch('seen/:id')
  async markAsSeen(@Param('id') id: string) {
    return this.notificationsService.markAsSeen(id);
  }

  /**
   * LEGACY — Used in older dashboards
   * GET /notifications?companyId=xxx
   */
  @Get()
  async getByCompany(@Query('companyId') companyId: string) {
    if (!companyId) {
      throw new BadRequestException('Missing companyId');
    }

    return this.notificationsService.getByCompany(companyId);
  }

  /**
   * NEW — Distributor dashboard
   * POST /notifications/by-companies
   */
  @Post('by-companies')
  async getByCompanies(@Body() body: { companyIds: string[] }) {
    if (!body.companyIds || body.companyIds.length === 0) {
      throw new BadRequestException('companyIds required');
    }

    return this.notificationsService.getByCompanyIds(body.companyIds);
  }
}
