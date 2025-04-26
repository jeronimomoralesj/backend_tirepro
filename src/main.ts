// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { ValidationPipe, HttpStatus } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 1) Body size limits
  app.use(bodyParser.json({ limit: '150mb' }));
  app.use(bodyParser.urlencoded({ limit: '150mb', extended: true }));

  // 2) Global validation (optional, but recommended)
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidUnknownValues: true }));

  // 3) Global API prefix
  app.setGlobalPrefix('api');

  // 4) Enable CORS for all your front-ends, *and* reply to OPTIONS
  app.enableCors({
    origin: [
      'http://localhost:3000',
      'https://tirepro.vercel.app',
      'https://tirepro.com.co',
      'https://www.tirepro.com.co',
      'https://api.tirepro.com.co',
      'http://api.tirepro.com.co',
      'https://api.tirepro.com', 
    ],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization',
    credentials: true,
    optionsSuccessStatus: HttpStatus.NO_CONTENT, // 204
  });

  await app.listen(6001, '0.0.0.0');
  console.log(`🚀 API running on http://localhost:6001/api`);
}

bootstrap();
