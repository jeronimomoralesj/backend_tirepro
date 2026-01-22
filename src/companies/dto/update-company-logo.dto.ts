// src/companies/dto/update-company-logo.dto.ts
import { IsString, IsNotEmpty } from 'class-validator';

export class UpdateCompanyLogoDto {
  @IsString()
  @IsNotEmpty()
  imageBase64: string; // data:image/png;base64,...
}
