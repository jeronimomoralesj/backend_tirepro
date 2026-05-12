-- Per-user client scoping for distribuidor accounts. A regular user gets
-- assigned one or more client companies; the inspectable-vehicle set is
-- resolved at read time as the union of every assigned client's vehicles.
-- Pro/plus accounts continue to use UserVehicleAccess for per-vehicle
-- scoping. The two relations coexist on a single user — getAccessibleVehicles
-- merges and dedupes them.

CREATE TABLE "user_client_access" (
    "userId" TEXT NOT NULL,
    "clientCompanyId" TEXT NOT NULL,

    CONSTRAINT "user_client_access_pkey" PRIMARY KEY ("userId", "clientCompanyId")
);

CREATE INDEX "user_client_access_userId_idx" ON "user_client_access"("userId");
CREATE INDEX "user_client_access_clientCompanyId_idx" ON "user_client_access"("clientCompanyId");

ALTER TABLE "user_client_access"
  ADD CONSTRAINT "user_client_access_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_client_access"
  ADD CONSTRAINT "user_client_access_clientCompanyId_fkey"
  FOREIGN KEY ("clientCompanyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
