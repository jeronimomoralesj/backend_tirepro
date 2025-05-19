import { IsString, IsOptional, IsNumber } from 'class-validator';

export class UpdateVidaDto {
  @IsString()
  valor: string;

  @IsOptional()
  @IsString()
  banda?: string;

  @IsOptional()
  @IsNumber()
  costo?: number;
}
