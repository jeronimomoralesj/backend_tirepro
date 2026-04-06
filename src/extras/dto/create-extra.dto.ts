// src/extras/dto/create-extra.dto.ts
import { IsString, IsNotEmpty, IsNumber, IsOptional, IsDateString } from 'class-validator';

export class CreateExtraDto {
  @IsNotEmpty()
  @IsString()
  type: string;

  @IsNotEmpty()
  @IsString()
  brand: string;

  @IsNotEmpty()
  @IsDateString()
  purchaseDate: string;    

  @IsNotEmpty()
  @IsNumber()
  cost: number;

  @IsOptional()
  @IsString()
  notes?: string;
}
