-- Backfill `userId` on marketplace_orders that were placed while the
-- buyer was logged in but the checkout endpoint dropped the link
-- (req.user was undefined on the public /payments/wompi/checkout
-- route until the JwtService-based optional decode landed).
--
-- Strategy: match by case-insensitive email. We never overwrite a row
-- that already has a userId, and we only assign when there's exactly
-- one User with that email — User.email has a UNIQUE constraint so
-- "exactly one" is enforced at the schema level.
--
-- Idempotent: running the migration twice on the same data is a no-op.
UPDATE "marketplace_orders" mo
SET "userId" = u.id
FROM "User" u
WHERE mo."userId" IS NULL
  AND mo."buyerEmail" IS NOT NULL
  AND lower(mo."buyerEmail") = lower(u.email);
