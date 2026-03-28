-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "actionLabel" TEXT,
ADD COLUMN     "actionPayload" JSONB,
ADD COLUMN     "actionType" TEXT,
ADD COLUMN     "driverConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "driverConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "executed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "executedAt" TIMESTAMP(3),
ADD COLUMN     "executedBy" TEXT,
ADD COLUMN     "groupKey" TEXT,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sentToDriver" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sentToDriverAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Notification_companyId_executed_idx" ON "Notification"("companyId", "executed");

-- CreateIndex
CREATE INDEX "Notification_companyId_priority_idx" ON "Notification"("companyId", "priority");

-- CreateIndex
CREATE INDEX "Notification_groupKey_idx" ON "Notification"("groupKey");
