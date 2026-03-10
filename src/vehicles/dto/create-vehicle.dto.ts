import { IsString, IsNotEmpty, IsNumber, IsOptional, Min, MaxLength } from 'class-validator';

export class CreateVehicleDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  placa: string;

  @IsNumber()
  @Min(0)
  kilometrajeActual: number;

  @IsString()
  @IsNotEmpty()
  carga: string;

  @IsNumber()
  @Min(0)
  pesoCarga: number;

  @IsString()
  @IsNotEmpty()
  tipovhc: string;

  @IsString()
  @IsNotEmpty()
  companyId: string;

  @IsOptional()
  @IsString()
  cliente?: string;
}