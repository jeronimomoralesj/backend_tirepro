-- Two optional construction fields on the master catalog:
--   cinturones  — belt config (e.g. "4B+2N", "Steel 2")
--   pr          — ply rating (e.g. "16", "18PR", "16/18")
-- Both nullable; pre-existing rows stay untouched.

ALTER TABLE "tire_master_catalog"
  ADD COLUMN "cinturones" TEXT,
  ADD COLUMN "pr"          TEXT;
