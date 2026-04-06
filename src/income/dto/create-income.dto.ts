// src/income/dto/create-income.dto.ts
import { IsString, IsDateString, IsNumber, IsOptional } from 'class-validator';

export class CreateIncomeDto {
  @IsString()           title: string;
  @IsDateString()       date:  string;
  @IsNumber()           amount: number;

  @IsOptional()
  @IsString()
  note?: string;
}
