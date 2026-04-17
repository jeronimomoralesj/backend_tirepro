-- Adds lifetime CPK columns: the per-tire CPK computed across ALL vidas
-- (sum of costs ÷ sum of km lived). Used by company-level dashboard metrics.
-- currentCpk stays as the current-life CPK for per-vida breakdowns.
ALTER TABLE "Tire" ADD COLUMN IF NOT EXISTS "lifetimeCpk" DOUBLE PRECISION;
ALTER TABLE "inspecciones" ADD COLUMN IF NOT EXISTS "lifetimeCpk" DOUBLE PRECISION;
