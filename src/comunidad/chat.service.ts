import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateChatDto } from './dto/create-chat.dto';

@Injectable()
export class ChatService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.chat.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        category: true,
        content: true,
        emoji: true,
        messageCount: true,
        createdAt: true,
      },
    });
  }

  findOne(id: string) {
    return this.prisma.chat.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        category: true,
        content: true,
        emoji: true,
        messageCount: true,
        createdAt: true,
      },
    });
  }

  create(dto: CreateChatDto) {
    return this.prisma.chat.create({
      data: {
        title:    dto.title,
        category: dto.category,
        content:  dto.content,
        emoji:    dto.emoji,
      },
    });
  }
}
