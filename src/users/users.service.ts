import {
  Injectable,
  BadRequestException,
  NotFoundException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { EmailService } from '../email/email.service';
import { UserRole, Prisma } from '@prisma/client';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Reusable select — never leak password hash to callers
// ---------------------------------------------------------------------------

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
  vehicleAccess: {
    select: {
      vehicle: { select: { id: true, placa: true } },
    },
  },
} satisfies Prisma.UserSelect;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

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

    

    return {
      message: 'User created successfully.',
      user:    newUser,
    };
  }

  // ===========================================================================
  // READ
  // ===========================================================================

  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: USER_PUBLIC_SELECT,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async getUserByEmail(email: string) {
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
    return this.prisma.user.findMany({
      where:   { companyId },
      select:  USER_PUBLIC_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async getAllUsers() {
    return this.prisma.user.findMany({
      select:  USER_PUBLIC_SELECT,
      orderBy: { createdAt: 'desc' },
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
    const data: Prisma.UserUpdateInput = {};
    if (updateData.name              !== undefined) data.name              = updateData.name;
    if (updateData.companyId         !== undefined) data.company           = { connect: { id: updateData.companyId } };
    if (updateData.puntos            !== undefined) data.puntos            = updateData.puntos;
    if (updateData.preferredLanguage !== undefined) data.preferredLanguage = updateData.preferredLanguage;

    if (updateData.role !== undefined) {
      if (!Object.values(UserRole).includes(updateData.role as UserRole)) {
        throw new BadRequestException(`Invalid role "${updateData.role}". Must be one of: ${Object.values(UserRole).join(', ')}`);
      }
      data.role = updateData.role as UserRole;
    }

    const updatedUser = await this.prisma.user.update({
      where:  { id: userId },
      data,
      select: USER_PUBLIC_SELECT,
    });

    return { message: 'User updated successfully', user: updatedUser };
  }

  async deleteUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');

    await this.prisma.user.delete({ where: { id: userId } });
    return { message: 'User deleted successfully' };
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { password: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const matches = await bcrypt.compare(oldPassword, user.password);
    if (!matches) throw new UnauthorizedException('Old password is incorrect');

    const hashed = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data:  { password: hashed },
    });

    return { message: 'Password changed successfully' };
  }

  // ===========================================================================
  // VEHICLE ACCESS
  // ===========================================================================

  async grantVehicleAccess(userId: string, vehicleId: string) {
    const [user, vehicle] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }),
      this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true } }),
    ]);
    if (!user)    throw new NotFoundException('User not found');
    if (!vehicle) throw new NotFoundException('Vehicle not found');

    await this.prisma.userVehicleAccess.upsert({
      where:  { userId_vehicleId: { userId, vehicleId } },
      create: { userId, vehicleId },
      update: {},
    });

    return { message: 'Vehicle access granted' };
  }

  async revokeVehicleAccess(userId: string, vehicleId: string) {
    const access = await this.prisma.userVehicleAccess.findUnique({
      where: { userId_vehicleId: { userId, vehicleId } },
    });
    if (!access) throw new NotFoundException('Access record not found');

    await this.prisma.userVehicleAccess.delete({
      where: { userId_vehicleId: { userId, vehicleId } },
    });

    return { message: 'Vehicle access revoked' };
  }

  async getAccessibleVehicles(userId: string) {
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

    await this.grantVehicleAccess(userId, vehicle.id);
    return { message: 'Plate access granted', placa };
  }

  async removePlate(userId: string, placa: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where:  { placa: placa.toLowerCase().trim() },
      select: { id: true },
    });
    if (!vehicle) throw new NotFoundException(`Vehicle with placa "${placa}" not found`);

    await this.revokeVehicleAccess(userId, vehicle.id);
    return { message: 'Plate access revoked', placa };
  }
}