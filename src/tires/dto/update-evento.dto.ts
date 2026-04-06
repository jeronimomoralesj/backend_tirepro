import { IsString, IsNotEmpty } from 'class-validator';

export class UpdateEventoDto {
  @IsString()
  @IsNotEmpty()
  valor: string;
}