-- CreateTable
CREATE TABLE "marketplace_views" (
    "id" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "distributorId" TEXT NOT NULL,
    "userId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "country" TEXT,
    "region" TEXT,
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketplace_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketplace_views_distributorId_targetType_createdAt_idx"
  ON "marketplace_views"("distributorId", "targetType", "createdAt");

-- CreateIndex
CREATE INDEX "marketplace_views_targetId_createdAt_idx"
  ON "marketplace_views"("targetId", "createdAt");

-- CreateIndex
CREATE INDEX "marketplace_views_distributorId_createdAt_idx"
  ON "marketplace_views"("distributorId", "createdAt");

-- AddForeignKey
ALTER TABLE "marketplace_views"
  ADD CONSTRAINT "marketplace_views_distributorId_fkey"
  FOREIGN KEY ("distributorId") REFERENCES "Company"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
