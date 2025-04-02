/*
  Warnings:

  - You are about to drop the column `kilometrosRecorridos` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `kilometraje_actual` on the `Vehicle` table. All the data in the column will be lost.
  - You are about to drop the column `peso_carga` on the `Vehicle` table. All the data in the column will be lost.
  - Added the required column `pesoCarga` to the `Vehicle` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Tire" DROP COLUMN "kilometrosRecorridos",
ADD COLUMN     "kilometros_recorridos" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Vehicle" DROP COLUMN "kilometraje_actual",
DROP COLUMN "peso_carga",
ADD COLUMN     "kilometrajeActual" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pesoCarga" DOUBLE PRECISION NOT NULL;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
