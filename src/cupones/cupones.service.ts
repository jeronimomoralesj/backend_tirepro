// src/cupones/cupones.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CouponCategory } from '@prisma/client';

export type Coupon = {
  id: string;
  titleKey: string;
  descriptionKey: string;
  discount: string;
  category: 'llantas' | 'reencauches' | 'baterias' | 'gasolina' | 'aceites';
  validUntil: string;
  code: string;
  color: string;
};

@Injectable()
export class CuponesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Return all coupons, or only those matching a given category.
   */
  async findAll(category?: string): Promise<Coupon[]> {
    const whereClause =
      category && category !== 'all'
        ? { category: category as CouponCategory }
        : undefined;

    const rows = await this.prisma.coupon.findMany({
      where: whereClause,
      orderBy: { validUntil: 'asc' },
    });

    return rows.map((c) => ({
      id: c.id,
      titleKey: c.titleKey,
      descriptionKey: c.descriptionKey,
      discount: c.discount,
      category: c.category,
      validUntil: c.validUntil.toISOString(),
      code: c.code,
      color: c.color,
    }));
  }

  /**
   * Return one coupon by its ID, or throw a 404.
   */
  async findOne(id: string): Promise<Coupon> {
    const c = await this.prisma.coupon.findUnique({ where: { id } });
    if (!c) {
      throw new NotFoundException(`Coupon ${id} not found`);
    }
    return {
      id: c.id,
      titleKey: c.titleKey,
      descriptionKey: c.descriptionKey,
      discount: c.discount,
      category: c.category,
      validUntil: c.validUntil.toISOString(),
      code: c.code,
      color: c.color,
    };
  }
}
