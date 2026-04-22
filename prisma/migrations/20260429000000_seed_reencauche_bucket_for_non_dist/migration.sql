-- =============================================================================
-- Ensure every non-distribuidor company has a system-managed Reencauche
-- bucket, and that bucket is tagged with tipo='reencauche' so the
-- reencauche flow can find it reliably.
--
-- Two cases to handle:
--   (1) Legacy companies whose Reencauche bucket was lazy-seeded BEFORE we
--       added the tipo column → bucket exists by name but tipo is still
--       the default 'disponible'. Fix with UPDATE.
--   (2) Companies that never touched inventory since the schema migration
--       and have no Reencauche bucket at all. Fix with INSERT.
--
-- Distribuidores don't run reencauche so they are skipped in both cases.
-- Idempotent: safe to re-run; each step is guarded.
-- =============================================================================

-- (1) Promote any legacy "Reencauche" bucket to tipo='reencauche' for non-dist companies
UPDATE "tire_inventory_buckets" b
SET    "tipo" = 'reencauche'::"InventoryBucketTipo"
FROM   "Company" c
WHERE  b."companyId" = c."id"
  AND  c."plan"      <> 'distribuidor'
  AND  b."nombre"    = 'Reencauche'
  AND  b."tipo"      <> 'reencauche'::"InventoryBucketTipo";

-- (2) Insert a Reencauche bucket for any non-dist company that still lacks one
INSERT INTO "tire_inventory_buckets" (
  "id",
  "companyId",
  "nombre",
  "color",
  "icono",
  "excluirDeFlota",
  "orden",
  "tipo",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  c."id",
  'Reencauche',
  '#8b5cf6',
  '♻️',
  FALSE,
  0,
  'reencauche'::"InventoryBucketTipo",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Company" c
WHERE c."plan" <> 'distribuidor'
  AND NOT EXISTS (
    SELECT 1
    FROM "tire_inventory_buckets" b
    WHERE b."companyId" = c."id"
      AND b."nombre"    = 'Reencauche'
  );
