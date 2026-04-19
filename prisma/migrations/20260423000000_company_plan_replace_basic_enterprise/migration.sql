-- =============================================================================
-- CompanyPlan: drop `basic` + `enterprise`, introduce `plus` + `marketplace`
-- =============================================================================
--
-- Product rename:
--   - `basic`       was an unused placeholder tier (newly-provisioned default).
--                   Collapse into `pro`.
--   - `enterprise`  was already UI-branded as "Plus" on the ajustes page.
--                   Rename in-place: enterprise → plus.
--   - `marketplace` new tier for users without a companyId / marketplace-only.
--
-- Postgres enum values can't be dropped with `ALTER TYPE DROP VALUE`, so we
-- replace the type with a "new enum + swap column + drop old type" dance.
-- =============================================================================

-- 1. Data migration: basic rows collapse to pro, enterprise rows become plus.
UPDATE "Company" SET "plan" = 'pro'  ::"CompanyPlan" WHERE "plan" = 'basic';

-- 2. Build the replacement enum.
CREATE TYPE "CompanyPlan_new" AS ENUM ('marketplace', 'plus', 'pro', 'distribuidor');

-- 3. Drop the column default (it's typed against the old enum and blocks the
--    type swap below).
ALTER TABLE "Company" ALTER COLUMN "plan" DROP DEFAULT;

-- 4. Swap the column type. `enterprise` coerces to `plus` via an explicit
--    CASE; every other value maps 1:1 by name. After step 1 no row has
--    'basic' so the cast is safe.
ALTER TABLE "Company"
  ALTER COLUMN "plan" TYPE "CompanyPlan_new"
  USING (
    CASE "plan"::text
      WHEN 'enterprise' THEN 'plus'::"CompanyPlan_new"
      ELSE "plan"::text::"CompanyPlan_new"
    END
  );

-- 5. Drop the old enum type.
DROP TYPE "CompanyPlan";

-- 6. Rename the new type to the canonical name Prisma generates against.
ALTER TYPE "CompanyPlan_new" RENAME TO "CompanyPlan";

-- 7. Install the new default.
ALTER TABLE "Company" ALTER COLUMN "plan" SET DEFAULT 'pro';
