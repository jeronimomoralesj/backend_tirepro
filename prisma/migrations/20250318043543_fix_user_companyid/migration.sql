/*
  Warnings:

  - Added the required column `companyId` to the `User` table without a default value. This is not possible if the table is not empty.
  - Made the column `puntos` on table `User` required. This step will fail if there are existing NULL values in that column.
  - Made the column `role` on table `User` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "companyId" TEXT NOT NULL,
ADD COLUMN     "placas" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "puntos" SET NOT NULL,
ALTER COLUMN "role" SET NOT NULL,
ALTER COLUMN "role" SET DEFAULT 'regular';

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'Basic',
    "profileImage" TEXT NOT NULL DEFAULT 'https://example.com/default-image.jpg',
    "periodicity" TEXT NOT NULL DEFAULT 'daily',
    "vehicleCount" INTEGER NOT NULL DEFAULT 0,
    "userCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tire" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "placa" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "diseno" TEXT NOT NULL,
    "profundidadInicial" INTEGER NOT NULL,
    "dimension" TEXT NOT NULL,
    "eje" TEXT NOT NULL,
    "posicion" INTEGER NOT NULL DEFAULT 0,
    "kilometrosRecorridos" INTEGER NOT NULL DEFAULT 0,
    "vida" JSONB NOT NULL DEFAULT '[]',
    "costo" JSONB NOT NULL DEFAULT '[]',
    "inspecciones" JSONB NOT NULL DEFAULT '[]',
    "primeraVida" JSONB NOT NULL DEFAULT '[]',
    "eventos" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "Tire_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "placa" TEXT NOT NULL,
    "kilometraje_actual" INTEGER NOT NULL DEFAULT 0,
    "carga" TEXT NOT NULL,
    "peso_carga" DOUBLE PRECISION NOT NULL,
    "tipovhc" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_placa_key" ON "Vehicle"("placa");

-- AddForeignKey
ALTER TABLE "Tire" ADD CONSTRAINT "Tire_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tire" ADD CONSTRAINT "Tire_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
