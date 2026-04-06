import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { ChatService } from './chat.service';
import { CreateChatDto } from './dto/create-chat.dto';

@Controller('chats')
export class ChatController {
  constructor(private readonly chatSvc: ChatService) {}

  @Get()
  findAll() {
    return this.chatSvc.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.chatSvc.findOne(id);
  }

  @Post()
  create(@Body() dto: CreateChatDto) {
    return this.chatSvc.create(dto);
  }
}
