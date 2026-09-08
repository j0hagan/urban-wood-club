import type { Env } from '../index'
import { fetchDelftFellingAnnouncements } from './bekendmakingen'
import { fetchDelftManagedTrees } from './delft-trees'

// Tier 1: sync Delft's managed-tree dataset into the trees table.
// Idempotent (upsert on id), safe to re-run - the dataset doesn't change
// often, but re-running is cheap and self-correcting either way.
export async function syncDelftTrees(env: Env): Promise<number> {
  const trees = await fetchDelftManagedTrees()
  const now = new Date().toISOString()
  const BATCH_SIZE = 100

  for (let i = 0; i < trees.length; i += BATCH_SIZE) {
    const chunk = trees.slice(i, i + BATCH_SIZE)
    const stmts = chunk.map((t) =>
      env.DB.prepare(
        `INSERT INTO trees (
           id, lat, lon, species_nl, species_lat, is_monumental,
           planted_year, height_class, diameter_cm, neighborhood, site_type, management_group, notes,
           source, source_ref, updated_at
         )
         VALUES (?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, 'delft-gemeente', ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           lat = excluded.lat,
           lon = excluded.lon,
           species_nl = excluded.species_nl,
           planted_year = excluded.planted_year,
           height_class = excluded.height_class,
           diameter_cm = excluded.diameter_cm,
           neighborhood = excluded.neighborhood,
           site_type = excluded.site_type,
           management_group = excluded.management_group,
           notes = excluded.notes,
           updated_at = excluded.updated_at`
      ).bind(
        t.id,
        t.lat,
        t.lon,
        t.speciesNl,
        t.plantedYear,
        t.heightClass,
        t.diameterCm,
        t.neighborhood,
        t.siteType,
        t.managementGroup,
        t.notes,
        t.sourceRef,
        now
      )
    )
    await env.DB.batch(stmts)
  }
  return trees.length
}

// Tier 2: pull new/updated Delft felling-permit announcements from the
// national bekendmakingen feed since the last run, upsert on
// publication_id. New rows are inserted as review_status = 'approved'
// straight away and go live on the map immediately - this is official
// government permit data, not a public submission, so there's nothing to
// moderate before publishing it. review_status is left untouched on an
// existing row (DO NOTHING would apply to the whole row) so a manual
// 'rejected' override on a bad record is never clobbered by a later
// re-sync - but the rest of the record (status, address, lat/lon, tree
// count, species hint) is refreshed, since e.g. a permit's status
// legitimately moves from "aangevraagd" to "verleend" as it works through
// the process.
export async function syncFellingPermits(env: Env): Promise<number> {
  const lastRun = await env.DB.prepare(
    `SELECT value FROM ingestion_state WHERE key = 'bekendmakingen_last_run'`
  )
    .first<{ value: string }>()
    .catch(() => null)

  // A fresh install has no prior run to pick up from - default to a wide
  // backfill window (400 days) rather than 7, since felling permits are
  // published every few weeks per municipality, not daily; a short window
  // on day one finds nothing and looks like a bug. Once ingestion_state has
  // a real last-run date, subsequent runs go back to being incremental.
  const since = lastRun?.value ?? new Date(Date.now() - 400 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const announcements = await fetchDelftFellingAnnouncements(since, env.AI)

  for (const a of announcements) {
    await env.DB.prepare(
      `INSERT INTO felling_permits
         (id, publication_id, title, title_en, address, lat, lon, tree_count, species, reason, status, tier, source_url, published_at, review_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'tier2', ?, ?, 'approved', ?)
       ON CONFLICT(publication_id) DO UPDATE SET
         title = excluded.title,
         title_en = coalesce(excluded.title_en, felling_permits.title_en),
         address = coalesce(excluded.address, felling_permits.address),
         lat = coalesce(excluded.lat, felling_permits.lat),
         lon = coalesce(excluded.lon, felling_permits.lon),
         tree_count = coalesce(excluded.tree_count, felling_permits.tree_count),
         species = coalesce(excluded.species, felling_permits.species),
         reason = coalesce(excluded.reason, felling_permits.reason),
         status = excluded.status`
    )
      .bind(
        crypto.randomUUID(),
        a.publicationId,
        a.title,
        a.titleEn,
        a.address,
        a.lat,
        a.lon,
        a.treeCount,
        a.speciesHint,
        a.reasonHint,
        a.status,
        a.sourceUrl,
        a.publishedAt,
        new Date().toISOString()
      )
      .run()
  }

  await env.DB.prepare(
    `INSERT INTO ingestion_state (key, value) VALUES ('bekendmakingen_last_run', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(new Date().toISOString().slice(0, 10))
    .run()

  return announcements.length
}

// Orchestrates the daily ingestion pipeline (Cron Trigger entrypoint).
// Tier 3 (PDF extraction from broader permits) isn't built yet - see
// api/data/sources.md.
export async function runDailyIngestion(env: Env) {
  const results = await Promise.allSettled([syncDelftTrees(env), syncFellingPermits(env)])
  for (const r of results) {
    if (r.status === 'rejected') console.error('ingestion step failed:', r.reason)
  }
}
