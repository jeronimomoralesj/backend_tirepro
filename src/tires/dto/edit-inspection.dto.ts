import { IsArray, ArrayMaxSize, IsNumber, IsString, IsOptional, Min, Max } from 'class-validator';
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
  @IsString()
  inspeccionadoPorId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  kilometrosEstimados?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(250)
  presionPsi?: number;

  @IsOptional()
  @IsString()
  fechaInstalacion?: string;

  // Replacement image set. Entries may be existing S3 URLs (preserved)
  // or data:image/... base64 URLs (uploaded to S3 on save). Any old URL
  // absent from this list is deleted from S3.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2, { message: 'Maximum 2 photos allowed' })
  @IsString({ each: true })
  imageUrls?: string[];
}
