-- Bulk upload snapshots: 1-week rewindable record of each bulk-tire
-- upload. Lets users revert or edit-and-reapply before the data is
-- considered committed. Invalidated the moment any tire in the upload
-- receives an inspection or vida change.
CREATE TABLE IF NOT EXISTS "bulk_upload_snapshots" (
  "id"                TEXT PRIMARY KEY,
  "companyId"         TEXT NOT NULL,
  "userId"            TEXT,
  "uploadedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"         TIMESTAMP(3) NOT NULL,
  "fileName"          TEXT,
  "tireCount"         INTEGER NOT NULL DEFAULT 0,
  "tireIds"           TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rawRows"           JSONB NOT NULL,
  "invalidated"       BOOLEAN NOT NULL DEFAULT FALSE,
  "invalidatedAt"     TIMESTAMP(3),
  "invalidatedReason" TEXT,
  CONSTRAINT "bulk_upload_snapshots_companyId_fkey"
    FOREIGN KEY ("companyId")
    REFERENCES "Company" ("id")
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "bulk_upload_snapshots_companyId_uploadedAt_idx"
  ON "bulk_upload_snapshots" ("companyId", "uploadedAt");
CREATE INDEX IF NOT EXISTS "bulk_upload_snapshots_expiresAt_idx"
  ON "bulk_upload_snapshots" ("expiresAt");
