-- AlterTable
ALTER TABLE "Company" ADD COLUMN     "agentSettings" JSONB NOT NULL DEFAULT '{"agentEnabled":false,"alertMode":"display_only","purchaseMode":"manual"}',
ADD COLUMN     "emailAtencion" TEXT;
