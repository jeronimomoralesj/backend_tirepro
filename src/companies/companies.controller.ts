// src/companies/companies.controller.ts
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
} from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { UpdateCompanyLogoDto } from './dto/update-company-logo.dto';
import { Query } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
@Controller('companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  // =========================
  // CREATE COMPANY
  // =========================
  @Post('register')
  async register(@Body() createCompanyDto: CreateCompanyDto) {
    return this.companiesService.createCompany(createCompanyDto);
  }

  // =========================
  // GET COMPANY BY ID
  // =========================
  @Get(':companyId')
  async getCompanyById(@Param('companyId') companyId: string) {
    return this.companiesService.getCompanyById(companyId);
  }

  // =========================
  // UPDATE COMPANY LOGO
  // =========================
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

  // =========================
  // GRANT DISTRIBUTOR ACCESS
  // Company selects a distributor
  // =========================
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

  // =========================
  // REVOKE DISTRIBUTOR ACCESS
  // Company removes distributor
  // =========================
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

@Get(':companyId/distributors')
async getConnectedDistributors(
  @Param('companyId') companyId: string,
) {
  return this.companiesService.getConnectedDistributors(companyId);
}

@UseGuards(AuthGuard('jwt'))
@Get('me/clients')
async getMyClients(@Req() req: any) {
  const distributorCompanyId = req.user.companyId;

  return this.companiesService.getClientsForDistributor(
    distributorCompanyId,
  );
}


}
