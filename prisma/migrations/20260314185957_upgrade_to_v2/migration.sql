/*
  Warnings:

  - A unique constraint covering the columns `[companyId,placa]` on the table `Vehicle` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "VidaValue" AS ENUM ('nueva', 'reencauche1', 'reencauche2', 'reencauche3', 'fin');

-- CreateEnum
CREATE TYPE "InspeccionSource" AS ENUM ('manual', 'bulk_upload', 'computer_vision', 'api');

-- CreateEnum
CREATE TYPE "MotivoFinVida" AS ENUM ('reencauche', 'desgaste', 'dano_mecanico', 'dano_operacional', 'accidente', 'preventivo', 'otro');

-- AlterTable
ALTER TABLE "Tire" ADD COLUMN     "currentPresionPsi" DOUBLE PRECISION,
ADD COLUMN     "totalVidas" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "vidaActual" "VidaValue" NOT NULL DEFAULT 'nueva';

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "presionesRecomendadas" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "company_snapshots" ADD COLUMN     "presionPromedioFlota" DOUBLE PRECISION,
ADD COLUMN     "retreadCount" INTEGER,
ADD COLUMN     "retreadRoiFlota" DOUBLE PRECISION,
ADD COLUMN     "tiresConBajaPresion" INTEGER,
ADD COLUMN     "tiresConPresionData" INTEGER,
ADD COLUMN     "tiresNueva" INTEGER,
ADD COLUMN     "tiresReencauche1" INTEGER,
ADD COLUMN     "tiresReencauche2" INTEGER,
ADD COLUMN     "tiresReencauche3" INTEGER;

-- AlterTable
ALTER TABLE "inspecciones" ADD COLUMN     "cvConfidence" DOUBLE PRECISION,
ADD COLUMN     "cvModelVersion" TEXT,
ADD COLUMN     "cvProfundidadCen" DOUBLE PRECISION,
ADD COLUMN     "cvProfundidadExt" DOUBLE PRECISION,
ADD COLUMN     "cvProfundidadInt" DOUBLE PRECISION,
ADD COLUMN     "inspeccionadoPorId" TEXT,
ADD COLUMN     "inspeccionadoPorNombre" TEXT,
ADD COLUMN     "presionDelta" DOUBLE PRECISION,
ADD COLUMN     "presionPsi" DOUBLE PRECISION,
ADD COLUMN     "presionRecomendadaPsi" DOUBLE PRECISION,
ADD COLUMN     "source" "InspeccionSource" NOT NULL DEFAULT 'manual',
ADD COLUMN     "vidaAlMomento" "VidaValue" NOT NULL DEFAULT 'nueva';

-- AlterTable
ALTER TABLE "tire_costos" ADD COLUMN     "concepto" TEXT;

-- CreateTable
CREATE TABLE "vehicle_inspections" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "realizadoPor" TEXT,
    "kmActual" INTEGER,
    "presionPromedioPsi" DOUBLE PRECISION,
    "tiresInspeccionadas" INTEGER,
    "alineacionOk" BOOLEAN,
    "balanceoOk" BOOLEAN,
    "freinosOk" BOOLEAN,
    "suspensionOk" BOOLEAN,
    "cargaConformeKg" DOUBLE PRECISION,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_inspections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tire_vida_snapshots" (
    "id" TEXT NOT NULL,
    "tireId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "vida" "VidaValue" NOT NULL,
    "marca" TEXT NOT NULL,
    "diseno" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "eje" "EjeType" NOT NULL,
    "posicion" INTEGER,
    "bandaNombre" TEXT,
    "bandaMarca" TEXT,
    "proveedor" TEXT,
    "costoInicial" DOUBLE PRECISION NOT NULL,
    "costoTotal" DOUBLE PRECISION NOT NULL,
    "fechaInicio" TIMESTAMP(3) NOT NULL,
    "fechaFin" TIMESTAMP(3) NOT NULL,
    "diasTotales" INTEGER NOT NULL,
    "mesesTotales" DOUBLE PRECISION NOT NULL,
    "profundidadInicial" DOUBLE PRECISION NOT NULL,
    "profundidadFinal" DOUBLE PRECISION NOT NULL,
    "mmDesgastados" DOUBLE PRECISION NOT NULL,
    "mmDesgastadosPorMes" DOUBLE PRECISION,
    "mmDesgastadosPor1000km" DOUBLE PRECISION,
    "profundidadIntFinal" DOUBLE PRECISION,
    "profundidadCenFinal" DOUBLE PRECISION,
    "profundidadExtFinal" DOUBLE PRECISION,
    "desgasteIrregular" BOOLEAN NOT NULL DEFAULT false,
    "kmTotales" INTEGER NOT NULL,
    "kmProyectadoFinal" DOUBLE PRECISION,
    "cpkFinal" DOUBLE PRECISION,
    "cptFinal" DOUBLE PRECISION,
    "cpkProyectadoFinal" DOUBLE PRECISION,
    "cptProyectadoFinal" DOUBLE PRECISION,
    "cpkMin" DOUBLE PRECISION,
    "cpkMax" DOUBLE PRECISION,
    "cpkAvg" DOUBLE PRECISION,
    "presionAvgPsi" DOUBLE PRECISION,
    "presionMinPsi" DOUBLE PRECISION,
    "presionMaxPsi" DOUBLE PRECISION,
    "inspeccionesConPresion" INTEGER NOT NULL DEFAULT 0,
    "healthScoreAtEnd" INTEGER,
    "alertLevelAtEnd" "TireAlertLevel",
    "totalInspecciones" INTEGER NOT NULL DEFAULT 0,
    "firstInspeccionId" TEXT,
    "lastInspeccionId" TEXT,
    "motivoFin" "MotivoFinVida",
    "notasRetiro" TEXT,
    "desechoCausales" TEXT,
    "desechoMilimetros" DOUBLE PRECISION,
    "desechoRemanente" DOUBLE PRECISION,
    "desechoImageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dataSource" TEXT NOT NULL DEFAULT 'live',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tire_vida_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tire_benchmarks" (
    "id" TEXT NOT NULL,
    "marca" TEXT NOT NULL,
    "diseno" TEXT NOT NULL,
    "dimension" TEXT NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "companyCount" INTEGER NOT NULL DEFAULT 1,
    "precioPromedio" DOUBLE PRECISION,
    "precioMin" DOUBLE PRECISION,
    "precioMax" DOUBLE PRECISION,
    "avgCpk" DOUBLE PRECISION,
    "medianCpk" DOUBLE PRECISION,
    "avgCpt" DOUBLE PRECISION,
    "avgKmPorVida" DOUBLE PRECISION,
    "avgMmDesgaste" DOUBLE PRECISION,
    "avgDesgastePor1000km" DOUBLE PRECISION,
    "cpkNueva" DOUBLE PRECISION,
    "cpkReencauche1" DOUBLE PRECISION,
    "cpkReencauche2" DOUBLE PRECISION,
    "sampleNueva" INTEGER NOT NULL DEFAULT 0,
    "sampleReencauche1" INTEGER NOT NULL DEFAULT 0,
    "sampleReencauche2" INTEGER NOT NULL DEFAULT 0,
    "retreadRoiRatio" DOUBLE PRECISION,
    "cpkAtOptimalPsi" DOUBLE PRECISION,
    "cpkAtLowPsi" DOUBLE PRECISION,
    "pressureSensitivity" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tire_benchmarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tire_recommendations" (
    "id" TEXT NOT NULL,
    "tireId" TEXT,
    "companyId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "prioridad" INTEGER NOT NULL DEFAULT 0,
    "titulo" TEXT NOT NULL,
    "cuerpo" TEXT NOT NULL,
    "accion" TEXT,
    "metaData" JSONB NOT NULL DEFAULT '{}',
    "modelVersion" TEXT,
    "confidence" DOUBLE PRECISION,
    "visto" BOOLEAN NOT NULL DEFAULT false,
    "descartado" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tire_recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_inspections_vehicleId_fecha_idx" ON "vehicle_inspections"("vehicleId", "fecha");

-- CreateIndex
CREATE INDEX "tire_vida_snapshots_tireId_idx" ON "tire_vida_snapshots"("tireId");

-- CreateIndex
CREATE INDEX "tire_vida_snapshots_tireId_vida_idx" ON "tire_vida_snapshots"("tireId", "vida");

-- CreateIndex
CREATE INDEX "tire_vida_snapshots_companyId_idx" ON "tire_vida_snapshots"("companyId");

-- CreateIndex
CREATE INDEX "tire_vida_snapshots_companyId_vida_idx" ON "tire_vida_snapshots"("companyId", "vida");

-- CreateIndex
CREATE INDEX "tire_vida_snapshots_companyId_marca_dimension_idx" ON "tire_vida_snapshots"("companyId", "marca", "dimension");

-- CreateIndex
CREATE INDEX "tire_vida_snapshots_companyId_eje_idx" ON "tire_vida_snapshots"("companyId", "eje");

-- CreateIndex
CREATE INDEX "tire_vida_snapshots_cpkFinal_idx" ON "tire_vida_snapshots"("cpkFinal");

-- CreateIndex
CREATE INDEX "tire_vida_snapshots_dimension_marca_vida_idx" ON "tire_vida_snapshots"("dimension", "marca", "vida");

-- CreateIndex
CREATE INDEX "tire_vida_snapshots_dataSource_idx" ON "tire_vida_snapshots"("dataSource");

-- CreateIndex
CREATE INDEX "tire_benchmarks_marca_dimension_idx" ON "tire_benchmarks"("marca", "dimension");

-- CreateIndex
CREATE INDEX "tire_benchmarks_dimension_idx" ON "tire_benchmarks"("dimension");

-- CreateIndex
CREATE INDEX "tire_benchmarks_retreadRoiRatio_idx" ON "tire_benchmarks"("retreadRoiRatio");

-- CreateIndex
CREATE UNIQUE INDEX "tire_benchmarks_marca_diseno_dimension_key" ON "tire_benchmarks"("marca", "diseno", "dimension");

-- CreateIndex
CREATE INDEX "tire_recommendations_companyId_visto_idx" ON "tire_recommendations"("companyId", "visto");

-- CreateIndex
CREATE INDEX "tire_recommendations_companyId_prioridad_idx" ON "tire_recommendations"("companyId", "prioridad");

-- CreateIndex
CREATE INDEX "tire_recommendations_tireId_idx" ON "tire_recommendations"("tireId");

-- CreateIndex
CREATE INDEX "tire_recommendations_tipo_idx" ON "tire_recommendations"("tipo");

-- CreateIndex
CREATE INDEX "tire_recommendations_expiresAt_idx" ON "tire_recommendations"("expiresAt");

-- CreateIndex
CREATE INDEX "Company_plan_idx" ON "Company"("plan");

-- CreateIndex
CREATE INDEX "Tire_companyId_vidaActual_idx" ON "Tire"("companyId", "vidaActual");

-- CreateIndex
CREATE INDEX "Tire_dimension_marca_idx" ON "Tire"("dimension", "marca");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_companyId_placa_key" ON "Vehicle"("companyId", "placa");

-- CreateIndex
CREATE INDEX "inspecciones_vidaAlMomento_idx" ON "inspecciones"("vidaAlMomento");

-- CreateIndex
CREATE INDEX "inspecciones_tireId_vidaAlMomento_idx" ON "inspecciones"("tireId", "vidaAlMomento");

-- CreateIndex
CREATE INDEX "inspecciones_source_idx" ON "inspecciones"("source");

-- CreateIndex
CREATE INDEX "inspecciones_presionPsi_idx" ON "inspecciones"("presionPsi");

-- CreateIndex
CREATE INDEX "inspecciones_inspeccionadoPorId_idx" ON "inspecciones"("inspeccionadoPorId");

-- CreateIndex
CREATE INDEX "tire_costos_concepto_idx" ON "tire_costos"("concepto");

-- AddForeignKey
ALTER TABLE "vehicle_inspections" ADD CONSTRAINT "vehicle_inspections_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inspecciones" ADD CONSTRAINT "inspecciones_inspeccionadoPorId_fkey" FOREIGN KEY ("inspeccionadoPorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tire_vida_snapshots" ADD CONSTRAINT "tire_vida_snapshots_tireId_fkey" FOREIGN KEY ("tireId") REFERENCES "Tire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tire_vida_snapshots" ADD CONSTRAINT "tire_vida_snapshots_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tire_recommendations" ADD CONSTRAINT "tire_recommendations_tireId_fkey" FOREIGN KEY ("tireId") REFERENCES "Tire"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tire_recommendations" ADD CONSTRAINT "tire_recommendations_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
