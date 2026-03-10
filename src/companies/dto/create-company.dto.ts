import { IsString, IsNotEmpty, IsOptional, IsEnum, MaxLength } from 'class-validator';
import { CompanyPlan } from '@prisma/client';

export class CreateCompanyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsEnum(CompanyPlan, {
    message: `plan must be one of: ${Object.values(CompanyPlan).join(', ')}`,
  })
  plan?: CompanyPlan = CompanyPlan.basic;
}