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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  // ===========================================================================
  // Static routes first (before :id / :companyId param routes)
  // ===========================================================================

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