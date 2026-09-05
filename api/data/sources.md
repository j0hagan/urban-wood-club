# Data sources — Delft trial

| Tier | Source | Access | Status |
|---|---|---|---|
| 1 | Bomen in beheer door gemeente Delft (data.delft.nl, dataset id d83a50486b384bfe8038c2d762f5e628_0) | ArcGIS FeatureServer (exact query URL still needs grabbing from the dataset's "API" link) | wired as skeleton (`ingest/delft-trees.ts`) |
| 1b | OpenStreetMap tree tags (cross-check; same data openbomenkaart.org renders) | Overpass API | wired as skeleton |
| 2 | Officiele Bekendmakingen (national felling-permit announcements) | SRU 2.0 API, zoek.officielebekendmakingen.nl/sru/Search, CC0 | wired as skeleton, field names unverified against a live response |
| 3 | Tree removals mentioned inside larger construction/infra permits | Same bekendmakingen feed, broader category filter + PDF text extraction + LLM classification | not started |
| 4 | Public photo uploads | own /api/uploads endpoint | working (in worker) |
| — | viewer.bomenwacht.nl (access-code gated) | unclear — looks like a private client (possibly TU Delft) inspection dataset, not general open data | pending: confirm access/rights before using |
| — | bomenkapmeldpunt.nl | crowdsourced commentary/objections | reference only, not a data source to scrape |
