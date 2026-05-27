import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../../prisma/prisma.service';
import { encrypt, decrypt } from '../../common/crypto';

export interface CalendarEventOpts {
  summary: string;
  description?: string;
  startTime?: Date;
  durationMinutes?: number;
  calendarId?: string;
  attendees?: string[];
  location?: string;
}

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.clientId = config.get<string>('GOOGLE_CLIENT_ID') ?? '';
    this.clientSecret = config.get<string>('GOOGLE_CLIENT_SECRET') ?? '';
    this.redirectUri =
      config.get<string>('GOOGLE_REDIRECT_URI') ??
      'https://api.tirepro.com.co/api/integrations/google/callback';
  }

  private makeOAuth2(): OAuth2Client {
    return new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
  }

  isConfigured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  getAuthUrl(companyId: string): string {
    const client = this.makeOAuth2();
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/calendar.events',
        'https://www.googleapis.com/auth/userinfo.email',
      ],
      state: Buffer.from(JSON.stringify({ companyId })).toString('base64url'),
    });
  }

  async handleCallback(code: string, companyId: string): Promise<void> {
    const client = this.makeOAuth2();
    const { tokens } = await client.getToken(code);

    client.setCredentials(tokens);
    let accountEmail: string | null = null;
    try {
      const oauth2 = google.oauth2({ version: 'v2', auth: client });
      const { data } = await oauth2.userinfo.get();
      accountEmail = data.email ?? null;
    } catch {
      this.logger.warn('Could not fetch Google account email');
    }

    await this.prisma.integrationConnection.upsert({
      where: { companyId_type: { companyId, type: 'google_calendar' } },
      create: {
        companyId,
        type: 'google_calendar',
        accessToken: tokens.access_token ? encrypt(tokens.access_token) : null,
        refreshToken: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        accountEmail,
        scopes: tokens.scope?.split(' ') ?? [],
        isActive: true,
      },
      update: {
        accessToken: tokens.access_token ? encrypt(tokens.access_token) : undefined,
        ...(tokens.refresh_token && { refreshToken: encrypt(tokens.refresh_token) }),
        tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
        accountEmail: accountEmail ?? undefined,
        isActive: true,
        lastError: null,
      },
    });
  }

  async disconnect(companyId: string): Promise<void> {
    await this.prisma.integrationConnection.updateMany({
      where: { companyId, type: 'google_calendar' },
      data: { isActive: false },
    });
  }

  async createEvent(companyId: string, opts: CalendarEventOpts): Promise<string | null> {
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { companyId_type: { companyId, type: 'google_calendar' } },
    });
    if (!conn?.isActive || !conn.accessToken) {
      throw new Error('Google Calendar not connected');
    }

    const client = this.makeOAuth2();
    client.setCredentials({
      access_token: decrypt(conn.accessToken),
      refresh_token: conn.refreshToken ? decrypt(conn.refreshToken) : undefined,
    });

    client.on('tokens', async (tokens) => {
      if (tokens.access_token) {
        await this.prisma.integrationConnection.update({
          where: { id: conn.id },
          data: {
            accessToken: encrypt(tokens.access_token),
            ...(tokens.refresh_token && { refreshToken: encrypt(tokens.refresh_token) }),
            tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
          },
        });
      }
    });

    const calendar = google.calendar({ version: 'v3', auth: client });
    const start = opts.startTime ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
    const duration = opts.durationMinutes ?? 60;
    const end = new Date(start.getTime() + duration * 60_000);

    const event = await calendar.events.insert({
      calendarId: opts.calendarId ?? 'primary',
      requestBody: {
        summary: opts.summary,
        description: opts.description ?? 'Creado por Agentes TirePro',
        start: { dateTime: start.toISOString(), timeZone: 'America/Bogota' },
        end: { dateTime: end.toISOString(), timeZone: 'America/Bogota' },
        ...(opts.location && { location: opts.location }),
        ...(opts.attendees?.length && {
          attendees: opts.attendees.map(email => ({ email })),
        }),
      },
      ...(opts.attendees?.length && { sendUpdates: 'all' }),
    });

    await this.prisma.integrationConnection.update({
      where: { id: conn.id },
      data: { lastUsedAt: new Date() },
    });

    return event.data.id ?? null;
  }

  async listEvents(
    companyId: string,
    timeMin: Date,
    timeMax: Date,
  ): Promise<Array<{ id: string; summary: string; start: string; end: string }>> {
    const conn = await this.prisma.integrationConnection.findUnique({
      where: { companyId_type: { companyId, type: 'google_calendar' } },
    });
    if (!conn?.isActive || !conn.accessToken) return [];

    const client = this.makeOAuth2();
    client.setCredentials({
      access_token: decrypt(conn.accessToken),
      refresh_token: conn.refreshToken ? decrypt(conn.refreshToken) : undefined,
    });

    const calendar = google.calendar({ version: 'v3', auth: client });
    const res = await calendar.events.list({
      calendarId: 'primary',
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 20,
    });

    return (res.data.items ?? []).map(e => ({
      id: e.id ?? '',
      summary: e.summary ?? '(Sin título)',
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
    }));
  }
}
