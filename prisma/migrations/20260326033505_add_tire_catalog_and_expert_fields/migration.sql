-- CreateEnum
CREATE TYPE "TireDesignType" AS ENUM ('direccional', 'traccion', 'toda_posicion', 'mixto', 'regional');

-- AlterEnum
ALTER TYPE "TireEventType" ADD VALUE 'regrabado';

-- AlterTable
ALTER TABLE "Tire" ADD COLUMN     "dualPartnerId" TEXT,
ADD COLUMN     "isRegrabable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tipoDiseno" "TireDesignType";

-- CreateTable
CREATE TABLE "tire_master_catalog" (
    "id" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "modelo" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "skuRef" TEXT NOT NULL,
    "anchoMm" DOUBLE PRECISION,
    "perfil" TEXT,
    "rin" TEXT,
    "posicion" TEXT,
    "ejeTirePro" "EjeType",
    "terreno" TEXT,
    "pctPavimento" INTEGER NOT NULL DEFAULT 100,
    "pctDestapado" INTEGER NOT NULL DEFAULT 0,
    "rtdMm" DOUBLE PRECISION,
    "indiceCarga" TEXT,
    "indiceVelocidad" TEXT,
    "psiRecomendado" DOUBLE PRECISION,
    "pesoKg" DOUBLE PRECISION,
    "kmEstimadosReales" INTEGER,
    "kmEstimadosFabrica" INTEGER,
    "reencauchable" BOOLEAN NOT NULL DEFAULT false,
    "vidasReencauche" INTEGER NOT NULL DEFAULT 0,
    "precioCop" DOUBLE PRECISION,
    "cpkEstimado" DOUBLE PRECISION,
    "segmento" TEXT,
    "tipo" TEXT,
    "construccion" TEXT,
    "notasColombia" TEXT,
    "fuente" TEXT,
    "url" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tire_master_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tire_master_catalog_skuRef_key" ON "tire_master_catalog"("skuRef");

-- CreateIndex
CREATE INDEX "tire_master_catalog_marca_dimension_idx" ON "tire_master_catalog"("marca", "dimension");

-- CreateIndex
CREATE INDEX "tire_master_catalog_dimension_idx" ON "tire_master_catalog"("dimension");

-- CreateIndex
CREATE INDEX "tire_master_catalog_marca_modelo_idx" ON "tire_master_catalog"("marca", "modelo");

-- CreateIndex
CREATE INDEX "tire_master_catalog_ejeTirePro_idx" ON "tire_master_catalog"("ejeTirePro");

-- CreateIndex
CREATE INDEX "tire_master_catalog_terreno_idx" ON "tire_master_catalog"("terreno");

-- CreateIndex
CREATE INDEX "tire_master_catalog_dimension_ejeTirePro_idx" ON "tire_master_catalog"("dimension", "ejeTirePro");

-- CreateIndex
CREATE INDEX "tire_master_catalog_cpkEstimado_idx" ON "tire_master_catalog"("cpkEstimado");
