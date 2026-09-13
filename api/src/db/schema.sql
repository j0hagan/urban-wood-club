-- Tier 1 + 1b: trees that already exist (municipal survey + OSM cross-check)
CREATE TABLE IF NOT EXISTS trees (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  species_nl TEXT,
  species_lat TEXT,
  is_monumental INTEGER DEFAULT 0,       -- not populated by any known source field yet - stays 0
  planted_year INTEGER,                  -- AANLEGJAAR
  height_class TEXT,                     -- HOOGTE - a band like "9-12 m.", not a raw number
  diameter_cm REAL,                      -- DIAMETER
  neighborhood TEXT,                     -- BUURT
  site_type TEXT,                        -- STANDPLAATS (e.g. "Boomspiegel" / tree pit)
  management_group TEXT,                 -- BEHEERGROEP
  notes TEXT,                            -- EXTRA_INFORMATIE_2 + _3, when present
  source TEXT NOT NULL,        -- 'delft-gemeente' | 'osm'
  source_ref TEXT,              -- original id/object id at the source
  updated_at TEXT NOT NULL
);

-- Tier 2 + 3: officially announced felling (direct permits, or extracted
-- from a larger construction/infra permit's attachments)
CREATE TABLE IF NOT EXISTS felling_permits (
  id TEXT PRIMARY KEY,
  publication_id TEXT UNIQUE NOT NULL,  -- bekendmakingen id, e.g. gmb-2026-123456
  title TEXT NOT NULL,
  title_en TEXT,
  address TEXT,
  lat REAL,
  lon REAL,
  tree_count INTEGER,
  species TEXT,
  reason TEXT,
  status TEXT NOT NULL,          -- 'aangevraagd' | 'verleend' | 'definitief' | 'geweigerd'
  tier TEXT NOT NULL,            -- 'tier2' | 'tier3' | 'manual'
  source_url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'approved', -- 'approved' | 'rejected' -- auto-approved on sync: Tier 2/3 comes from an official government feed, not the public, so there's nothing to moderate before it goes live. 'rejected' stays available to hide an individual bad record by hand if one ever shows up.
  created_at TEXT NOT NULL,

  -- Tier 5 additions (the GRIB/Bomenwacht tree-by-tree felling inventory
  -- import, api/src/index.ts's POST /api/admin/inventory/import) - also
  -- used by a plain tier='manual' one-off record added via /admin, which
  -- simply leaves all of these null.
  requires_permit INTEGER,       -- 1 = "Kapvergunningsplichtig", 0 = "Geen kapvergunningsplicht" (GRIB's own permit-required flag, independent of `status` above)
  already_felled INTEGER,        -- 1 if GRIB's own survey found the tree already gone ("Boom niet aanwezig" or "Alleen stobbe aanwezig" - not present, or stump only) at the time it was recorded
  species_nl TEXT,
  species_lat TEXT,
  species_en TEXT,
  neighborhood TEXT,             -- Buurt (falling back to Wijk)
  reason_en TEXT,                -- best-effort translation of `reason` above, done once per distinct phrase via POST /api/admin/translate-batch at import time (not per row, per Workers AI/MyMemory - see that endpoint's own comment)
  photo_r2_key TEXT,             -- set via POST /api/admin/inventory/:id/photo - re-hosted in R2 rather than ever linking the source GRIB viewer's own (access-code-gated) photo URL directly
  entry_source TEXT,             -- 'admin_manual' (the /admin "+ Add by hand" form) | 'grib_bulk' (this bulk import) - lets a future re-import's "replace existing" step target only its own previous rows

  -- Tier 5 size/condition detail (GRIB's own field survey) - added after the
  -- first bulk import, see migrate_2026_09_13_inventory_details.sql. Left
  -- null for anything not from the GRIB bulk import.
  planted_year INTEGER,          -- Plantjaar
  age_years INTEGER,             -- Leeftijd (jr, per 2026) - GRIB's own snapshot age, not recomputed from planted_year
  trunk_diameter_class TEXT,     -- Stamdiameterklasse, e.g. "50-100 cm"
  height_class TEXT,             -- Hoogteklasse, e.g. "12-18 m"
  tree_size_class TEXT,          -- Boomgrootte, translated (e.g. "1st size class (large)")
  condition_nl TEXT,             -- Conditie, original Dutch (e.g. "Onvoldoende")
  condition_en TEXT              -- Conditie, translated (e.g. "Insufficient")
);

-- Tier 4: public tree reports ("Witness a Tree") - mirrors the
-- Capture / Location / Details wizard on urbanwood.club
CREATE TABLE IF NOT EXISTS tree_reports (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  photo_r2_key TEXT NOT NULL,

  status TEXT NOT NULL,              -- 'marked_for_felling' | 'felled' | 'new_tree_planted'
  quantity TEXT NOT NULL,            -- 'single' | 'few' | 'several' | 'street_row'

  species_known INTEGER DEFAULT 0,
  species_name TEXT,
  request_community_id INTEGER DEFAULT 0,

  trunk_measure_type TEXT,           -- 'diameter' | 'circumference'
  trunk_measure_cm REAL,

  -- felling detail (status = marked_for_felling)
  felling_reason TEXT,               -- 'diseased' | 'storm_damaged' | 'infrastructure' | 'building_development' | 'light_improvement' | 'other'
  felling_reason_other TEXT,
  felling_date TEXT,
  felling_period TEXT,
  looking_for_arborist INTEGER DEFAULT 0,
  arborist_contact TEXT,

  -- stump detail (status = felled)
  felled_date TEXT,
  felled_period TEXT,

  notes TEXT,
  linked_permit_id TEXT REFERENCES felling_permits(id),

  review_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_permits_status ON felling_permits(status);
CREATE INDEX IF NOT EXISTS idx_permits_review ON felling_permits(review_status);
CREATE INDEX IF NOT EXISTS idx_trees_source ON trees(source);
CREATE INDEX IF NOT EXISTS idx_reports_review ON tree_reports(review_status);

-- Extra photos for a tree_reports row beyond the primary photo_r2_key -
-- see migrate_2026_09_13_report_extra_photos.sql for the remote-DB
-- migration and its rationale.
CREATE TABLE IF NOT EXISTS tree_report_extra_photos (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES tree_reports(id),
  r2_key TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_report_extra_photos_report ON tree_report_extra_photos(report_id);

-- simple key/value table for tracking ingestion watermarks (e.g. last SRU run date)
CREATE TABLE IF NOT EXISTS ingestion_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
