import { IsString, IsNotEmpty, IsNumber, IsOptional } from 'class-validator';

export class CreateVehicleDto {
  @IsString()
  @IsNotEmpty()
  placa: string;

  @IsNumber()
  kilometrajeActual: number;

  @IsString()
  @IsNotEmpty()
  carga: string;

  @IsNumber()
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
