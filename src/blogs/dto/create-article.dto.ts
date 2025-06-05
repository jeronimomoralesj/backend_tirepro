// src/blog/dto/create-article.dto.ts
import { IsString, IsArray, IsOptional } from 'class-validator';

export class CreateArticleDto {
  @IsString()
  title: string;

  @IsString()
  subtitle: string;

  @IsString()
  content: string;

  @IsString()
  coverImage: string;

  @IsString()
  category: string;

  @IsArray()
  @IsOptional()
  hashtags?: string[];
}