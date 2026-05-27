import {
  Controller,
  Get,
  Delete,
  Query,
  Req,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard, Public } from '../../auth/guards/jwt-auth.guard';
import { GoogleCalendarService } from './google-calendar.service';

type AuthReq = { user?: { companyId?: string; role?: string } };

@Controller('integrations/google')
export class GoogleCalendarController {
  constructor(private readonly svc: GoogleCalendarService) {}

  @Get('auth')
  @UseGuards(JwtAuthGuard)
  getAuthUrl(@Req() req: AuthReq) {
    const companyId = req.user?.companyId;
    if (!companyId) throw new BadRequestException('No company');
    if (req.user?.role !== 'admin') throw new BadRequestException('Admin only');
    if (!this.svc.isConfigured()) throw new BadRequestException('Google Calendar not configured');
    return { url: this.svc.getAuthUrl(companyId) };
  }

  @Get('callback')
  @Public()
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    if (!code || !state) {
      res.redirect('https://tirepro.com.co/chat/agentes?error=missing_params');
      return;
    }
    try {
      const { companyId } = JSON.parse(Buffer.from(state, 'base64url').toString());
      await this.svc.handleCallback(code, companyId);
      res.redirect('https://tirepro.com.co/chat/agentes?connected=google_calendar');
    } catch {
      res.redirect('https://tirepro.com.co/chat/agentes?error=oauth_failed');
    }
  }

  @Delete('disconnect')
  @UseGuards(JwtAuthGuard)
  async disconnect(@Req() req: AuthReq) {
    const companyId = req.user?.companyId;
    if (!companyId) throw new BadRequestException('No company');
    if (req.user?.role !== 'admin') throw new BadRequestException('Admin only');
    await this.svc.disconnect(companyId);
    return { disconnected: true };
  }
}
