-- Defensive grandfather pass for existing users.
--
-- The previous migration (20260427131909_email_verification_required)
-- backfilled Company.isVerified=true for every existing company so live
-- customers wouldn't get scheduled for deletion when the auth-cleanup
-- cron starts running. It also stamped emailVerifiedAt on users that
-- were already isVerified=true.
--
-- What it did NOT do is flip any User.isVerified=false rows to true.
-- Application code always created users with isVerified=true, so this
-- shouldn't matter in practice — but raw-SQL inserts, half-completed
-- test data, or any historical anomaly could leave such rows behind.
-- Without this grandfather pass those rows are at risk of being
-- purged by the cron 48h after their createdAt, even though they
-- predate the email-verification policy.
--
-- This migration:
--   1. Marks any pre-existing unverified user as verified.
--   2. Stamps emailVerifiedAt for them.
--   3. Clears any leftover verificationToken / verificationTokenExpiresAt
--      so old tokens can't be replayed.
--
-- Cutoff: only rows whose createdAt is before this migration's
-- application time. New signups created AFTER the migration runs are
-- correctly subject to the verification policy and must NOT be touched
-- by this backfill — that's why we filter on createdAt.
--
-- Idempotent — running again is a no-op once the rows are flipped.

UPDATE "User"
   SET "isVerified"                 = true,
       "emailVerifiedAt"             = COALESCE("emailVerifiedAt", "createdAt", NOW()),
       "verificationToken"           = NULL,
       "verificationTokenExpiresAt"  = NULL
 WHERE "isVerified" = false
   AND "createdAt"  < NOW();
