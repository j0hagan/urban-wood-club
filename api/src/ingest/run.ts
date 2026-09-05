import type { Env } from '../index'
import { fetchDelftFellingAnnouncements } from './bekendmakingen'

// Orchestrates the daily ingestion pipeline. Starts with Tier 2 only;
// Tier 1 sync and Tier 3 PDF extraction get added as their own steps
// once this loop is proven out end to end.
export async function runDailyIngestion(env: Env) {
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
}
