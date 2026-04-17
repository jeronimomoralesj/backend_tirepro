// dto/update-inspection.dto.ts
import {
  IsNumber,
  IsString,
  IsOptional,
  IsEnum,
  IsArray,
  ArrayMaxSize,
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

  // ── Image(s) ──────────────────────────────────────────────────────────────
  // imageUrl is the legacy single-photo path (kept for older clients).
  // imageUrls carries up to 2 photos per tire. Each entry may be either an
  // existing S3 URL (preserved on edit) or a data:image/... base64 URL
  // (uploaded to S3 by the service on save).

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2, { message: 'Maximum 2 photos allowed' })
  @IsString({ each: true })
  imageUrls?: string[];

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