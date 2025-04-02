import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateCompanyDto } from './dto/create-company.dto';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async createCompany(createCompanyDto: CreateCompanyDto) {
    const { name, plan } = createCompanyDto;

    const newCompany = await this.prisma.company.create({
      data: {
        name,
        plan: "basic",
        profileImage: 'https://tireproimages.s3.us-east-1.amazonaws.com/companyResources/logoFull.png',
        vehicleCount: 0,
        userCount: 0,
      },
    });

    return { message: 'Company registered successfully', companyId: newCompany.id };
  }

  async getCompanyById(companyId: string) {
    const company = await this.prisma.company.findUniqueOrThrow({
        where: { id: companyId },
      });      

    if (!company) {
      throw new NotFoundException(`Company with ID ${companyId} not found`);
    }

    return company;
  }

}
