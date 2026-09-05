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

-- Tier 4: public photo reports
CREATE TABLE IF NOT EXISTS photo_uploads (
  id TEXT PRIMARY KEY,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  note TEXT,
  r2_key TEXT NOT NULL,
  linked_permit_id TEXT REFERENCES felling_permits(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_permits_status ON felling_permits(status);
CREATE INDEX IF NOT EXISTS idx_permits_review ON felling_permits(review_status);
CREATE INDEX IF NOT EXISTS idx_trees_source ON trees(source);

-- simple key/value table for tracking ingestion watermarks (e.g. last SRU run date)
CREATE TABLE IF NOT EXISTS ingestion_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
