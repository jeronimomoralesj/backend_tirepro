-- AlterTable
ALTER TABLE "Tire" ADD COLUMN     "degradationRateMmPerDay" DOUBLE PRECISION,
ADD COLUMN     "projectedAlertLevel" "TireAlertLevel",
ADD COLUMN     "projectedDaysToLimit" INTEGER,
ADD COLUMN     "projectedHealthScore" INTEGER,
ADD COLUMN     "projectedProfundidad" DOUBLE PRECISION,
ADD COLUMN     "projectionUpdatedAt" TIMESTAMP(3);
