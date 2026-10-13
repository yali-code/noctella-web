-- Etsy listing form parity (Phase 1): additive, nullable product columns. No backfill, no defaults,
-- no data rewrite; existing products keep NULL (= not provided). Mirrors db/migrate.ts ETSY_LISTING_FORM_COLUMNS.
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_taxonomy_id text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_shop_section_id text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_quantity integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_sku text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_who_made text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_is_supply boolean;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_when_made text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_vintage_year integer;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_shipping_profile_id text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_processing_profile_id text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_return_policy_id text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_renewal_option text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_featured boolean;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_ads_opt_in boolean;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_restock_requests boolean;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_gpsr_manufacturer_name text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_gpsr_manufacturer_address text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_gpsr_manufacturer_contact text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_gpsr_responsible_person_name text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_gpsr_responsible_person_address text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_gpsr_responsible_person_contact text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_gpsr_safety_information text;
ALTER TABLE products ADD COLUMN IF NOT EXISTS etsy_consumer_guarantee_info text;
