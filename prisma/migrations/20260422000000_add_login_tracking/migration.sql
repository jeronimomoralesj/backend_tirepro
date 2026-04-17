-- Add login-tracking columns to User
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "lastLoginAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "loginCount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "knownIps"    TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[];

-- One row per successful login; source of truth for analytics.
CREATE TABLE IF NOT EXISTS "user_login_logs" (
  "id"         TEXT         NOT NULL,
  "userId"     TEXT         NOT NULL,
  "fecha"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ip"         TEXT,
  "userAgent"  TEXT,

  CONSTRAINT "user_login_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_login_logs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "user_login_logs_userId_fecha_idx"
  ON "user_login_logs"("userId", "fecha");
CREATE INDEX IF NOT EXISTS "user_login_logs_fecha_idx"
  ON "user_login_logs"("fecha");
