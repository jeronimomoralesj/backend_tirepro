import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Put,
  Delete,
  ParseIntPipe,
} from '@nestjs/common';
import { BlogService } from './blogs.service';
import { CreateArticleDto } from './dto/create-article.dto';
import { UpdateArticleDto } from './dto/update-article.dto';

// Remove 'api/' from here since it's already set globally in main.ts
@Controller('blog')
export class BlogController {
  constructor(private readonly blogService: BlogService) {}

  @Get()
  async findAll() {
    try {
      const articles = await this.blogService.findAll();
      return articles;
    } catch (error) {
      // error handled by NestJS exception filter
      throw error;
    }
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    try {
      const article = await this.blogService.findOne(id);
      return article;
    } catch (error) {
      // error handled by NestJS exception filter
      throw error;
    }
  }

  @Post()
  async create(@Body() createArticleDto: CreateArticleDto) {
    try {
      
      const article = await this.blogService.create(createArticleDto);
      return article;
    } catch (error) {
      // error handled by NestJS exception filter
      throw error;
    }
  }

  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateArticleDto: UpdateArticleDto
  ) {
    try {
      
      const article = await this.blogService.update(id, updateArticleDto);
      return article;
    } catch (error) {
      // error handled by NestJS exception filter
      throw error;
    }
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    try {
      
      await this.blogService.remove(id);
      return { message: 'Article deleted successfully' };
    } catch (error) {
      // error handled by NestJS exception filter
      throw error;
    }
  }

  @Get('slug/:slug')
findBySlug(@Param('slug') slug: string) {
  return this.blogService.findBySlug(slug);
}
}