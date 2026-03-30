// dto/update-inspection.dto.ts
import {
  IsNumber,
  IsString,
  IsOptional,
  IsEnum,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { InspeccionSource } from '@prisma/client';

const INSPECCION_SOURCE_VALUES = {
  manual:           'manual',
  bulk_upload:      'bulk_upload',
  computer_vision:  'computer_vision',
  api:              'api',
} as const;

export class UpdateInspectionDto {
  // ── Optional date override (for editing past inspections) ─────────────────

  @IsOptional()
  @IsString()
  fecha?: string;

  // ── Required tread depth readings ─────────────────────────────────────────

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  profundidadInt: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  profundidadCen: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  profundidadExt: number;

  // ── Odometer / KM ─────────────────────────────────────────────────────────

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  newKilometraje?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  kmDelta?: number;

  // ── Image ─────────────────────────────────────────────────────────────────

  @IsOptional()
  @IsString()
  imageUrl?: string;

  // ── Pressure ──────────────────────────────────────────────────────────────

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(250)
  presionPsi?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(250)
  presionRecomendadaPsi?: number;

  // ── Inspection provenance ─────────────────────────────────────────────────

  @IsOptional()
  @IsString()
  inspeccionadoPorId?: string;

  @IsOptional()
  @IsString()
  inspeccionadoPorNombre?: string;

  @IsOptional()
  @IsEnum(INSPECCION_SOURCE_VALUES, {
    message: `source must be one of: ${Object.values(INSPECCION_SOURCE_VALUES).join(', ')}`,
  })
  source?: InspeccionSource;

  // ── Computer vision model output ──────────────────────────────────────────

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cvProfundidadInt?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cvProfundidadCen?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cvProfundidadExt?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  cvConfidence?: number;

  @IsOptional()
  @IsString()
  cvModelVersion?: string;
  @IsOptional()

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  forceKm?: number;

  @IsOptional()
  @IsString()
  fechaInstalacion?: string;

}