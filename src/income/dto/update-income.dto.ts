import { IsOptional, IsString, IsNumber, IsDateString } from 'class-validator';

export class UpdateIncomeDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsDateString() // ← change here
  date?: string;

  @IsOptional()
  @IsNumber()
  amount?: number;

  @IsOptional()
  @IsString()
  note?: string;
}
