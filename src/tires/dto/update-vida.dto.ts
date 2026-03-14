import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsEnum,
  ValidateNested,
  Min,
  IsArray,
  ArrayMaxSize,
  IsUrl,
} from 'class-validator';
import { Type } from 'class-transformer';

class DesechoDto {
  @IsString()
  @IsNotEmpty()
  causales: string;

  @IsNumber()
  @Min(0)
  milimetrosDesechados: number;
}

const VIDA_VALUES = ['nueva', 'reencauche1', 'reencauche2', 'reencauche3', 'fin'] as const;

export class UpdateVidaDto {
  @IsString()
  @IsEnum(VIDA_VALUES, {
    message: `valor must be one of: ${VIDA_VALUES.join(', ')}`,
  })
  valor: string;

  @IsOptional()
  @IsString()
  banda?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  costo?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  profundidadInicial?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => DesechoDto)
  desechos?: DesechoDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: 'Maximum 3 images allowed' })
  @IsString({ each: true })
  imageUrls?: string[];

  @IsOptional()
  @IsString()
  proveedor?: string;
}