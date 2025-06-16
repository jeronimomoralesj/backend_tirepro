-- CreateTable
CREATE TABLE "extras" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "cost" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,

    CONSTRAINT "extras_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "extras" ADD CONSTRAINT "extras_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
