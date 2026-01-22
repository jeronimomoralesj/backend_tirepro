-- CreateTable
CREATE TABLE "DistributorAccess" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "distributorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DistributorAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DistributorAccess_companyId_distributorId_key" ON "DistributorAccess"("companyId", "distributorId");

-- AddForeignKey
ALTER TABLE "DistributorAccess" ADD CONSTRAINT "DistributorAccess_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DistributorAccess" ADD CONSTRAINT "DistributorAccess_distributorId_fkey" FOREIGN KEY ("distributorId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
