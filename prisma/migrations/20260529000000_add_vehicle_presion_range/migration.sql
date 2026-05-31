-- Per-vehicle inflation pressure range (PSI). NULL => report default 100–120.
ALTER TABLE "Vehicle" ADD COLUMN "presionMin" DOUBLE PRECISION;
ALTER TABLE "Vehicle" ADD COLUMN "presionMax" DOUBLE PRECISION;
