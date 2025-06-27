// src/income/income.controller.ts
import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
  Query,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { IncomeService } from './income.service';
import { CreateIncomeDto } from './dto/create-income.dto';
import { UpdateIncomeDto } from './dto/update-income.dto';

@Controller('incomes')
@UseGuards(JwtAuthGuard)
export class IncomeController {
  constructor(private readonly incomeService: IncomeService) {}

  @Get()
  findAll(@Request() req: any) {
    const userId = req.user.userId;       
    return this.incomeService.findAllByUser(userId);
  }

  @Get('stats')
  getStats(@Request() req: any) {
    const userId = req.user.userId;       // ← here
    return this.incomeService.getStats(userId);
  }

  @Get('date-range')
  findByDateRange(
    @Request() req: any,
    @Query('start') start: string,
    @Query('end')   end:   string
  ) {
    const userId = req.user.userId;       // ← here
    return this.incomeService.findByDateRange(
      userId,
      new Date(start),
      new Date(end),
    );
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Request() req: any) {
    const userId = req.user.userId;       // ← here
    return this.incomeService.findOne(id, userId);
  }

  @Post()
  create(@Body() dto: CreateIncomeDto, @Request() req: any) {
    const userId = req.user.userId;       // ← here
    return this.incomeService.create(userId, dto);
  }

  @Put(':id')
  update(
    @Param('id')        id:  string,
    @Body()             dto: UpdateIncomeDto,
    @Request()          req: any,
  ) {
    const userId = req.user.userId;       
    return this.incomeService.update(id, dto, userId);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Request() req: any) {
    const userId = req.user.userId;      
    return this.incomeService.remove(id, userId);
  }
}
