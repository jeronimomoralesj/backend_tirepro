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
      console.error('Error fetching articles:', error);
      throw error;
    }
  }

  @Get(':id')
  async findOne(@Param('id', ParseIntPipe) id: number) {
    try {
      const article = await this.blogService.findOne(id);
      return article;
    } catch (error) {
      console.error('Error fetching article:', error);
      throw error;
    }
  }

  @Post()
  async create(@Body() createArticleDto: CreateArticleDto) {
    try {
      console.log('Creating article with data:', createArticleDto);
      const article = await this.blogService.create(createArticleDto);
      return article;
    } catch (error) {
      console.error('Error creating article:', error);
      throw error;
    }
  }

  @Put(':id')
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateArticleDto: UpdateArticleDto
  ) {
    try {
      console.log('Updating article with ID:', id, 'Data:', updateArticleDto);
      const article = await this.blogService.update(id, updateArticleDto);
      return article;
    } catch (error) {
      console.error('Error updating article:', error);
      throw error;
    }
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number) {
    try {
      console.log('Deleting article with ID:', id);
      await this.blogService.remove(id);
      return { message: 'Article deleted successfully' };
    } catch (error) {
      console.error('Error deleting article:', error);
      throw error;
    }
  }
}