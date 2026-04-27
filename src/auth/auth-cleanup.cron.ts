// Hourly cron that purges unverified accounts older than 48 hours.
//
// Goal: prevent a backlog of stale signups (bots, mistyped emails, users
// who never followed through) from polluting the User table. The check
// is intentionally conservative — a user is only deleted when BOTH:
//
//   1. The user themselves never verified their email (isVerified=false), AND
//   2. Their company is also unverified — i.e. no TirePro admin has
//      manually promoted the tenant. A verified company means a real
//      sales touch landed; we don't want to nuke users whose onboarding
//      is being handled offline even if they're slow to click the link.
//
// Users with no companyId (standalone /auth/register signups) are
// included because there's no "manual verification" lifeline for them.
//
// When a deleted user was the SOLE user of an unverified company, the
// company is removed too (cascade is handled by Prisma's onDelete on
// the User.companyId relation, but we also explicitly clean up empty
// unverified companies so a half-completed signup doesn't leave a
// dangling tenant).

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../database/prisma.service';

const PURGE_AFTER_MS = 48 * 60 * 60 * 1000;

@Injectable()
export class AuthCleanupCron {
  private readonly logger = new Logger(AuthCleanupCron.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'auth-cleanup-unverified' })
  async purgeUnverifiedAccounts() {
    const cutoff = new Date(Date.now() - PURGE_AFTER_MS);

    // Two-step delete so we can also clean up orphaned companies.
    //
    // Step 1 — find candidates. A user is purgeable when:
    //   • isVerified=false
    //   • createdAt < cutoff (now - 48h)
    //   • their company (if any) is also isVerified=false
    //
    // The partial index User_isVerified_createdAt_idx (added in the
    // 20260427131909_email_verification_required migration) makes this
    // query fast even on a large User table.
    const candidates = await this.prisma.user.findMany({
      where: {
        isVerified: false,
        createdAt:  { lt: cutoff },
        OR: [
          { companyId: null },
          { company:   { isVerified: false } },
        ],
      },
      select: {
        id:        true,
        email:     true,
        companyId: true,
      },
    });

    if (candidates.length === 0) {
      this.logger.debug('No unverified accounts past TTL — nothing to purge.');
      return;
    }

    // Track which companies might be left empty after the user delete.
    const companyIds = new Set(
      candidates
        .map((c) => c.companyId)
        .filter((id): id is string => !!id),
    );

    // Step 2 — delete the users. Wrapped in a transaction so the
    // company-orphan check below sees a consistent snapshot.
    await this.prisma.$transaction(async (tx) => {
      await tx.user.deleteMany({
        where: { id: { in: candidates.map((c) => c.id) } },
      });

      for (const companyId of companyIds) {
        // Only delete companies that are still unverified AND have zero
        // remaining users. A verified company should never be deleted by
        // this job even if it ends up with no users (paid customer in
        // transition between teams). A company with surviving verified
        // users is also kept (the purge only nuked one of multiple).
        const remaining = await tx.user.count({ where: { companyId } });
        if (remaining > 0) continue;

        const company = await tx.company.findUnique({
          where:  { id: companyId },
          select: { isVerified: true },
        });
        if (!company || company.isVerified) continue;

        await tx.company.delete({ where: { id: companyId } });
      }
    });

    this.logger.log(
      `Purged ${candidates.length} unverified user${candidates.length === 1 ? '' : 's'} ` +
      `(emails: ${candidates.map((c) => c.email).slice(0, 5).join(', ')}` +
      `${candidates.length > 5 ? ', …' : ''})`,
    );
  }
}
