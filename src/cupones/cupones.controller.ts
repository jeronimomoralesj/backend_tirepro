// src/cupones/cupones.controller.ts
import { Controller, Get, Param, Query } from '@nestjs/common';
import { CuponesService, Coupon } from './cupones.service';

@Controller('coupons')
export class CuponesController {
  constructor(private readonly cuponesService: CuponesService) {}

  /**
   * GET /coupons?category=llantas
   */
  @Get()
  async findAll(
    @Query('category') category?: string
  ): Promise<Coupon[]> {
    return this.cuponesService.findAll(category);
  }

  /**
   * GET /coupons/:id
   */
  @Get(':id')
  async findOne(
    @Param('id') id: string
  ): Promise<Coupon> {
    return this.cuponesService.findOne(id);
  }
}
