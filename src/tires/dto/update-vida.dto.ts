// dto/update-vida.dto.ts
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
} from 'class-validator';
import { Type } from 'class-transformer';
import type { MotivoFinVida } from '@prisma/client';

class DesechoDto {
  @IsString()
  @IsNotEmpty()
  causales: string;

  @IsNumber()
  @Min(0)
  milimetrosDesechados: number;
}

const VIDA_VALUES = ['nueva', 'reencauche1', 'reencauche2', 'reencauche3', 'fin'] as const;
type VidaValueType = typeof VIDA_VALUES[number];

const MOTIVO_FIN_VALUES = {
  reencauche:       'reencauche',
  desgaste:         'desgaste',
  dano_mecanico:    'dano_mecanico',
  dano_operacional: 'dano_operacional',
  accidente:        'accidente',
  preventivo:       'preventivo',
  otro:             'otro',
} as const;

export class UpdateVidaDto {
  @IsString()
  @IsEnum(VIDA_VALUES, {
    message: `valor must be one of: ${VIDA_VALUES.join(', ')}`,
  })
  valor: VidaValueType;

  @IsOptional()
  @IsString()
  banda?: string;

  @IsOptional()
  @IsString()
  bandaMarca?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  costo?: number;

  @IsOptional()
  @IsNumber()
  @Min(1)
  profundidadInicial?: number;

  @IsOptional()
  @IsString()
  proveedor?: string;

  @IsOptional()
  @IsEnum(MOTIVO_FIN_VALUES, {
    message: `motivoFin must be one of: ${Object.values(MOTIVO_FIN_VALUES).join(', ')}`,
  })
  motivoFin?: MotivoFinVida;

  @IsOptional()
  @IsString()
  notasRetiro?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => DesechoDto)
  desechos?: DesechoDto;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3, { message: 'Maximum 3 images allowed' })
  @IsString({ each: true })
  imageUrls?: string[];
}