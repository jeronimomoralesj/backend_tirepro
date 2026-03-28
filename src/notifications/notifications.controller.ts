import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  BadRequestException,
  HttpCode,
  HttpStatus,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard, Public } from '../auth/guards/jwt-auth.guard';
import { CompanyScopeGuard } from '../auth/guards/company-scope.guard';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard, CompanyScopeGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // ===========================================================================
  // Static routes first (before :id / :companyId param routes)
  // ===========================================================================

  /**
   * GET /notifications/actionable?companyId=xxx
   * Unexecuted notifications with action metadata — for one-click resolution UI.
   */
  @Get('actionable')
  getActionable(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.notificationsService.getActionableByCompany(companyId);
  }

  /**
   * POST /notifications/by-companies
   * Distributor dashboard — aggregates across multiple companies.
   */
  @Post('by-companies')
  @HttpCode(HttpStatus.OK)
  getByCompanies(@Body() body: { companyIds: string[] }) {
    if (!body.companyIds?.length) {
      throw new BadRequestException('companyIds required');
    }
    return this.notificationsService.getByCompanyIds(body.companyIds);
  }

  /**
   * GET /notifications/public/:id
   * Public — used by driver confirmation pages (no JWT required).
   */
  @Public()
  @Get('public/:id')
  getPublicNotification(@Param('id') id: string) {
    return this.notificationsService.getPublicNotification(id);
  }

  /**
   * GET /notifications?companyId=xxx
   * Rich list with tire + vehicle — used by dashboards.
   */
  @Get()
  getByCompany(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.notificationsService.getByCompany(companyId);
  }

  /**
   * GET /notifications/unseen?companyId=xxx
   * Unseen notifications only — for badge counts.
   */
  @Get('unseen')
  getUnseen(@Query('companyId') companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');
    return this.notificationsService.getUnseen(companyId);
  }

  // ===========================================================================
  // Param routes
  // ===========================================================================

  /**
   * GET /notifications/:companyId
   * Simple list — kept for legacy dashboard compatibility.
   */
  @Get(':companyId')
  getAll(@Param('companyId') companyId: string) {
    return this.notificationsService.getAll(companyId);
  }

  /**
   * PATCH /notifications/seen/:id
   * Mark single notification as seen.
   */
  @Patch('seen/:id')
  markAsSeen(@Param('id') id: string) {
    return this.notificationsService.markAsSeen(id);
  }

  /**
   * PATCH /notifications/seen-all/:companyId
   * Mark all company notifications as seen.
   */
  @Patch('seen-all/:companyId')
  markAllSeen(@Param('companyId') companyId: string) {
    return this.notificationsService.markAllSeenByCompany(companyId);
  }

  /**
   * PATCH /notifications/:id/execute
   * Execute the action associated with a notification.
   */
  @Patch(':id/execute')
  execute(
    @Param('id') id: string,
    @Body() body: { executedBy: string },
  ) {
    return this.notificationsService.executeAction(id, body.executedBy);
  }

  /**
   * PATCH /notifications/:id/send-to-driver
   * Mark that the notification was sent to a driver.
   */
  @Patch(':id/send-to-driver')
  sendToDriver(@Param('id') id: string) {
    return this.notificationsService.markSentToDriver(id);
  }

  /**
   * PATCH /notifications/:id/driver-confirm
   * Public — called from driver confirmation link (no JWT required).
   */
  @Public()
  @Patch(':id/driver-confirm')
  driverConfirm(
    @Param('id') id: string,
    @Query('token') token: string,
  ) {
    if (!token) throw new BadRequestException('Missing confirmation token');
    return this.notificationsService.confirmDriverAction(id, token);
  }

  /**
   * DELETE /notifications/:id
   * Delete a single notification.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  deleteOne(@Param('id') id: string) {
    return this.notificationsService.deleteById(id);
  }

  /**
   * DELETE /notifications/all/:companyId
   * Clear all notifications for a company.
   */
  @Delete('all/:companyId')
  @HttpCode(HttpStatus.OK)
  deleteAll(@Param('companyId') companyId: string) {
    return this.notificationsService.deleteAllByCompany(companyId);
  }
}