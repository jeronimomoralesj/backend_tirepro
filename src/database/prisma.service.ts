import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { withDbRetry } from '../common/retry';

/**
 * Duplicate of src/prisma/prisma.service.ts — this module is injected by
 * older code paths. Same retry + lazy-connect hardening applies.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PrismaService(database)');

  async onModuleInit() {
    this.attachTransientRetry();
    try {
      await withDbRetry(() => this.$connect(), { label: '$connect' });
    } catch (err) {
      this.logger.warn(
        `Initial $connect failed (${(err as any)?.code ?? 'unknown'}); ` +
        'continuing in lazy-connect mode.',
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  private attachTransientRetry() {
    const rawMethods = [
      '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe',
    ] as const;
    for (const name of rawMethods) {
      const original = (this as any)[name].bind(this);
      (this as any)[name] = (...args: any[]) =>
        withDbRetry(() => original(...args), { label: name });
    }
    const modelMethods = [
      'findFirst','findFirstOrThrow','findMany','findUnique','findUniqueOrThrow',
      'create','createMany','createManyAndReturn','update','updateMany',
      'upsert','delete','deleteMany','count','groupBy','aggregate',
    ];
    for (const key of Object.getOwnPropertyNames(this)) {
      const val = (this as any)[key];
      if (!val || typeof val !== 'object' || typeof val.findMany !== 'function') continue;
      for (const m of modelMethods) {
        if (typeof val[m] !== 'function') continue;
        const original = val[m].bind(val);
        val[m] = (...args: any[]) =>
          withDbRetry(() => original(...args), { label: `${key}.${m}` });
      }
    }
  }
}
