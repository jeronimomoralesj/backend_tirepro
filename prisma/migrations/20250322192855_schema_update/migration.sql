/*
  Warnings:

  - You are about to drop the column `vehicleCount` on the `Company` table. All the data in the column will be lost.
  - The `periodicity` column on the `Company` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `companyId` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `costo` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `dimension` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `diseno` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `eje` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `eventos` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `inspecciones` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `kilometros_recorridos` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `marca` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `placa` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `posicion` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `primeraVida` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `profundidadInicial` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `vehicleId` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `vida` on the `Tire` table. All the data in the column will be lost.
  - You are about to drop the column `placas` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `carga` on the `Vehicle` table. All the data in the column will be lost.
  - You are about to drop the column `companyId` on the `Vehicle` table. All the data in the column will be lost.
  - You are about to drop the column `kilometrajeActual` on the `Vehicle` table. All the data in the column will be lost.
  - You are about to drop the column `pesoCarga` on the `Vehicle` table. All the data in the column will be lost.
  - You are about to drop the column `placa` on the `Vehicle` table. All the data in the column will be lost.
  - You are about to drop the column `tipovhc` on the `Vehicle` table. All the data in the column will be lost.
  - You are about to drop the column `tireCount` on the `Vehicle` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Tire" DROP CONSTRAINT "Tire_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Tire" DROP CONSTRAINT "Tire_vehicleId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_companyId_fkey";

-- DropForeignKey
ALTER TABLE "Vehicle" DROP CONSTRAINT "Vehicle_companyId_fkey";

-- DropIndex
DROP INDEX "User_email_key";

-- DropIndex
DROP INDEX "Vehicle_placa_key";

-- AlterTable
ALTER TABLE "Company" DROP COLUMN "vehicleCount",
ADD COLUMN     "tireCount" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "plan" SET DEFAULT 'basic',
ALTER COLUMN "profileImage" SET DEFAULT 'https://tireproimages.s3.us-east-1.amazonaws.com/companyResources/logoFull.png',
DROP COLUMN "periodicity",
ADD COLUMN     "periodicity" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "Tire" DROP COLUMN "companyId",
DROP COLUMN "costo",
DROP COLUMN "dimension",
DROP COLUMN "diseno",
DROP COLUMN "eje",
DROP COLUMN "eventos",
DROP COLUMN "inspecciones",
DROP COLUMN "kilometros_recorridos",
DROP COLUMN "marca",
DROP COLUMN "placa",
DROP COLUMN "posicion",
DROP COLUMN "primeraVida",
DROP COLUMN "profundidadInicial",
DROP COLUMN "vehicleId",
DROP COLUMN "vida";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "placas",
ADD COLUMN     "plates" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "role" SET DEFAULT 'admin';

-- AlterTable
ALTER TABLE "Vehicle" DROP COLUMN "carga",
DROP COLUMN "companyId",
DROP COLUMN "kilometrajeActual",
DROP COLUMN "pesoCarga",
DROP COLUMN "placa",
DROP COLUMN "tipovhc",
DROP COLUMN "tireCount";
