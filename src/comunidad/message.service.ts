// src/message/message.service.ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMessageDto } from './dto/create-message.dto';

// src/comunidad/message.service.ts
@Injectable()
export class MessageService {
  constructor(private prisma: PrismaService) {}

  findByChat(chatId: string) {
    return this.prisma.message.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
       author:   { select: { id: true, name: true } },
       authorName: true,                  // ← pull back the stored name
        content: true,
        createdAt: true,
      },
    });
  }

// src/comunidad/message.service.ts
async create(chatId: string, dto: CreateMessageDto) {
  return this.prisma.$transaction(async (tx) => {
    // 1) create the message
    const msg = await tx.message.create({
      data: {
        chatId,
        authorId:   dto.authorId ?? null,   
        authorName: dto.authorName,         
        content:    dto.content,
      },
    });

    // 2) bump the chat's counter
    await tx.chat.update({
      where: { id: chatId },
      data: { messageCount: { increment: 1 } },
    });

    return msg;
  });
}

}
