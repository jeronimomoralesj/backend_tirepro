-- Adds two distribuidor-only user roles for the catalog datasheet module:
--   • catalogo       — sales rep: search/edit/download the SKU catalog
--   • catalogo_admin — sales manager: same + downloads-stats dashboard
--
-- Additive only. Existing admin / viewer / technician rows keep their roles.
-- Postgres 12+ allows ALTER TYPE ADD VALUE inside a transaction; the catch
-- is the new value can't be referenced in the same transaction, so these
-- statements must land standalone. The Prisma migration runner handles
-- them individually.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'catalogo';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'catalogo_admin';
