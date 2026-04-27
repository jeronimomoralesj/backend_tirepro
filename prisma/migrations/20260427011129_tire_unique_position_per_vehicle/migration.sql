-- Tire position uniqueness per vehicle.
--
-- A vehicle should never have two tires on the same wheel position. The
-- prior schema only enforced this in application code, so concurrent
-- rotations or assignments could leave duplicates that broke the
-- vehicle.tires[pos] lookup in the UI.
--
-- Implemented as a partial unique INDEX (not a Prisma @@unique) because
-- both columns have legitimate "unassigned" values that must be allowed
-- to repeat:
--   • posicion = 0 means "no slot assigned yet" (in-transit or just
--     unmounted from a vehicle)
--   • vehicleId IS NULL means "in inventory, not on any vehicle"
--
-- The WHERE clause excludes those, so duplicates of (NULL, anything) and
-- (anything, 0) remain legal.
--
-- Pre-flight check: this migration will FAIL if any duplicate
-- (vehicleId, posicion) pairs already exist in production with
-- vehicleId IS NOT NULL AND posicion > 0. Run the SELECT below before
-- deploying; if it returns rows, those duplicates must be resolved
-- (manually pick which tire keeps the slot) before this migration can
-- apply cleanly.
--
--   SELECT "vehicleId", "posicion", COUNT(*)
--   FROM "Tire"
--   WHERE "vehicleId" IS NOT NULL AND "posicion" > 0
--   GROUP BY "vehicleId", "posicion"
--   HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX "Tire_vehicleId_posicion_unique"
  ON "Tire" ("vehicleId", "posicion")
  WHERE "vehicleId" IS NOT NULL AND "posicion" > 0;
