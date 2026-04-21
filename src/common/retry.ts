import { Logger } from '@nestjs/common';

const log = new Logger('RetryHelper');

/**
 * Codes + error-message substrings we consider transient and worth retrying.
 * Prisma doesn't auto-retry on P1001 ("can't reach DB") — when AWS NLB or
 * RDS kills an idle connection in the Prisma pool, the next query picks up
 * that dead socket and fails instantly. One quick retry almost always fixes
 * it because Prisma transparently establishes a new connection on the
 * second attempt.
 */
const TRANSIENT_CODES = new Set<string>([
  'P1001', // Can't reach database server
  'P1002', // Timed out
  'P1008', // Operations timed out
  'P1017', // Server has closed the connection
]);

const TRANSIENT_MESSAGE_FRAGMENTS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'Connection terminated',
  'Connection timed out',
  'server closed the connection',
];

function isTransient(err: unknown): boolean {
  const anyErr = err as { code?: string; message?: string };
  if (anyErr?.code && TRANSIENT_CODES.has(anyErr.code)) return true;
  const msg = anyErr?.message ?? '';
  return TRANSIENT_MESSAGE_FRAGMENTS.some((frag) => msg.includes(frag));
}

/**
 * Wrap a DB-touching function in bounded retries. Default: 3 attempts with
 * 150ms / 500ms backoff. Only retries transient connection errors — a
 * constraint violation or bad query is raised immediately.
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  opts?: { attempts?: number; label?: string },
): Promise<T> {
  const attempts = opts?.attempts ?? 3;
  const backoffsMs = [150, 500];
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || i === attempts - 1) throw err;
      const wait = backoffsMs[Math.min(i, backoffsMs.length - 1)];
      log.warn(
        `${opts?.label ?? 'db'} attempt ${i + 1}/${attempts} failed ` +
        `(${(err as any)?.code ?? (err as any)?.message?.slice(0, 60)}). ` +
        `Retrying in ${wait}ms.`,
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
