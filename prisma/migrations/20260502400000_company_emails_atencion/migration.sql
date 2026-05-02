-- AlterTable
-- Adds the additional-recipients column for distributor order
-- notifications. emailAtencion (single) stays the public/primary
-- contact; emailsAtencion (array) holds extra recipients. Default
-- empty array so existing rows pass NOT NULL constraints without
-- a backfill step.
ALTER TABLE "Company"
  ADD COLUMN "emailsAtencion" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
