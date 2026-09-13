-- Adds support for more than one photo per community report (Witness a
-- Tree, tree_reports). tree_reports.photo_r2_key stays exactly as-is and
-- keeps being "photo 0"/the primary thumbnail everywhere that already uses
-- it - this table only holds photos beyond that first one, so no existing
-- single-photo code path needs to change. Run once against the remote DB:
--
--   npx wrangler d1 execute urban-wood-club --remote --file=src/db/migrate_2026_09_13_report_extra_photos.sql
--
-- (run from the api/ folder, same as the other migrations).

CREATE TABLE IF NOT EXISTS tree_report_extra_photos (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES tree_reports(id),
  r2_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_extra_photos_report ON tree_report_extra_photos(report_id);
