import { IsNumber, IsString, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class EditInspectionDto {
  @IsOptional()
  @IsString()
  fecha?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  profundidadInt?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  profundidadCen?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  profundidadExt?: number;

  @IsOptional()
  @IsString()
  inspeccionadoPorNombre?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  kilometrosEstimados?: number;

  @IsOptional()
  @IsString()
  fechaInstalacion?: string;
}
