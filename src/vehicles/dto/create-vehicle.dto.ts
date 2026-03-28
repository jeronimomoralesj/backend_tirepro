import { IsString, IsNotEmpty, IsNumber, IsOptional, Min, MaxLength, IsArray, ArrayMaxSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { DriverDto } from './driver.dto';

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

  @IsOptional()
  @IsString()
  tipoOperacion?: string;  // "90-10" (pavimento-trocha)

  @IsOptional()
  @IsString()
  configuracion?: string;  // "4-4", "6-4", "2-2-2"

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => DriverDto)
  drivers?: DriverDto[];
}