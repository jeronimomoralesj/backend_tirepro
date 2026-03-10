import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDateString,
  IsEnum,
  IsArray,
  Min,
} from 'class-validator';
import { EjeType } from '@prisma/client';

export class CreateTireDto {
  @IsOptional()
  @IsString()
  placa?: string;

  @IsString()
  @IsNotEmpty()
  marca: string;

  @IsString()
  @IsNotEmpty()
  diseno: string;

  @IsNumber()
  @Min(1)
  profundidadInicial: number;

  @IsString()
  @IsNotEmpty()
  dimension: string;

  @IsEnum(EjeType, { message: `eje must be one of: ${Object.values(EjeType).join(', ')}` })
  eje: EjeType;

  @IsString()
  @IsNotEmpty()
  companyId: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsNumber()
  @Min(0)
  posicion: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  kilometrosRecorridos?: number;

  @IsOptional()
  @IsDateString()
  fechaInstalacion?: string;

  // Historical arrays — validated loosely because they come from
  // bulk upload / migration paths with variable shapes
  @IsOptional()
  @IsArray()
  vida?: any[];

  @IsOptional()
  @IsArray()
  costo?: any[];

  @IsOptional()
  @IsArray()
  inspecciones?: any[];

  @IsOptional()
  @IsArray()
  primeraVida?: any[];

  @IsOptional()
  @IsArray()
  eventos?: any[];

  @IsOptional()
  desechos?: any;
}