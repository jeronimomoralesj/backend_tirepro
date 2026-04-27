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

  // ── Search ────────────────────────────────────────────────────────────────

  @Get('search/by-name')
searchByName(
  @Query('q') query: string,
  @Query('exclude') excludeCompanyId?: string,
  @Query('distributorsOnly') distributorsOnly?: string,
) {
  return this.companiesService.searchCompaniesByName(
    query,
    excludeCompanyId,
    distributorsOnly === 'true',
  );
}


@Delete(':companyId')
@HttpCode(HttpStatus.OK)
deleteCompany(@Param('companyId') companyId: string) {
  return this.companiesService.deleteCompany(companyId);
}

  // ── Authenticated / "me" routes  (must come before :param routes) ─────────

  @UseGuards(JwtAuthGuard)
  @Get('me/clients')
  getMyClients(@Req() req: any) {
    return this.companiesService.getClientsForDistributor(req.user.companyId);
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

  /**
   * TirePro-side manual verification of a tenant. Used by support when
   * onboarding is happening offline (sales call, signed contract) and we
   * want to spare the company from the auth-cleanup cron's 48-hour purge
   * even if the registering user hasn't clicked the email link yet.
   *
   * Auth: JWT-guarded; further guarded inside the service to require a
   * TirePro-internal admin role.
   */
  @Patch(':companyId/verify')
  @UseGuards(JwtAuthGuard)
  verifyCompany(@Param('companyId') companyId: string, @Req() req: any) {
    return this.companiesService.verifyCompany(companyId, req?.user);
  }

  // ── Agent settings & email (must be before :companyId catch-all) ─────────

  @UseGuards(JwtAuthGuard)
  @Get(':companyId/agent-settings')
  getAgentSettings(@Param('companyId') id: string) {
    return this.companiesService.getAgentSettings(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':companyId/agent-settings')
  updateAgentSettings(@Param('companyId') id: string, @Body() body: Record<string, any>) {
    return this.companiesService.updateAgentSettings(id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Patch(':companyId/email-atencion')
  updateEmailAtencion(@Param('companyId') id: string, @Body() body: { email: string }) {
    return this.companiesService.updateEmailAtencion(id, body.email);
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