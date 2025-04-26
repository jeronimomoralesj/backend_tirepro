// main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule }    from './app.module';
import * as bodyParser  from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // 0) CORS first
  app.enableCors({
    origin: [
      'http://localhost:3000',
      'https://tirepro.vercel.app',
      'https://tirepro.com.co',
      'https://www.tirepro.com.co',
    ],
    methods: ['GET','HEAD','PUT','PATCH','POST','DELETE','OPTIONS'],
    credentials: true,
    allowedHeaders: ['Content-Type','Authorization'],
  });

  // 1) then body parsing
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

  // 2) global prefix
  app.setGlobalPrefix('api');

  await app.listen(6001, '0.0.0.0');
}
bootstrap();
