import { IsString, IsOptional, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class DesechoDto {
  @IsString()
  causales: string;

  @IsNumber()
  milimetrosDesechados: number;
}

export class UpdateVidaDto {
  @IsString()
  valor: string;

  @IsOptional()
  @IsString()
  banda?: string;

  @IsOptional()
  @IsNumber()
  costo?: number;

  @IsOptional()
  @IsNumber()
  profundidadInicial?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => DesechoDto)
  desechos?: DesechoDto;
}
