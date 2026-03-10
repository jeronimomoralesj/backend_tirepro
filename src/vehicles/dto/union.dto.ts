import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class UnionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  placa: string;
}