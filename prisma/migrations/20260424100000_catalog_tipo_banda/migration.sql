-- New optional field on the master catalog: tipoBanda — the retread band
-- type/model for this SKU. Distribuidor admins will be able to edit this
-- one directly from the catalog detail modal (paired with reencauchable),
-- while vidasReencauche / kmEstimados* / precioCop remain locked to the
-- TirePro admin path since we derive those from fleet averages.

ALTER TABLE "tire_master_catalog"
  ADD COLUMN "tipoBanda" TEXT;
