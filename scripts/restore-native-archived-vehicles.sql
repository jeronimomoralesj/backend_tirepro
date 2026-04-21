-- =============================================================================
-- Restore native TirePro vehicles (NOT merquepro) that were swept by the
-- stale-data archive job. The archive rule ("no inspection in 1+ year →
-- archivedAt = NOW()") caught native vehicles whose fleets are actually
-- still active TirePro customers — they just hadn't been inspected
-- recently. The follow-on tire-unassign moved their tires to Disponible,
-- so these clients ended up with "no vehicles, tires floating."
--
-- Restoration rule:
--   • archivedAt IS NOT NULL
--   • companyId IS NOT NULL
--   • externalSourceId IS NULL  OR  NOT LIKE 'merquepro:%'   (native only)
--
-- Does NOT touch merquepro orphan vehicles (those were orphaned by the
-- 10-month activity rule and are correctly hidden).
--
-- Idempotent. Usage:
--   psql "$DATABASE_URL" -f scripts/restore-native-archived-vehicles.sql
-- =============================================================================

BEGIN;
SET LOCAL statement_timeout = '2min';

CREATE TEMP TABLE _to_restore ON COMMIT DROP AS
SELECT v.id, v."companyId"
  FROM "Vehicle" v
 WHERE v."archivedAt" IS NOT NULL
   AND v."companyId" IS NOT NULL
   AND (v."externalSourceId" IS NULL OR v."externalSourceId" NOT LIKE 'merquepro:%');

-- 1) Un-archive the vehicles.
UPDATE "Vehicle" v
   SET "archivedAt" = NULL
  FROM _to_restore r
 WHERE v.id = r.id;

-- 2) Reassign their tires (the archive job had bumped tires to inventory).
UPDATE "Tire" t
   SET "vehicleId"          = t."lastVehicleId",
       "posicion"           = COALESCE(t."lastPosicion", 0),
       "inventoryBucketId"  = NULL,
       "inventoryEnteredAt" = NULL,
       "lastVehicleId"      = NULL,
       "lastVehiclePlaca"   = NULL,
       "lastPosicion"       = NULL
  FROM _to_restore r
 WHERE t."lastVehicleId" = r.id
   AND t."vehicleId" IS NULL;

COMMIT;
