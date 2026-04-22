-- =============================================================================
-- Normalize every stored tire dimension to the canonical form:
--   • All whitespace stripped
--   • Upper-cased (only the 'r' actually changes; digits and punctuation
--     upper-case to themselves)
--
-- Before:  "295/80r22.5", " 12 r 22.5", "295/80R22.5"
-- After:   "295/80R22.5", "12R22.5",   "295/80R22.5"
--
-- All write paths (tire create/update/bulk upload, catalog upsert/admin,
-- distributor listing, bid request items, purchase order items) now pass
-- through src/common/normalize-dimension.ts so new records match.
-- =============================================================================

-- ── Tire benchmarks: dedupe BEFORE normalizing ───────────────────────────────
-- The model carries @@unique([marca, diseno, dimension]). If two case
-- variants already exist for the same benchmark (unlikely — current code
-- already lower-cases on write — but defensive), normalizing would violate
-- the constraint. Keep the row with the most recent updatedAt; break ties
-- by id to be deterministic.
WITH dedup AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY
        LOWER("marca"),
        LOWER("diseno"),
        UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'))
      ORDER BY "updatedAt" DESC NULLS LAST, id ASC
    ) AS rn
  FROM "tire_benchmarks"
  WHERE "dimension" IS NOT NULL
)
DELETE FROM "tire_benchmarks"
WHERE id IN (SELECT id FROM dedup WHERE rn > 1);

-- ── Normalize every dimension column across the six tables ──────────────────
-- Each UPDATE is idempotent: the WHERE clause skips rows already canonical,
-- so re-running the migration is a no-op and cheap on large tables (the
-- scan hits a sequential read, but the write volume matches the fix-up size).

UPDATE "Tire"
   SET "dimension" = UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'))
 WHERE "dimension" IS NOT NULL
   AND "dimension" <> UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'));

UPDATE "tire_vida_snapshots"
   SET "dimension" = UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'))
 WHERE "dimension" IS NOT NULL
   AND "dimension" <> UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'));

UPDATE "vehicle_tire_history"
   SET "dimension" = UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'))
 WHERE "dimension" IS NOT NULL
   AND "dimension" <> UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'));

UPDATE "tire_master_catalog"
   SET "dimension" = UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'))
 WHERE "dimension" IS NOT NULL
   AND "dimension" <> UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'));

UPDATE "distributor_listings"
   SET "dimension" = UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'))
 WHERE "dimension" IS NOT NULL
   AND "dimension" <> UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'));

UPDATE "tire_benchmarks"
   SET "dimension" = UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'))
 WHERE "dimension" IS NOT NULL
   AND "dimension" <> UPPER(REGEXP_REPLACE("dimension", '\s+', '', 'g'));
