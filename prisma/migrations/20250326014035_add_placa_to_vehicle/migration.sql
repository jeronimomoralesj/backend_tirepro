/*
  Warnings:

  - Added the required column `companyId` to the `Tire` table without a default value. This is not possible if the table is not empty.
  - Added the required column `dimension` to the `Tire` table without a default value. This is not possible if the table is not empty.
  - Added the required column `diseno` to the `Tire` table without a default value. This is not possible if the table is not empty.
  - Added the required column `eje` to the `Tire` table without a default value. This is not possible if the table is not empty.
  - Added the required column `marca` to the `Tire` table without a default value. This is not possible if the table is not empty.
  - Added the required column `placa` to the `Tire` table without a default value. This is not possible if the table is not empty.
  - Added the required column `profundidadInicial` to the `Tire` table without a default value. This is not possible if the table is not empty.
  - Added the required column `carga` to the `Vehicle` table without a default value. This is not possible if the table is not empty.
  - Added the required column `companyId` to the `Vehicle` table without a default value. This is not possible if the table is not empty.
  - Added the required column `pesoCarga` to the `Vehicle` table without a default value. This is not possible if the table is not empty.
  - Added the required column `placa` to the `Vehicle` table without a default value. This is not possible if the table is not empty.
  - Added the required column `tipovhc` to the `Vehicle` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Tire" ADD COLUMN     "companyId" TEXT NOT NULL,
ADD COLUMN     "costo" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "dimension" TEXT NOT NULL,
ADD COLUMN     "diseno" TEXT NOT NULL,
ADD COLUMN     "eje" TEXT NOT NULL,
ADD COLUMN     "eventos" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "inspecciones" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "kilometrosRecorridos" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "marca" TEXT NOT NULL,
ADD COLUMN     "placa" TEXT NOT NULL,
ADD COLUMN     "posicion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "primeraVida" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "profundidadInicial" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "vehicleId" TEXT,
ADD COLUMN     "vida" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "carga" TEXT NOT NULL,
ADD COLUMN     "companyId" TEXT NOT NULL,
ADD COLUMN     "kilometrajeActual" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pesoCarga" DOUBLE PRECISION NOT NULL,
ADD COLUMN     "placa" TEXT NOT NULL,
ADD COLUMN     "tipovhc" TEXT NOT NULL,
ADD COLUMN     "tireCount" INTEGER NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tire" ADD CONSTRAINT "Tire_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tire" ADD CONSTRAINT "Tire_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
