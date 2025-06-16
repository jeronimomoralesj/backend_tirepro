// src/comunidad/message.controller.ts

import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { MessageService }      from './message.service';
import { CreateMessageDto }     from './dto/create-message.dto';

@Controller('chats/:chatId/messages')
export class MessageController {
  constructor(private readonly msgSvc: MessageService) {}

  @Get()
  findByChat(@Param('chatId') chatId: string) {
    return this.msgSvc.findByChat(chatId);
  }

  @Post()
  create(
    @Param('chatId') chatId: string,
    @Body() dto: CreateMessageDto,
  ) {
    // hand chatId and DTO separately
    return this.msgSvc.create(chatId, dto);
  }
}
