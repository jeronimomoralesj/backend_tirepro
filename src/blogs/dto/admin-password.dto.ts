import { IsString, IsNotEmpty } from 'class-validator';

export class VerifyPasswordDto {
  @IsString()
  @IsNotEmpty()
  password: string;
}