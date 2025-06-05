// src/blog/blog.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BlogController } from './blogs.controller';
import { BlogService } from './blogs.service';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [ConfigModule],
  controllers: [BlogController],
  providers: [BlogService, PrismaService],
  exports: [BlogService],
})
export class BlogModule {}