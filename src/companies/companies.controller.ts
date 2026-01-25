import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Delete,
  Req,
  UseGuards,
  Query,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyLogoDto } from './dto/update-company-logo.dto';

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  // =========================
  // AUTH / ME ROUTES (FIRST)
  // =========================
  @UseGuards(AuthGuard('jwt'))
  @Get('me/clients')
  async getMyClients(@Req() req: any) {
    const distributorCompanyId = req.user.companyId;

    return this.companiesService.getClientsForDistributor(
      distributorCompanyId,
    );
  }

  // =========================
  // SEARCH
  // =========================
  @Get('search/by-name')
  async searchCompaniesByName(
    @Query('q') query: string,
    @Query('exclude') excludeCompanyId?: string,
  ) {
    return this.companiesService.searchCompaniesByName(
      query,
      excludeCompanyId,
    );
  }

  // =========================
  // CREATE COMPANY
  // =========================
  @Post('register')
  async register(@Body() createCompanyDto: CreateCompanyDto) {
    return this.companiesService.createCompany(createCompanyDto);
  }

  // =========================
  // DYNAMIC ROUTES (LAST)
  // =========================
  @Get(':companyId')
  async getCompanyById(@Param('companyId') companyId: string) {
    return this.companiesService.getCompanyById(companyId);
  }

  @Patch(':companyId/logo')
  async updateCompanyLogo(
    @Param('companyId') companyId: string,
    @Body() body: UpdateCompanyLogoDto,
  ) {
    return this.companiesService.updateCompanyLogo(
      companyId,
      body.imageBase64,
    );
  }

  @Get(':companyId/distributors')
  async getConnectedDistributors(
    @Param('companyId') companyId: string,
  ) {
    return this.companiesService.getConnectedDistributors(companyId);
  }

  @Post(':companyId/distributors/:distributorId')
  async grantDistributorAccess(
    @Param('companyId') companyId: string,
    @Param('distributorId') distributorId: string,
  ) {
    return this.companiesService.grantDistributorAccess(
      companyId,
      distributorId,
    );
  }

  @Delete(':companyId/distributors/:distributorId')
  async revokeDistributorAccess(
    @Param('companyId') companyId: string,
    @Param('distributorId') distributorId: string,
  ) {
    return this.companiesService.revokeDistributorAccess(
      companyId,
      distributorId,
    );
  }
}
