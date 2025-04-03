import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Increase the JSON body payload limit
  app.use(bodyParser.json({ limit: '50mb' }));
  app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

  // Ensure all API routes are prefixed with /api
  app.setGlobalPrefix('api');

  // Enable CORS so Next.js (Frontend) can talk to NestJS (Backend)
  app.enableCors({
    origin: ["*", "http://localhost:3000", "https://tirepro.vercel.app"],
    credentials: true,
  });

  await app.listen(6001, '0.0.0.0');
}
bootstrap();
