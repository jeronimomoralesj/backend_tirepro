import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpCode,
  HttpStatus,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyLogoDto } from './dto/update-company-logo.dto';

@Controller('companies')
@UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  // ── Authenticated / "me" routes  (must come before :param routes) ─────────

  @UseGuards(JwtAuthGuard)
  @Get('me/clients')
  getMyClients(@Req() req: any) {
    return this.companiesService.getClientsForDistributor(req.user.companyId);
  }

  // ── Search ────────────────────────────────────────────────────────────────

  @Get('search/by-name')
  searchByName(
    @Query('q') query: string,
    @Query('exclude') excludeCompanyId?: string,
  ) {
    return this.companiesService.searchCompaniesByName(query, excludeCompanyId);
  }

  // ── Admin list ────────────────────────────────────────────────────────────

  @Get('all')
  findAll() {
    return this.companiesService.getAllCompanies();
  }

  // ── Create ────────────────────────────────────────────────────────────────

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  register(@Body() dto: CreateCompanyDto) {
    return this.companiesService.createCompany(dto);
  }

  // ── Single company  ───────────────────────────────────────────────────────

  @Get(':companyId')
  getById(@Param('companyId') companyId: string) {
    return this.companiesService.getCompanyById(companyId);
  }

  @Patch(':companyId/logo')
  updateLogo(
    @Param('companyId') companyId: string,
    @Body() dto: UpdateCompanyLogoDto,
  ) {
    return this.companiesService.updateCompanyLogo(companyId, dto.imageBase64);
  }

  // ── Distributor access ────────────────────────────────────────────────────

  @Get(':companyId/distributors')
  getDistributors(@Param('companyId') companyId: string) {
    return this.companiesService.getConnectedDistributors(companyId);
  }

  @Post(':companyId/distributors/:distributorId')
  @HttpCode(HttpStatus.OK)
  grantAccess(
    @Param('companyId') companyId: string,
    @Param('distributorId') distributorId: string,
  ) {
    return this.companiesService.grantDistributorAccess(companyId, distributorId);
  }

  @Delete(':companyId/distributors/:distributorId')
  @HttpCode(HttpStatus.OK)
  revokeAccess(
    @Param('companyId') companyId: string,
    @Param('distributorId') distributorId: string,
  ) {
    return this.companiesService.revokeDistributorAccess(companyId, distributorId);
  }
}