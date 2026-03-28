import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, HttpStatus, Logger } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

const logger = new Logger('Bootstrap');

const ALLOWED_ORIGINS = [
  'https://tirepro.vercel.app',
  'https://tirepro.com.co',
  'https://www.tirepro.com.co',
  'https://api.tirepro.com.co',
];

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // ── Security headers ────────────────────────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  // ── Request logging (4xx/5xx) ───────────────────────────────────────────
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (res.statusCode >= 400) {
        Logger.warn(
          `${req.method} ${req.url} ${res.statusCode} ${duration}ms — IP: ${req.ip}`,
          'HTTP',
        );
      }
    });
    next();
  });

  // ── Body size limits ────────────────────────────────────────────────────
  app.use(require('express').json({ limit: '10mb' }));
  app.use(require('express').urlencoded({ limit: '10mb', extended: true }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:            true,
      forbidNonWhitelisted: true,
      transform:            true,
    }),
  );

  app.setGlobalPrefix('api');

  app.enableCors({
    origin: (incomingOrigin, callback) => {
      if (!incomingOrigin) return callback(null, true);
      if (
        incomingOrigin.startsWith('http://localhost') ||
        incomingOrigin.startsWith('http://127.0.0.1')
      ) {
        return callback(null, true);
      }
      if (ALLOWED_ORIGINS.includes(incomingOrigin)) {
        return callback(null, true);
      }
      callback(new Error(`CORS: origin "${incomingOrigin}" not allowed`), false);
    },
    methods:              'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders:       'Content-Type,Authorization',
    credentials:          true,
    optionsSuccessStatus: HttpStatus.NO_CONTENT,
  });

  const port = process.env.PORT ?? 6001;
  await app.listen(port, '0.0.0.0');
  logger.log(`API running → http://0.0.0.0:${port}/api`);

  // ── Cache connectivity check ──────────────────────────────────────────────
  const redisHost = process.env.REDIS_HOST;
  if (redisHost && process.env.NODE_ENV === 'production') {
    logger.log(`Redis cache → ${redisHost}:${process.env.REDIS_PORT ?? '6379'}`);
  } else {
    logger.log('Cache running in-memory (set NODE_ENV=production for Redis)');
  }
}

bootstrap().catch(err => {
  new Logger('Bootstrap').error('Failed to start', err);
  process.exit(1);
});
