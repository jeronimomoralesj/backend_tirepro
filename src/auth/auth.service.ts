import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService, private readonly jwtService: JwtService) {}

  async generateJwt(user: { email: string; id: string }) { // ✅ Add this function
    return this.jwtService.sign({ email: user.email, sub: user.id });
  }

  async register(email: string, name: string, password: string) {
    const existingUser = await this.prisma.user.findUnique({ where: { email } });
    if (existingUser) throw new BadRequestException("User already exists");

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await this.prisma.user.create({
      data: { email, name, password: hashedPassword, companyId: "", role: "regular", puntos: 0, plates: [] },
    });

    return { message: "User registered successfully", userId: newUser.id };
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new BadRequestException('Invalid credentials');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new BadRequestException('Invalid credentials');
    }

    // Generate a JWT token (adjust payload and secret as needed)
    const payload = { sub: user.id, email: user.email };
    const access_token = this.jwtService.sign(payload);

    // Return only the necessary fields
    return { 
      access_token, 
      user: { id: user.id, email: user.email, role: user.role, companyId: user.companyId, name: user.name } 
    };
    
  }

  async validateUser(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Invalid credentials');

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) throw new UnauthorizedException('Invalid credentials');

    const token = await this.generateJwt(user); // ✅ Now calling a defined function

    return { token, user };
  }
}
