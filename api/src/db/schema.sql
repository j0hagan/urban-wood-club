-- Tier 1 + 1b: trees that already exist (municipal survey + OSM cross-check)
CREATE TABLE IF NOT EXISTS trees (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  species_nl TEXT,
  species_lat TEXT,
  is_monumental INTEGER DEFAULT 0,
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
  address TEXT,
  lat REAL,
  lon REAL,
  tree_count INTEGER,
  species TEXT,
  reason TEXT,
  status TEXT NOT NULL,          -- 'aangevraagd' | 'verleend' | 'definitief' | 'geweigerd'
  tier TEXT NOT NULL,            -- 'tier2' | 'tier3'
  source_url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  created_at TEXT NOT NULL
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

-- simple key/value table for tracking ingestion watermarks (e.g. last SRU run date)
CREATE TABLE IF NOT EXISTS ingestion_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
