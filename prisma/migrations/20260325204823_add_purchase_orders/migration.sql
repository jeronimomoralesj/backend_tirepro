-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "distributorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'solicitud_enviada',
    "items" JSONB NOT NULL,
    "totalEstimado" DOUBLE PRECISION,
    "notas" TEXT,
    "cotizacion" JSONB,
    "totalCotizado" DOUBLE PRECISION,
    "cotizacionFecha" TIMESTAMP(3),
    "cotizacionNotas" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "purchase_orders_companyId_status_idx" ON "purchase_orders"("companyId", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_distributorId_status_idx" ON "purchase_orders"("distributorId", "status");

-- CreateIndex
CREATE INDEX "purchase_orders_createdAt_idx" ON "purchase_orders"("createdAt");

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_distributorId_fkey" FOREIGN KEY ("distributorId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
