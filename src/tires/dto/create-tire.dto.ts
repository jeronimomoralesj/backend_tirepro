import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsDateString,
} from 'class-validator';

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

  // =========================
  // HISTÓRICOS
  // =========================
  @IsOptional()
  vida?: any;

  @IsOptional()
  costo?: any;

  @IsOptional()
  inspecciones?: any;

  @IsOptional()
  primeraVida?: any;

  // =========================
  // MÉTRICAS
  // =========================
  @IsOptional()
  @IsNumber()
  kilometrosRecorridos?: number;

  // =========================
  // EVENTOS
  // =========================
  @IsOptional()
  eventos?: any;

  // =========================
  // RELACIONES
  // =========================
  @IsString()
  @IsNotEmpty()
  companyId: string;

  @IsOptional()
  @IsString()
  vehicleId?: string;

  // =========================
  // POSICIÓN
  // =========================
  @IsNumber()
  posicion: number;

  // =========================
  // TIEMPO (NUEVO)
  // =========================
  @IsOptional()
  @IsDateString()
  fechaInstalacion?: string;

  // =========================
  // DESECHOS
  // =========================
  @IsOptional()
  desechos?: any;
}
