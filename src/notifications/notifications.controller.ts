// src/notifications/notifications.controller.ts
import { BadRequestException, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get(':companyId')
  async getAll(@Param('companyId') companyId: string) {
    return this.notificationsService.getAll(companyId);
  }

  @Patch('seen/:id')
  async markAsSeen(@Param('id') id: string) {
    return this.notificationsService.markAsSeen(id);
  }

  @Get()
async getByCompany(@Query('companyId') companyId: string) {
  if (!companyId) throw new BadRequestException("Missing companyId");
  return this.notificationsService.getByCompanyId(companyId);
}

@Get()
getCompanyNotifications(@Query('companyId') companyId: string) {
  return this.notificationsService.getByCompany(companyId);
}

}
