import { IsString, IsNumber, IsOptional, Min, MaxLength } from 'class-validator';

export class UpdateVehicleDto {
  @IsOptional()
  @IsString()
  @MaxLength(20)
  placa?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  kilometrajeActual?: number;

  @IsOptional()
  @IsString()
  carga?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  pesoCarga?: number;

  @IsOptional()
  @IsString()
  tipovhc?: string;

  @IsOptional()
  @IsString()
  cliente?: string | null;
}