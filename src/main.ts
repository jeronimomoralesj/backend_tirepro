// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { ValidationPipe, HttpStatus } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';

const ALLOWED_PROD_ORIGINS = [
  'https://tirepro.vercel.app',
  'https://tirepro.com.co',
  'https://www.tirepro.com.co',
  'https://api.tirepro.com.co',
  'http://api.tirepro.com.co',
  'http://www.localhost:3000',
];

async function bootstrap() {
  console.log('⏳  Starting Nest bootstrap…');
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  console.log('✅  NestFactory.create() completed');

  app.use(bodyParser.json({ limit: '600mb' }));
  app.use(bodyParser.urlencoded({ limit: '600mb', extended: true }));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidUnknownValues: true, transform: true }));
  app.setGlobalPrefix('api');

  // dynamic CORS:
  app.enableCors({
    origin: (incomingOrigin, callback) => {
      // always allow localhost during dev
      if (!incomingOrigin || incomingOrigin.startsWith('http://localhost:3000')) {
        return callback(null, true);
      }
      // only allow your prod domains in prod
      if (ALLOWED_PROD_ORIGINS.includes(incomingOrigin)) {
        return callback(null, true);
      }
      callback(new Error('Not allowed by CORS'), false);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type,Authorization',
    credentials: true,
    optionsSuccessStatus: HttpStatus.NO_CONTENT,
  });

  await app.listen(6001, '0.0.0.0');
  console.log(`🚀 API running on http://localhost:6001/api`);
}

bootstrap();
