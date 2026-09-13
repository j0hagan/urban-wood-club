-- Adds tree size/condition columns to felling_permits, for the GRIB
-- tree-by-tree inventory (see migrate_2026_09_13_inventory.sql for the
-- first round of Tier 5 columns). Run once against the remote DB:
--
--   npx wrangler d1 execute urban-wood-club --remote --file=src/db/migrate_2026_09_13_inventory_details.sql
--
-- (run from the api/ folder, same as the first migration).

ALTER TABLE felling_permits ADD COLUMN planted_year INTEGER;
ALTER TABLE felling_permits ADD COLUMN age_years INTEGER;
ALTER TABLE felling_permits ADD COLUMN trunk_diameter_class TEXT;
ALTER TABLE felling_permits ADD COLUMN height_class TEXT;
ALTER TABLE felling_permits ADD COLUMN tree_size_class TEXT;
ALTER TABLE felling_permits ADD COLUMN condition_nl TEXT;
ALTER TABLE felling_permits ADD COLUMN condition_en TEXT;
