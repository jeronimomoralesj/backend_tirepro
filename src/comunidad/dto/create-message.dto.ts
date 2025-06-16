// src/comunidad/dto/create-message.dto.ts
import { IsString, IsNotEmpty, IsUUID, IsOptional } from 'class-validator';

export class CreateMessageDto {
  @IsUUID()
  @IsOptional()
  authorId?: string;

  @IsString()
  @IsNotEmpty()
  authorName: string;       // ← newly required

  @IsString()
  @IsNotEmpty()
  content: string;
}
