// src/companies/companies.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { uploadCompanyProfilePicToS3 } from './s3.service';

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async updateCompanyLogo(companyId: string, imageBase64: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    if (!imageBase64 || !imageBase64.startsWith('data:image')) {
      throw new BadRequestException('Invalid image format');
    }

    const base64Data = imageBase64.split(',')[1];
    if (!base64Data) {
      throw new BadRequestException('Invalid base64 payload');
    }

    const buffer = Buffer.from(base64Data, 'base64');

    const imageUrl = await uploadCompanyProfilePicToS3(
      buffer,
      companyId,
      'image/jpeg',
    );

    const updatedCompany = await this.prisma.company.update({
      where: { id: companyId },
      data: { profileImage: imageUrl },
    });

    return {
      message: 'Logo actualizado correctamente',
      profileImage: updatedCompany.profileImage,
    };
  }

  async createCompany(createCompanyDto) {
    const { name, plan } = createCompanyDto;

    const newCompany = await this.prisma.company.create({
      data: {
        name,
        plan,
        profileImage:
          'https://tireproimages.s3.us-east-1.amazonaws.com/companyResources/logoFull.png',
        vehicleCount: 0,
        userCount: 0,
      },
    });

    return {
      message: 'Company registered successfully',
      companyId: newCompany.id,
    };
  }

  async getCompanyById(companyId: string) {
  return this.prisma.company.findUniqueOrThrow({
    where: { id: companyId },
    include: {
      distributors: {
        include: {
          distributor: {
            select: {
              id: true,
              name: true,
              profileImage: true,
              plan: true,
            },
          },
        },
      },
    },
  });
}

  async grantDistributorAccess(companyId: string, distributorId: string) {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    const distributor = await this.prisma.company.findUnique({
      where: { id: distributorId },
    });

    if (!distributor || distributor.plan !== 'distribuidor') {
      throw new BadRequestException('Selected company is not a distributor');
    }

    try {
      return await this.prisma.distributorAccess.create({
        data: {
          companyId,
          distributorId,
        },
      });
    } catch (err) {
      throw new BadRequestException(
        'Distributor already has access to this company',
      );
    }
  }


  async revokeDistributorAccess(companyId: string, distributorId: string) {
    return this.prisma.distributorAccess.delete({
      where: {
        companyId_distributorId: {
          companyId,
          distributorId,
        },
      },
    });
  }

  async searchCompaniesByName(
  query: string,
  excludeCompanyId?: string,
) {
  if (!query || query.trim().length < 2) {
    return [];
  }

  return this.prisma.company.findMany({
    where: {
      name: {
        contains: query,
        mode: 'insensitive',
      },
      ...(excludeCompanyId && {
        id: { not: excludeCompanyId },
      }),
    },
    select: {
      id: true,
      name: true,
      plan: true,
      profileImage: true,
    },
    take: 10, // prevents abuse & keeps UI fast
  });
}

async getConnectedDistributors(companyId: string) {
  return this.prisma.distributorAccess.findMany({
    where: { companyId },
    include: {
      distributor: {
        select: {
          id: true,
          name: true,
          profileImage: true,
          plan: true,
        },
      },
    },
  });
}

async getClientsForDistributor(distributorCompanyId: string) {
  return this.prisma.distributorAccess.findMany({
    where: {
      distributorId: distributorCompanyId,
    },
    include: {
      company: {
        select: {
          id: true,
          name: true,
          profileImage: true,
          plan: true,
        },
      },
    },
  });
}


}
