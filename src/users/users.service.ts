import { Injectable, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import * as bcrypt from 'bcryptjs';
import { EmailService } from 'src/email/email.service';
import { randomBytes } from 'crypto';
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

async createUser(createUserDto: CreateUserDto) {
  const { email, name, password, companyId, role, preferredLanguage } = createUserDto;

  const existingUser = await this.prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new BadRequestException('User with this email already exists');
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const verificationToken = randomBytes(32).toString('hex');

  const newUser = await this.prisma.user.create({
    data: { 
      email, 
      name, 
      password: hashedPassword, 
      companyId: companyId || "", 
      role: role || "regular", 
      puntos: 0, 
      plates: [], 
      isVerified: false,
      verificationToken,
      preferredLanguage: preferredLanguage || "es"
    },
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      companyId: true,
      puntos: true,
      plates: true
    }
  });

  if (companyId) {
    try {
      await this.prisma.company.update({
        where: { id: companyId },
        data: { userCount: { increment: 1 } },
      });
    } catch (error) {
      throw new BadRequestException('Failed to update company user count');
    }
  }

  // 🌐 Send email based on preferred language
  const verifyLink = `https://tirepro.com.co/verify?token=${verificationToken}`;
  preferredLanguage === 'en'
    ? await this.emailService.sendWelcomeEmailWithVerification(email, name, verifyLink)
    : await this.emailService.sendWelcomeEmailWithVerificationEs(email, name, verifyLink);

  return {
    message: "User created successfully. Please check your email to verify your account.",
    user: newUser
  };
}

  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        companyId: true,
        puntos: true,
        plates: true
      }
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  async getUserByEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        companyId: true,
        puntos: true,
        plates: true,
        password: true // Include password for authentication purposes
      }
    });

    return user;
  }

  async updateUser(userId: string, updateData: Partial<{
    name: string, 
    companyId: string, 
    role: string, 
    puntos: number, 
    plates: string[]
  }>) {
    try {
      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: updateData,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          companyId: true,
          puntos: true,
          plates: true
        }
      });

      return { 
        message: "User updated successfully", 
        user: updatedUser 
      };
    } catch (error) {
      throw new BadRequestException('Could not update user');
    }
  }

  async deleteUser(userId: string) {
    try {
      await this.prisma.user.delete({
        where: { id: userId }
      });

      return { 
        message: "User deleted successfully" 
      };
    } catch (error) {
      throw new NotFoundException('User not found');
    }
  }

  async addPlate(userId: string, plate: string) {
    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          plates: {
            push: plate
          }
        },
        select: {
          id: true,
          plates: true
        }
      });

      return { 
        message: "Plate added successfully", 
        plates: user.plates 
      };
    } catch (error) {
      throw new BadRequestException('Could not add plate');
    }
  }

  async removePlate(userId: string, plate: string) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId }
      });

      if (!user) {
        throw new NotFoundException('User not found');
      }

      const updatedPlates = user.plates.filter(p => p !== plate);

      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: {
          plates: updatedPlates
        },
        select: {
          id: true,
          plates: true
        }
      });

      return { 
        message: "Plate removed successfully", 
        plates: updatedUser.plates 
      };
    } catch (error) {
      throw new BadRequestException('Could not remove plate');
    }
  }

  async getUsersByCompany(companyId: string) {
    if (!companyId) {
      throw new BadRequestException("CompanyId is required");
    }
    const users = await this.prisma.user.findMany({
      where: { companyId },
      select: {
        id: true,
        name: true,
        email: true,
        plates: true,
      },
    });
    return users;
  }

async getAllUsers() {
  return await this.prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      companyId: true,
      plates: true,
    },
  });
}

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string
  ) {
    // 1) fetch the user (including hashed password)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { password: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // 2) verify old password
    const matches = await bcrypt.compare(oldPassword, user.password);
    if (!matches) {
      throw new UnauthorizedException('Old password is incorrect');
    }

    // 3) hash & save the new one
    const hashed = await bcrypt.hash(newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashed },
    });

    return { message: 'Password changed successfully' };
  }

}