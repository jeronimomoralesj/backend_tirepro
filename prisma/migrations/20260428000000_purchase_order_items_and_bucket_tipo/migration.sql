-- =============================================================================
-- Relational PurchaseOrderItem + system-managed inventory bucket kinds.
--
-- Replaces the PurchaseOrder.items / PurchaseOrder.cotizacion JSON blobs with
-- a proper PurchaseOrderItem table so reencauche orders can track per-tire
-- state (en_reencauche_bucket → aprobada/rechazada → entregada) without
-- mutating shared JSON. Adds a `tipo` enum to tire_inventory_buckets so the
-- system can auto-manage the Reencauche bucket without magic-name matching.
--
-- DESTRUCTIVE on purchase_orders only: drops the `items` and `cotizacion` JSON
-- columns. Safe here because no live purchase orders exist yet (confirmed
-- with the product owner before this migration).
-- =============================================================================

-- ── New enums ───────────────────────────────────────────────────────────────

CREATE TYPE "PurchaseOrderItemStatus" AS ENUM (
  'pendiente',
  'cotizada',
  'en_reencauche_bucket',
  'aprobada',
  'rechazada',
  'entregada',
  'completada',
  'cancelada'
);

CREATE TYPE "InventoryBucketTipo" AS ENUM (
  'disponible',
  'reencauche',
  'fin_de_vida'
);

-- ── tire_inventory_buckets: add tipo ───────────────────────────────────────

ALTER TABLE "tire_inventory_buckets"
  ADD COLUMN "tipo" "InventoryBucketTipo" NOT NULL DEFAULT 'disponible';

CREATE INDEX "tire_inventory_buckets_companyId_tipo_idx"
  ON "tire_inventory_buckets"("companyId", "tipo");

-- ── purchase_orders: drop JSON blobs (empty in production) ─────────────────

ALTER TABLE "purchase_orders" DROP COLUMN IF EXISTS "items";
ALTER TABLE "purchase_orders" DROP COLUMN IF EXISTS "cotizacion";

-- ── purchase_order_items: new relational line-item table ───────────────────

CREATE TABLE "purchase_order_items" (
  "id"                TEXT                      NOT NULL,
  "purchaseOrderId"   TEXT                      NOT NULL,
  "tireId"            TEXT,

  "tipo"              TEXT                      NOT NULL,           -- 'nueva' | 'reencauche'
  "marca"             TEXT                      NOT NULL,
  "modelo"            TEXT,
  "dimension"         TEXT                      NOT NULL,
  "eje"               TEXT,
  "cantidad"          INTEGER                   NOT NULL DEFAULT 1,
  "vehiclePlaca"      TEXT,
  "urgency"           TEXT,
  "notas"             TEXT,

  -- Quote fields — filled by dist at cotizacion time
  "precioUnitario"    DOUBLE PRECISION,
  "disponible"        BOOLEAN,
  "tiempoEntrega"     TEXT,
  "cotizacionNotas"   TEXT,

  -- Lifecycle
  "status"            "PurchaseOrderItemStatus" NOT NULL DEFAULT 'pendiente',
  "estimatedDelivery" TIMESTAMP(3),
  "motivoRechazo"     TEXT,
  "finalizedAt"       TIMESTAMP(3),

  -- Reencauche vida trail
  "vidaPrevia"        "VidaValue",
  "vidaNueva"         "VidaValue",

  "createdAt"         TIMESTAMP(3)              NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3)              NOT NULL,

  CONSTRAINT "purchase_order_items_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "purchase_order_items_purchaseOrderId_idx"
  ON "purchase_order_items"("purchaseOrderId");

CREATE INDEX "purchase_order_items_tireId_idx"
  ON "purchase_order_items"("tireId");

CREATE INDEX "purchase_order_items_status_idx"
  ON "purchase_order_items"("status");

-- Accelerates the "does this tire have an active reencauche cycle?" lookup
CREATE INDEX "purchase_order_items_tireId_status_idx"
  ON "purchase_order_items"("tireId", "status");

-- Cascade on order delete (items are part of the order); set-null on tire
-- delete so deleting a tire doesn't lose the historical order record.
ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "purchase_order_items_purchaseOrderId_fkey"
  FOREIGN KEY ("purchaseOrderId") REFERENCES "purchase_orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "purchase_order_items"
  ADD CONSTRAINT "purchase_order_items_tireId_fkey"
  FOREIGN KEY ("tireId") REFERENCES "Tire"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
