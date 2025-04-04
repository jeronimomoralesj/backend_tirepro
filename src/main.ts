import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Increase body size limit
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

  // Global API prefix
  app.setGlobalPrefix('api');

  // ✅ CORS Fix — remove "*" and explicitly allow Vercel and localhost
  app.enableCors({
    origin: [
      'https://tirepro.vercel.app',
      'http://localhost:3000',
      'https://tirepro.com.co',
      'https://www.tirepro.com.co'
    ],
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Authorization',
  });

  await app.listen(6001, '0.0.0.0');
}
bootstrap();
