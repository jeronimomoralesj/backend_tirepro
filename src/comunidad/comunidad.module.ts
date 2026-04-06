// src/comunidad/comunidad.module.ts
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { MessageService } from './message.service';
import { MessageController } from './message.controller';

@Module({
  imports: [
    DatabaseModule,      
  ],
  controllers: [
    ChatController,
    MessageController,
  ],
  providers: [
    ChatService,
    MessageService,
  ],
})
export class ComunidadModule {}
