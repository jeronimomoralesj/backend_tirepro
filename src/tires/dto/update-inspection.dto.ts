import { IsNumber, IsString, IsOptional, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateInspectionDto {
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

  @IsOptional()
  @IsString()
  imageUrl?: string;

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
}