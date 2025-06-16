// src/comunidad/comunidad.module.ts

import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { MessageService } from './message.service';
import { MessageController } from './message.controller';

@Module({
  providers: [
    PrismaService,
    ChatService,
    MessageService,
  ],
  controllers: [
    ChatController,
    MessageController,
  ],
})
export class ComunidadModule {}
