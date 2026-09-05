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

// Tier 2: pull new Delft felling-permit announcements from the national
// bekendmakingen feed since the last run, insert as 'pending' review.
export async function syncFellingPermits(env: Env): Promise<number> {
  const lastRun = await env.DB.prepare(
    `SELECT value FROM ingestion_state WHERE key = 'bekendmakingen_last_run'`
  )
    .first<{ value: string }>()
    .catch(() => null)

  const since = lastRun?.value ?? new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  const announcements = await fetchDelftFellingAnnouncements(since)

  for (const a of announcements) {
    await env.DB.prepare(
      `INSERT INTO felling_permits
         (id, publication_id, title, status, tier, source_url, published_at, review_status, created_at)
       VALUES (?, ?, ?, 'aangevraagd', 'tier2', ?, ?, 'pending', ?)
       ON CONFLICT(publication_id) DO NOTHING`
    )
      .bind(
        crypto.randomUUID(),
        a.publicationId,
        a.title,
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
