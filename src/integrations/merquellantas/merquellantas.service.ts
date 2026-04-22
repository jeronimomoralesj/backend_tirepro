import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

/**
 * Runs the Merquellantas sync pipeline (fetch + import) as a child process.
 *
 * Why shell out instead of importing the fetch/import logic as a module:
 *   • Both scripts are long-running (minutes → hours on a cold DB) and
 *     memory-heavy (full tire dump held in RAM during dedup). Running
 *     them as children lets the Nest worker recycle its heap between
 *     runs and keeps the request-handling pool free.
 *   • Stdout/stderr stream straight to PM2 logs the same way ad-hoc
 *     `npx ts-node scripts/…` runs do, so ops playbook doesn't change.
 *   • The importer already has --apply gating and idempotency; forwarding
 *     the flag is simpler than re-implementing safeties in Nest.
 */
@Injectable()
export class MerquellantasService {
  private readonly logger = new Logger(MerquellantasService.name);
  private running = false;

  /** Default: fetch only, since yesterday, then import with --apply. */
  async runDailySync(opts: { apply?: boolean; sinceDays?: number } = {}) {
    const apply = opts.apply ?? true;
    const sinceDays = opts.sinceDays ?? 2;
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    return this.runPipeline({ since, apply, skipRefresh: true });
  }

  /** One-shot full migration — no --since filter, refreshes analytics. */
  async runFullMigration(opts: { apply?: boolean } = {}) {
    return this.runPipeline({ apply: opts.apply ?? false, skipRefresh: false });
  }

  private async runPipeline(opts: { since?: string; apply: boolean; skipRefresh: boolean }) {
    if (this.running) {
      throw new BadRequestException('A Merquellantas sync is already running');
    }
    if (!process.env.MERQUELLANTAS_TOKEN) {
      throw new BadRequestException('MERQUELLANTAS_TOKEN is not configured');
    }
    this.running = true;
    const started = Date.now();
    try {
      this.logger.log(`Sync starting (apply=${opts.apply}, since=${opts.since ?? 'full'})`);
      await this.runScript('scripts/fetch-merquellantas-api.ts', [
        ...(opts.since ? [`--since=${opts.since}`] : []),
      ]);
      if (opts.apply) {
        await this.runScript('scripts/import-merquepro.ts', [
          '--apply',
          ...(opts.skipRefresh ? ['--skip-refresh'] : []),
        ]);
      } else {
        this.logger.log('apply=false — import skipped');
      }
      const elapsed = Math.round((Date.now() - started) / 1000);
      this.logger.log(`Sync finished in ${elapsed}s`);
      return { ok: true, elapsedSeconds: elapsed };
    } finally {
      this.running = false;
    }
  }

  /**
   * Spawns `npx ts-node <script> <args...>` from the backend repo root.
   * Resolves only on exit code 0; rejects otherwise so the caller sees the
   * failure instead of silently marking the sync as "done".
   */
  private runScript(script: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      // Repo root = two levels above this file (src/integrations/merquellantas)
      const cwd = path.resolve(__dirname, '..', '..', '..');
      const child = spawn('npx', ['ts-node', script, ...args], {
        cwd,
        env: process.env,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${script} exited with code ${code}`));
      });
    });
  }

  isRunning(): boolean {
    return this.running;
  }
}
