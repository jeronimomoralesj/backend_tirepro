import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  Logger,
  Inject,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { UserRole, Prisma } from '@prisma/client';
import { CreateUserDto } from './dto/create-user.dto';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

const USER_PUBLIC_SELECT = {
  id:                true,
  email:             true,
  name:              true,
  role:              true,
  companyId:         true,
  puntos:            true,
  isVerified:        true,
  preferredLanguage: true,
  createdAt:         true,
  lastLoginAt:       true,
  loginCount:        true,
  vehicleAccess: {
    select: {
      vehicle: { select: { id: true, placa: true } },
    },
  },
} satisfies Prisma.UserSelect;

const USER_TTL = 60 * 60 * 1000;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    @Inject(CACHE_MANAGER) private cache: Cache, // ← added
  ) {}

  // ── Cache helpers ──────────────────────────────────────────────────────────

  private usersKey(companyId: string) {
    return `users:${companyId}`;
  }

  private userKey(userId: string) {
    return `user:${userId}`;
  }

  private async invalidateUserCache(userId: string, companyId: string) {
    await Promise.all([
      this.cache.del(this.userKey(userId)),      // single user record
      this.cache.del(this.usersKey(companyId)),  // company user list
    ]);
  }

  // ===========================================================================
  // CREATE USER
  // ===========================================================================

  async createUser(dto: CreateUserDto) {
    const { email, name, password, companyId, role, preferredLanguage } = dto;

    const existing = await this.prisma.user.findUnique({
      where:  { email },
      select: { id: true },
    });
    if (existing) throw new BadRequestException('User with this email already exists');

    const resolvedRole: UserRole =
      role && Object.values(UserRole).includes(role as UserRole)
        ? (role as UserRole)
        : UserRole.admin;

    const hashedPassword    = await bcrypt.hash(password, 12);
    const verificationToken = randomBytes(32).toString('hex');

    const newUser = await this.prisma.user.create({
      data: {
        email,
        name,
        password:          hashedPassword,
        companyId:         companyId || '',
        role:              resolvedRole,
        puntos:            0,
        isVerified:        true,
        verificationToken,
        preferredLanguage: preferredLanguage || 'es',
      },
      select: USER_PUBLIC_SELECT,
    });

    // Invalidate the company user list — it no longer includes this new user
    await this.cache.del(this.usersKey(companyId)); // ← added

    this.emailService.sendWelcomeEmailEs(email, name).catch(err =>
      this.logger.error(`Welcome email failed for ${email}: ${err.message}`),
    );

    return { message: 'User created successfully.', user: newUser };
  }

  // ===========================================================================
  // READ
  // ===========================================================================

  async getUserById(userId: string) {
    const cached = await this.cache.get(this.userKey(userId));
    if (cached) return cached; // ← added

    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: USER_PUBLIC_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');

    await this.cache.set(this.userKey(userId), user, USER_TTL); // ← added
    return user;
  }

  async getUserByEmail(email: string) {
    // Not cached — this is the auth lookup path, always needs the freshest
    // password hash. Never serve a stale hash from cache.
    return this.prisma.user.findUnique({
      where:  { email },
      select: {
        id:        true,
        email:     true,
        name:      true,
        role:      true,
        companyId: true,
        puntos:    true,
        password:  true,
      },
    });
  }

  async getUsersByCompany(companyId: string) {
    if (!companyId) throw new BadRequestException('companyId is required');

    const cached = await this.cache.get(this.usersKey(companyId));
    if (cached) return cached; // ← added

    const users = await this.prisma.user.findMany({
      where:   { companyId },
      select:  USER_PUBLIC_SELECT,
      orderBy: { name: 'asc' },
    });

    await this.cache.set(this.usersKey(companyId), users, USER_TTL); // ← added
    return users;
  }

  async getAllUsers() {
    // Not cached — admin-only, spans all companies, called rarely
    return this.prisma.user.findMany({
      select:  USER_PUBLIC_SELECT,
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Per-user inspection counts for a company, filtered by date range.
   *
   * Used by the distribuidor Gestión → Mi Equipo tab to show who is actually
   * performing inspections. Also returns lastLoginAt + role so the UI can
   * surface dormant accounts.
   *
   * @param from ISO date string (inclusive). If absent, no lower bound.
   * @param to   ISO date string (exclusive). If absent, no upper bound.
   */
  async getUserInspectionStats(
    companyId: string,
    from?: string,
    to?: string,
    days?: number,
  ) {
    if (!companyId) throw new BadRequestException('companyId is required');

    // `days` wins when both are passed; translates to [now - Nd, now).
    let fromDate = from ? new Date(from) : undefined;
    let toDate   = to   ? new Date(to)   : undefined;
    if (typeof days === 'number' && days > 0) {
      toDate   = new Date();
      fromDate = new Date(toDate.getTime() - days * 86_400_000);
    }
    const windowFilter = fromDate || toDate
      ? { ...(fromDate && { gte: fromDate }), ...(toDate && { lt: toDate }) }
      : undefined;

    // All three aggregations run in parallel.
    const [users, counts, logins, breakdown] = await Promise.all([
      this.prisma.user.findMany({
        where:   { companyId },
        select: {
          id: true, email: true, name: true, role: true,
          createdAt: true, lastLoginAt: true, loginCount: true,
        },
        orderBy: { name: 'asc' },
      }),
      // Inspection count + last inspection per user in the window.
      this.prisma.inspeccion.groupBy({
        by:    ['inspeccionadoPorId'],
        where: {
          tire: { companyId },
          inspeccionadoPorId: { not: null },
          ...(windowFilter && { fecha: windowFilter }),
        },
        _count: { _all: true },
        _max:   { fecha: true },
      }),
      // Login events per user in the window — fixes the "count doesn't
      // respect filter" bug the team view had.
      this.prisma.userLoginLog.groupBy({
        by:    ['userId'],
        where: {
          user: { companyId },
          ...(windowFilter && { fecha: windowFilter }),
        },
        _count: { _all: true },
        _max:   { fecha: true },
      }),
      // Per-user breakdown of which fleets (client companies) they inspected.
      // We fetch the raw rows and aggregate in memory so we can compute
      // DISTINCT tires + vehicles per (user, client) — Prisma's groupBy
      // can't aggregate distinct across nested relations.
      this.prisma.inspeccion.findMany({
        where: {
          tire: { companyId },
          inspeccionadoPorId: { not: null },
          ...(windowFilter && { fecha: windowFilter }),
        },
        select: {
          inspeccionadoPorId: true,
          tireId: true,
          tire: {
            select: {
              vehicleId: true,
              vehicle: {
                select: {
                  companyId: true,
                  company: { select: { id: true, name: true } },
                  cliente: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const statsById = new Map<string, { count: number; last: Date | null }>();
    for (const row of counts) {
      if (!row.inspeccionadoPorId) continue;
      statsById.set(row.inspeccionadoPorId, {
        count: row._count._all,
        last:  row._max.fecha ?? null,
      });
    }

    const loginsById = new Map<string, { count: number; last: Date | null }>();
    for (const row of logins) {
      loginsById.set(row.userId, {
        count: row._count._all,
        last:  row._max.fecha ?? null,
      });
    }

    // Aggregate the raw rows into Map<userId, Map<clientKey, breakdown>>.
    type ClientRow = {
      clientCompanyId:   string | null;
      clientCompanyName: string;
      vehicleIds:        Set<string>;
      tireIds:           Set<string>;
    };
    const clientsByUser = new Map<string, Map<string, ClientRow>>();
    for (const row of breakdown) {
      if (!row.inspeccionadoPorId) continue;
      const clientId   = row.tire?.vehicle?.company?.id ?? null;
      const clientName =
        row.tire?.vehicle?.company?.name
        ?? row.tire?.vehicle?.cliente
        ?? 'Sin vehículo';
      const key  = clientId ?? `_name:${clientName.toLowerCase()}`;
      const bucket = clientsByUser.get(row.inspeccionadoPorId) ?? new Map();
      const entry = bucket.get(key) ?? {
        clientCompanyId:   clientId,
        clientCompanyName: clientName,
        vehicleIds:        new Set<string>(),
        tireIds:           new Set<string>(),
      };
      if (row.tire?.vehicleId) entry.vehicleIds.add(row.tire.vehicleId);
      entry.tireIds.add(row.tireId);
      bucket.set(key, entry);
      clientsByUser.set(row.inspeccionadoPorId, bucket);
    }

    return users.map(u => {
      const stats   = statsById.get(u.id);
      const login   = loginsById.get(u.id);
      const clients = [...(clientsByUser.get(u.id)?.values() ?? [])]
        .map(c => ({
          clientCompanyId:   c.clientCompanyId,
          clientCompanyName: c.clientCompanyName,
          vehiclesInspected: c.vehicleIds.size,
          tiresInspected:    c.tireIds.size,
        }))
        .sort((a, b) => b.tiresInspected - a.tiresInspected);

      return {
        id:              u.id,
        name:            u.name,
        email:           u.email,
        role:            u.role,
        createdAt:       u.createdAt,
        // Lifetime counters — kept for backwards compatibility.
        lastLoginAt:     u.lastLoginAt,
        loginCount:      u.loginCount,
        // Window-scoped counters — these are what the UI filter should drive.
        inspections:         stats?.count ?? 0,
        lastInspection:      stats?.last ?? null,
        loginsInWindow:      login?.count ?? 0,
        lastLoginInWindow:   login?.last  ?? null,
        clientsInspected:    clients.length,
        clients,
      };
    });
  }

  // ===========================================================================
  // UPDATE
  // ===========================================================================

  async updateUser(
    userId: string,
    updateData: Partial<{
      name:              string;
      companyId:         string;
      role:              string;
      puntos:            number;
      preferredLanguage: string;
    }>,
  ) {
    // Need companyId before update in case it's being changed
    const existing = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { companyId: true },
    });
    if (!existing) throw new NotFoundException('User not found');

    const data: Prisma.UserUpdateInput = {};
    if (updateData.name              !== undefined) data.name              = updateData.name;
    if (updateData.companyId         !== undefined) data.company           = { connect: { id: updateData.companyId } };
    if (updateData.puntos            !== undefined) data.puntos            = updateData.puntos;
    if (updateData.preferredLanguage !== undefined) data.preferredLanguage = updateData.preferredLanguage;

    if (updateData.role !== undefined) {
      if (!Object.values(UserRole).includes(updateData.role as UserRole)) {
        throw new BadRequestException(
          `Invalid role "${updateData.role}". Must be one of: ${Object.values(UserRole).join(', ')}`,
        );
      }
      data.role = updateData.role as UserRole;
    }

    const updatedUser = await this.prisma.user.update({
      where:  { id: userId },
      data,
      select: USER_PUBLIC_SELECT,
    });

    // If companyId changed, invalidate both the old and new company lists
    const newCompanyId = updateData.companyId ?? existing.companyId;
    await Promise.all([
      this.cache.del(this.userKey(userId)),               // ← added
      this.cache.del(this.usersKey(existing.companyId)),  // ← added: old company list
      this.cache.del(this.usersKey(newCompanyId)),        // ← added: new company list (no-op if same)
    ]);

    return { message: 'User updated successfully', user: updatedUser };
  }

  // ── Notification preferences ────────────────────────────────────────────

  async updateNotificationPrefs(
    userId: string,
    body: { notifChannel?: string | null; notifContact?: string | null; saturnVUnlocked?: boolean },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, companyId: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const data: Record<string, any> = {};
    if (body.notifChannel !== undefined) data.notifChannel = body.notifChannel;
    if (body.notifContact !== undefined) data.notifContact = body.notifContact;
    if (body.saturnVUnlocked !== undefined) data.saturnVUnlocked = body.saturnVUnlocked;

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, notifChannel: true, notifContact: true, saturnVUnlocked: true },
    });

    await this.invalidateUserCache(userId, user.companyId);
    return updated;
  }

  async getNotificationPrefs(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, notifChannel: true, notifContact: true, saturnVUnlocked: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  // ── Delete ──────────────────────────────────────────────────────────────────

  async deleteUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { id: true, companyId: true }, // ← companyId added to select
    });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.user.delete({ where: { id: userId } });
    await this.invalidateUserCache(userId, user.companyId); // ← added
    return { message: 'User deleted successfully' };
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { password: true, companyId: true }, // ← companyId added to select
    });
    if (!user) throw new NotFoundException('User not found');

    const matches = await bcrypt.compare(oldPassword, user.password);
    if (!matches) throw new UnauthorizedException('Old password is incorrect');

    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data:  { password: hashed },
    });

    // Invalidate so next getUserById fetch gets a fresh record (even though
    // password isn't in USER_PUBLIC_SELECT, better to be safe)
    await this.invalidateUserCache(userId, user.companyId); // ← added
    return { message: 'Password changed successfully' };
  }

  // ===========================================================================
  // VEHICLE ACCESS
  // ===========================================================================

  async grantVehicleAccess(userId: string, vehicleId: string) {
    const [user, vehicle] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, companyId: true } }),
      this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true } }),
    ]);
    if (!user)    throw new NotFoundException('User not found');
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    await this.prisma.userVehicleAccess.upsert({
      where:  { userId_vehicleId: { userId, vehicleId } },
      create: { userId, vehicleId },
      update: {},
    });

    // User's vehicleAccess array changed — invalidate their cached record
    await this.invalidateUserCache(userId, user.companyId); // ← added
    return { message: 'Vehicle access granted' };
  }

  async revokeVehicleAccess(userId: string, vehicleId: string) {
    const access = await this.prisma.userVehicleAccess.findUnique({
      where:  { userId_vehicleId: { userId, vehicleId } },
      select: { userId: true },
    });
    if (!access) throw new NotFoundException('Access record not found');

    // Need companyId before delete
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { companyId: true },
    });

    await this.prisma.userVehicleAccess.delete({
      where: { userId_vehicleId: { userId, vehicleId } },
    });

    if (user) await this.invalidateUserCache(userId, user.companyId); // ← added
    return { message: 'Vehicle access revoked' };
  }

  async getAccessibleVehicles(userId: string) {
    // Not cached — this is a join query that changes whenever vehicle access
    // is granted/revoked. Those mutations already invalidate the user record,
    // but the vehicle list shape is different — simpler to just always read live.
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: {
        vehicleAccess: {
          select: {
            vehicle: {
              select: {
                id:                true,
                placa:             true,
                tipovhc:           true,
                kilometrajeActual: true,
                companyId:         true,
              },
            },
          },
        },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user.vehicleAccess.map(a => a.vehicle);
  }

  // ---------------------------------------------------------------------------
  // LEGACY COMPAT — addPlate / removePlate
  // ---------------------------------------------------------------------------

  async addPlate(userId: string, placa: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where:  { placa: placa.toLowerCase().trim() },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException(`Vehicle with placa "${placa}" not found`);

    // grantVehicleAccess already handles cache invalidation
    await this.grantVehicleAccess(userId, vehicle.id);
    return { message: 'Plate access granted', placa };
  }

  async removePlate(userId: string, placa: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where:  { placa: placa.toLowerCase().trim() },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException(`Vehicle with placa "${placa}" not found`);

    // revokeVehicleAccess already handles cache invalidation
    await this.revokeVehicleAccess(userId, vehicle.id);
    return { message: 'Plate access revoked', placa };
  }
}