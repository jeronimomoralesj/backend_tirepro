import { IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateKilometrajeDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  kilometrajeActual: number;
}