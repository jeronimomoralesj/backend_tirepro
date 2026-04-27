-- Email + company verification gates new account signups.
--
-- Goal: stop a flood of bot/spam signups from polluting User/Company
-- tables. New accounts now start as unverified and must click a link
-- in a verification email within 48 hours, otherwise they're purged
-- by the auth-cleanup cron (see src/auth/auth-cleanup.cron.ts). A
-- TirePro admin can also manually verify a company at any time, which
-- spares the user/company from auto-deletion even if email click is
-- pending (e.g., for sales-led onboarding).
--
-- Existing rows are grandfathered: backfilling Company.isVerified=true
-- means current customers don't get scheduled for deletion when this
-- migration deploys.

ALTER TABLE "Company"
  ADD COLUMN "isVerified" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- Backfill: every pre-existing company is treated as verified so this
-- migration is non-destructive. New signups created after deploy will
-- default to false via the schema default.
UPDATE "Company"
   SET "isVerified" = true,
       "verifiedAt" = COALESCE("createdAt", NOW());

ALTER TABLE "User"
  ADD COLUMN "verificationTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3);

-- Backfill: any user already marked isVerified=true gets an
-- emailVerifiedAt timestamp so audit queries can rely on the column.
UPDATE "User"
   SET "emailVerifiedAt" = COALESCE("createdAt", NOW())
 WHERE "isVerified" = true;

-- Index lets the auth-cleanup cron sweep efficiently; without it, the
-- query would full-scan User every hour.
CREATE INDEX "User_isVerified_createdAt_idx"
  ON "User" ("isVerified", "createdAt")
  WHERE "isVerified" = false;
