// dto/create-tire.dto.ts
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
import type { EjeType, VidaValue } from '@prisma/client';

const EJE_TYPE_VALUES = {
  direccion: 'direccion',
  traccion:  'traccion',
  libre:     'libre',
  remolque:  'remolque',
  repuesto:  'repuesto',
} as const;

const VIDA_VALUES = {
  nueva:       'nueva',
  reencauche1: 'reencauche1',
  reencauche2: 'reencauche2',
  reencauche3: 'reencauche3',
  fin:         'fin',
} as const;

export class CreateTireDto {
  // ── Identity ───────────────────────────────────────────────────────────────

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

  @IsEnum(EJE_TYPE_VALUES, {
    message: `eje must be one of: ${Object.values(EJE_TYPE_VALUES).join(', ')}`,
  })
  eje: EjeType;

  // ── Relations ──────────────────────────────────────────────────────────────

  @IsString()
  @IsNotEmpty()
  companyId: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  @IsNumber()
  @Min(0)
  posicion: number;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  @IsOptional()
  @IsNumber()
  @Min(0)
  kilometrosRecorridos?: number;

  @IsOptional()
  @IsDateString()
  fechaInstalacion?: string;

  @IsOptional()
  @IsEnum(VIDA_VALUES, {
    message: `vidaActual must be one of: ${Object.values(VIDA_VALUES).join(', ')}`,
  })
  vidaActual?: VidaValue;

  // ── Historical arrays ─────────────────────────────────────────────────────

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