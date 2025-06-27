// income.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';

@Injectable()
export class IncomeService {
  constructor(private prisma: PrismaService) {}

  // Get all incomes for a specific user
  findAllByUser(userId: string) {
    return this.prisma.income.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      select: {
        id: true,
        title: true,
        date: true,
        amount: true,
        note: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // Get a specific income by id (with user validation)
  findOne(id: string, userId: string) {
    return this.prisma.income.findFirst({
      where: { 
        id,
        userId // Ensure user can only access their own incomes
      },
      select: {
        id: true,
        title: true,
        date: true,
        amount: true,
        note: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  // Create a new income
  create(userId: string, dto: CreateIncomeDto) {
    return this.prisma.income.create({
      data: {
        userId,
        title: dto.title,
        date: new Date(dto.date),       
        amount: dto.amount,
        note:   dto.note,
      },
    });
  }

  // Update an existing income
  update(id: string, dto: UpdateIncomeDto, userId: string) {
    return this.prisma.income.updateMany({
      where: { 
        id,
        userId // Ensure user can only update their own incomes
      },
      data: {
        ...(dto.title && { title: dto.title }),
        ...(dto.date && { date: dto.date }),
        ...(dto.amount !== undefined && { amount: dto.amount }),
        ...(dto.note !== undefined && { note: dto.note }),
      },
    });
  }

  // Delete an income
  remove(id: string, userId: string) {
    return this.prisma.income.deleteMany({
      where: { 
        id,
        userId // Ensure user can only delete their own incomes
      },
    });
  }

  // Get income statistics for a user
  getStats(userId: string) {
    return this.prisma.income.aggregate({
      where: { userId },
      _sum: {
        amount: true,
      },
      _count: {
        _all: true,
      },
      _avg: {
        amount: true,
      },
    });
  }

  // Get incomes by date range
  findByDateRange(userId: string, startDate: Date, endDate: Date) {
    return this.prisma.income.findMany({
      where: {
        userId,
        date: {
          gte: startDate,
          lte: endDate,
        },
      },
      orderBy: { date: 'desc' },
      select: {
        id: true,
        title: true,
        date: true,
        amount: true,
        note: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}