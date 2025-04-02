-- AlterTable
ALTER TABLE "Tire" ALTER COLUMN "placa" SET DEFAULT '';

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "tireCount" INTEGER NOT NULL DEFAULT 0;
