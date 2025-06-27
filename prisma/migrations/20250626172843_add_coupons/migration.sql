-- CreateEnum
CREATE TYPE "CouponCategory" AS ENUM ('llantas', 'reencauches', 'baterias', 'gasolina', 'aceites');

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "titleKey" TEXT NOT NULL,
    "descriptionKey" TEXT NOT NULL,
    "discount" TEXT NOT NULL,
    "category" "CouponCategory" NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "code" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);
