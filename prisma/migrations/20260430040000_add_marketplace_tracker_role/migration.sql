-- Add marketplace_tracker to the UserRole enum.
-- Distribuidor-only role: catálogo access at the sales-rep level + a
-- new /dashboard/marketplace view (orders/tracking). Lower trust than
-- catalogo_admin — cannot manage the catalog itself.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'marketplace_tracker';
