-- Loose ref to a DistributorListing the company pins next to the
-- promo banner on their public storefront. No foreign-key constraint
-- on purpose — listings are soft-deleted (isActive=false) and
-- occasionally hard-deleted in cleanup jobs; we'd rather the field
-- silently misses than block the deletion.
ALTER TABLE "Company" ADD COLUMN IF NOT EXISTS "pinnedListingId" TEXT;
