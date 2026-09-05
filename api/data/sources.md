# Data sources — Delft trial

| Tier | Source | Access | Status |
|---|---|---|---|
| 1 | Bomen in beheer door gemeente Delft (data.delft.nl, dataset id d83a50486b384bfe8038c2d762f5e628_0) | ArcGIS Hub v3 downloads API - confirmed live: `https://hub.arcgis.com/api/v3/datasets/d83a50486b384bfe8038c2d762f5e628_0/downloads/data?format=geojson&spatialRefId=4326&where=1%3D1` | wired and working (`ingest/delft-trees.ts`, `syncDelftTrees`) - not yet run against a real D1 database |
| 1b | OpenStreetMap tree tags (cross-check; same data openbomenkaart.org renders) | Overpass API | wired as skeleton |
| 2 | Officiele Bekendmakingen (national felling-permit announcements) | SRU-ish API, zoek.officielebekendmakingen.nl/sru/Search, CC0. Confirmed live (Sept 2026, via a real browser - this host blocks/403s every sandboxed environment tried): needs `x-connection=oep`, `version=1.2`, plain CQL fields (`creator`, `title`, `date`), `%wildcard%` match, no parens/OR-grouping (500s) - query each keyword separately and merge. Address/tree-count/species/status are best-effort regex extraction from the free-text title; addresses are geocoded via PDOK's free Locatieserver (`api.pdok.nl/bzk/locatieserver/search/v3_1/free`, also confirmed live, no key needed). | wired and working (`ingest/bekendmakingen.ts`, `syncFellingPermits`) - not yet run against a real D1 database |
| 3 | Tree removals mentioned inside larger construction/infra permits | Same bekendmakingen feed, broader category filter + PDF text extraction + LLM classification | not started |
| 4 | Public tree reports ("Witness a Tree" wizard, matching urbanwood.club) | own /api/reports endpoint (tree_reports table) | working (in worker), not yet run end-to-end against a real D1 database |
| — | viewer.bomenwacht.nl (access-code gated) | unclear — looks like a private client (possibly TU Delft) inspection dataset, not general open data | pending: confirm access/rights before using |
| — | bomenkapmeldpunt.nl | crowdsourced commentary/objections | reference only, not a data source to scrape |
