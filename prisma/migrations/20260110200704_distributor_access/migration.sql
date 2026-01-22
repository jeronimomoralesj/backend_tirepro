/*
  Warnings:

  - The primary key for the `DistributorAccess` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `DistributorAccess` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "DistributorAccess_companyId_distributorId_key";

-- AlterTable
ALTER TABLE "DistributorAccess" DROP CONSTRAINT "DistributorAccess_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "DistributorAccess_pkey" PRIMARY KEY ("companyId", "distributorId");
