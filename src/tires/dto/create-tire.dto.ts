import { IsString, IsNotEmpty, IsOptional, IsNumber } from 'class-validator';

export class CreateTireDto {
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
  profundidadInicial: number;

  @IsString()
  @IsNotEmpty()
  dimension: string;

  @IsString()
  @IsNotEmpty()
  eje: string;

  @IsOptional()
  vida?: any;

  @IsOptional()
  costo?: any;

  @IsOptional()
  inspecciones?: any;

  @IsOptional()
  primeraVida?: any;

  @IsOptional()
  @IsNumber()
  kilometrosRecorridos?: number;

  @IsOptional()
  eventos?: any;

  @IsString()
  @IsNotEmpty()
  companyId: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  // Required field for posicion.
  @IsNumber()
  posicion: number;

  @IsOptional()
  desechos?: any;

}
