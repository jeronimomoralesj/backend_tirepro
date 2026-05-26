import { IsString, IsOptional, IsArray } from 'class-validator';

export class AnaMessageDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsArray()
  history?: { role: string; text: string }[];

  @IsOptional()
  @IsString()
  tireData?: string;
}
