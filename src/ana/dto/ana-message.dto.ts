import { IsString, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class HistoryEntry {
  @IsString()
  role: string;

  @IsString()
  text: string;
}

export class AnaMessageDto {
  @IsString()
  message: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HistoryEntry)
  history?: HistoryEntry[];

  @IsOptional()
  @IsString()
  tireData?: string;
}
