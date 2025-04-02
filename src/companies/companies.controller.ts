import { Controller, Post, Get, Patch, Body, Param } from '@nestjs/common';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';

@Controller('companies')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Post('register')
  async register(@Body() createCompanyDto: CreateCompanyDto) {
    return this.companiesService.createCompany(createCompanyDto);
  }

  @Get(':companyId')
  async getCompanyById(@Param('companyId') companyId: string) {
    return this.companiesService.getCompanyById(companyId);
  }
}
