-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "configuracion" TEXT,
ADD COLUMN     "tipoOperacion" TEXT;

-- CreateIndex
CREATE INDEX "Vehicle_tipoOperacion_idx" ON "Vehicle"("tipoOperacion");

-- CreateIndex
CREATE INDEX "Vehicle_configuracion_idx" ON "Vehicle"("configuracion");
