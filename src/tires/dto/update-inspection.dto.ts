// src/tires/dto/update-inspection.dto.ts
import { IsNumber, IsString, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateInspectionDto {
  @Type(() => Number)
  @IsNumber()
  profundidadInt: number;

  @Type(() => Number)
  @IsNumber()
  profundidadCen: number;

  @Type(() => Number)
  @IsNumber()
  profundidadExt: number;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  // 🆕 Puede ser 0 o igual al anterior (odómetro trabado)
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  newKilometraje?: number;
}
