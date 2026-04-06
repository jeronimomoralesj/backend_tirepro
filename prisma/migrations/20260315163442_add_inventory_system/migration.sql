-- AlterTable
ALTER TABLE "Tire" ADD COLUMN     "inventoryBucketId" TEXT,
ADD COLUMN     "inventoryEnteredAt" TIMESTAMP(3),
ADD COLUMN     "inventoryTag" TEXT,
ADD COLUMN     "lastPosicion" INTEGER,
ADD COLUMN     "lastVehicleId" TEXT,
ADD COLUMN     "lastVehiclePlaca" TEXT;

-- CreateTable
CREATE TABLE "tire_inventory_buckets" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "color" TEXT,
    "icono" TEXT,
    "excluirDeFlota" BOOLEAN NOT NULL DEFAULT false,
    "orden" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tire_inventory_buckets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tire_inventory_buckets_companyId_idx" ON "tire_inventory_buckets"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "tire_inventory_buckets_companyId_nombre_key" ON "tire_inventory_buckets"("companyId", "nombre");

-- CreateIndex
CREATE INDEX "Tire_companyId_inventoryBucketId_idx" ON "Tire"("companyId", "inventoryBucketId");

-- CreateIndex
CREATE INDEX "Tire_companyId_inventoryEnteredAt_idx" ON "Tire"("companyId", "inventoryEnteredAt");

-- AddForeignKey
ALTER TABLE "Tire" ADD CONSTRAINT "Tire_inventoryBucketId_fkey" FOREIGN KEY ("inventoryBucketId") REFERENCES "tire_inventory_buckets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tire_inventory_buckets" ADD CONSTRAINT "tire_inventory_buckets_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
