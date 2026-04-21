import {
  Body, Controller, Delete, Get, Param, Patch, Post, Query,
  Req, UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  CreateKpiDto,
  TeamKpisService,
  UpdateKpiDto,
} from './team-kpis.service';

@Controller('team-kpis')
@UseGuards(JwtAuthGuard)
export class TeamKpisController {
  constructor(private readonly svc: TeamKpisService) {}

  @Get()
  list(
    @Query('companyId')      companyId: string,
    @Query('activeOn')       activeOn?: string,
    @Query('includeExpired') includeExpired?: string,
    @Query('userId')         userId?: string,
  ) {
    return this.svc.listWithProgress(companyId, {
      activeOn,
      includeExpired: includeExpired === 'true',
      userId: userId === 'null' ? null : userId,
    });
  }

  @Post()
  create(@Body() dto: CreateKpiDto, @Req() req: { user?: { userId?: string } }) {
    return this.svc.create(dto, req?.user?.userId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateKpiDto) {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.svc.delete(id);
  }
}
