import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExtraDto } from './dto/create-extra.dto';
import { UpdateExtraDto } from './dto/update-extra.dto';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ExtrasService {
  constructor(private readonly prisma: PrismaService) {}

  async create(vehicleId: string, dto: CreateExtraDto) {
    const id = uuidv4();
    return this.prisma.extra.create({
      data: {
        id,
        vehicleId,
        type: dto.type,
        brand: dto.brand,
        purchaseDate: new Date(dto.purchaseDate),
        cost: dto.cost,
        notes: dto.notes,
      },
    });
  }

  async findAllByVehicle(vehicleId: string) {
    return this.prisma.extra.findMany({
      where: { vehicleId },
      orderBy: { purchaseDate: 'desc' },
    });
  }

  async findOne(id: string) {
    const extra = await this.prisma.extra.findUnique({ where: { id } });
    if (!extra) throw new NotFoundException(`Extra ${id} not found`);
    return extra;
  }

  async update(id: string, dto: UpdateExtraDto) {
    await this.findOne(id);
    return this.prisma.extra.update({
      where: { id },
      data: {
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.brand !== undefined && { brand: dto.brand }),
        ...(dto.purchaseDate !== undefined && { purchaseDate: new Date(dto.purchaseDate) }),
        ...(dto.cost !== undefined && { cost: dto.cost }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.extra.delete({ where: { id } });
  }
}
