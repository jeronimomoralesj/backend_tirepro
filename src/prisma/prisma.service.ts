import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { withDbRetry } from '../common/retry';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit() {
    // Install retry wrappers BEFORE attempting the first connect — that
    // way even $connect() itself gets retried on a transient blip.
    this.attachTransientRetry();
    try {
      await withDbRetry(() => this.$connect(), { label: '$connect' });
      this.logger.log('Database connection established');
    } catch (err) {
      // Don't crash-loop the app if RDS is briefly unreachable at boot.
      // Prisma reconnects lazily on the first real query, and the retry
      // wrapper handles transient failures on those queries too.
      this.logger.warn(
        `Initial $connect failed (${(err as any)?.code ?? 'unknown'}); ` +
        'continuing in lazy-connect mode.',
      );
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  /**
   * Wrap both raw-query methods and typed-model delegates with transient
   * retry. Prisma's pool hands out stale connections after RDS / AWS NLB
   * idle-timeout kills them, so the first query after an idle period can
   * fail with P1001 even though the server is healthy. One retry after
   * 150ms picks up a fresh connection and succeeds.
   *
   * Prisma v6 removed $use middleware in favor of $extends, but $extends
   * returns a NEW client instance which would break all existing
   * injections. The workaround: iterate every own/inherited property
   * that looks like a model delegate (has `findMany` etc.) and wrap its
   * async methods. Also wrap the $* raw-query methods directly.
   */
  private attachTransientRetry() {
    // Raw-query methods on the client itself.
    const rawMethods = [
      '$queryRaw',
      '$queryRawUnsafe',
      '$executeRaw',
      '$executeRawUnsafe',
    ] as const;
    for (const name of rawMethods) {
      const original = (this as any)[name].bind(this);
      (this as any)[name] = (...args: any[]) =>
        withDbRetry(() => original(...args), { label: name });
    }

    // Typed-model delegates — anything with findMany is a model.
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
        const label = `${key}.${m}`;
        val[m] = (...args: any[]) => wrapPrismaPromise(() => original(...args), label);
      }
    }
  }
}

/**
 * Build a proxy thenable that behaves like a PrismaPromise.
 *
 * Why: Prisma's $transaction([...]) verifies each element with
 *   `l?.[Symbol.toStringTag] !== "PrismaPromise"`
 * and then calls `l.requestTransaction(...)` on each. A plain
 * `Promise` returned by our retry wrapper fails both checks.
 *
 * This proxy:
 *   • Passes the toStringTag check.
 *   • On await (`.then`/`.catch`/`.finally`) runs via withDbRetry so a
 *     transient RDS/NLB connection blip gets retried.
 *   • On `requestTransaction(payload)` creates a fresh real PrismaPromise
 *     and delegates — Prisma's transaction engine handles retries for us
 *     there, so we deliberately skip our own retry inside a transaction.
 *   • Is lazy like a real PrismaPromise — `makeReal()` isn't called until
 *     either .then or .requestTransaction runs.
 */
function wrapPrismaPromise<T>(makeReal: () => Promise<T>, label: string): any {
  let cachedRun: Promise<T> | null = null;
  const run = () => (cachedRun ??= withDbRetry(makeReal, { label }));
  return {
    [Symbol.toStringTag]: 'PrismaPromise',
    then:    (onFulfilled?: any, onRejected?: any) => run().then(onFulfilled, onRejected),
    catch:   (onRejected?: any)                    => run().catch(onRejected),
    finally: (onFinally?: any)                     => run().finally(onFinally),
    requestTransaction(payload: unknown, lock?: unknown) {
      const real = makeReal() as unknown as {
        requestTransaction?: (payload: unknown, lock?: unknown) => unknown;
      };
      return real.requestTransaction?.(payload, lock) ?? real;
    },
  };
}
