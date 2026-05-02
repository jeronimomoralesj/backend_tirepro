-- CreateTable
CREATE TABLE "order_surveys" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "userId" TEXT,
    "buyerEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_surveys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_surveys_orderId_key" ON "order_surveys"("orderId");

-- CreateIndex
CREATE INDEX "order_surveys_userId_idx" ON "order_surveys"("userId");

-- AddForeignKey
ALTER TABLE "order_surveys"
  ADD CONSTRAINT "order_surveys_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "marketplace_orders"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_surveys"
  ADD CONSTRAINT "order_surveys_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
