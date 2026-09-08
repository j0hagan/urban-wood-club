import { Hono } from 'hono'
import { runDailyIngestion, syncDelftTrees, syncFellingPermits } from './ingest/run'
import { sweepPublicaties } from './ingest/publicaties'

export interface Env {
  DB: D1Database
  PHOTOS: R2Bucket
  ADMIN_TOKEN?: string
  SEND_EMAIL?: SendEmail
}

const app = new Hono<{ Bindings: Env }>()

// Temporary diagnostic net: surface the real error instead of a bare
// "Internal Server Error" while we track down an intermittent 500 on the
// admin review endpoints. Logs the full error server-side too (visible in
// the Workers Observability tab) so we're not guessing from the client.
app.onError((err, c) => {
  console.error('Unhandled error:', err)
  return c.json({ error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }, 500)
})

app.get('/api/health', (c) => c.json({ ok: true }))

// Tier 1 + 1b
app.get('/api/trees', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, lat, lon, species_nl, species_lat, source, is_monumental,
            planted_year, height_class, diameter_cm, neighborhood, site_type, management_group, notes
     FROM trees LIMIT 40000`
  ).all()
  return c.json(results)
})

// Tier 2 + 3 (auto-approved on sync - see run.ts; this only ever excludes a record someone explicitly rejected by hand)
app.get('/api/permits', async (c) => {
  const status = c.req.query('status')
  const stmt = status
    ? c.env.DB.prepare(
        `SELECT * FROM felling_permits WHERE review_status = 'approved' AND status = ? ORDER BY published_at DESC LIMIT 500`
      ).bind(status)
    : c.env.DB.prepare(
        `SELECT * FROM felling_permits WHERE review_status = 'approved' ORDER BY published_at DESC LIMIT 500`
      )
  const { results } = await stmt.all()
  return c.json(results)
})

// Tier 4: "Witness a Tree" community reports
const REPORT_COLUMNS = `
  id, lat, lon, status, quantity, species_known, species_name,
  request_community_id, trunk_measure_type, trunk_measure_cm,
  felling_reason, felling_reason_other, felling_date, felling_period,
  looking_for_arborist, felled_date, felled_period, notes, created_at
`
// (arborist_contact is deliberately excluded from the public read - it's
// only meant for whoever picks up the "looking for an arborist" flag)

app.get('/api/reports', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${REPORT_COLUMNS} FROM tree_reports WHERE review_status = 'approved' ORDER BY created_at DESC LIMIT 500`
  ).all()
  return c.json((results as Record<string, unknown>[]).map((r) => ({ ...r, photo_url: `/api/reports/${r.id}/photo` })))
})

app.get('/api/reports/:id/photo', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT photo_r2_key FROM tree_reports WHERE id = ?')
    .bind(id)
    .first<{ photo_r2_key: string }>()
  if (!row) return c.notFound()
  const obj = await c.env.PHOTOS.get(row.photo_r2_key)
  if (!obj) return c.notFound()
  return new Response(obj.body, {
    headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream' },
  })
})

app.post('/api/reports', async (c) => {
  const form = await c.req.formData()

  const photo = form.get('photo')
  const lat = Number(form.get('lat'))
  const lon = Number(form.get('lon'))
  if (!(photo instanceof File)) return c.json({ error: 'missing photo' }, 400)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return c.json({ error: 'missing lat/lon' }, 400)

  const str = (key: string) => {
    const v = form.get(key)
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  const bool = (key: string) => form.get(key) === '1' || form.get(key) === 'true'
  const num = (key: string) => {
    const v = form.get(key)
    const n = v == null ? NaN : Number(v)
    return Number.isFinite(n) ? n : null
  }

  const status = str('status')
  const quantity = str('quantity')
  if (!status || !quantity) return c.json({ error: 'missing status/quantity' }, 400)

  const key = `reports/${crypto.randomUUID()}-${photo.name}`
  await c.env.PHOTOS.put(key, await photo.arrayBuffer(), {
    httpMetadata: { contentType: photo.type },
  })

  await c.env.DB.prepare(
    `INSERT INTO tree_reports (
       id, lat, lon, photo_r2_key, status, quantity,
       species_known, species_name, request_community_id,
       trunk_measure_type, trunk_measure_cm,
       felling_reason, felling_reason_other, felling_date, felling_period,
       looking_for_arborist, arborist_contact,
       felled_date, felled_period, notes,
       review_status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  )
    .bind(
      crypto.randomUUID(),
      lat,
      lon,
      key,
      status,
      quantity,
      bool('species_known') ? 1 : 0,
      str('species_name'),
      bool('request_community_id') ? 1 : 0,
      str('trunk_measure_type'),
      num('trunk_measure_cm'),
      str('felling_reason'),
      str('felling_reason_other'),
      str('felling_date'),
      str('felling_period'),
      bool('looking_for_arborist') ? 1 : 0,
      str('arborist_contact'),
      str('felled_date'),
      str('felled_period'),
      str('notes'),
      new Date().toISOString()
    )
    .run()

  // Best-effort email notification via Cloudflare Email Routing - never lets
  // a failed/unconfigured send (e.g. before the one-time dashboard setup:
  // Email Routing enabled + destination address verified) break the actual
  // report submission.
  if (c.env.SEND_EMAIL) {
    try {
      const { EmailMessage } = await import('cloudflare:email')
      const lines = [
        `A new tree report just came in on Urban Wood Club.`,
        ``,
        `Status: ${status}`,
        `Quantity: ${quantity}`,
        str('species_known') && str('species_name') ? `Species: ${str('species_name')}` : null,
        `Location: ${lat}, ${lon}`,
        `Map: https://urbanwood.club/?lat=${lat}&lon=${lon}`,
        ``,
        `Review it: https://urbanwood.club/admin`,
      ].filter((l) => l !== null)
      const raw =
        `From: Urban Wood Club <info@urbanwood.club>\r\n` +
        `To: j.ohagan.tud@gmail.com\r\n` +
        `Subject: New tree report on Urban Wood Club\r\n` +
        `Content-Type: text/plain; charset=utf-8\r\n` +
        `\r\n` +
        lines.join('\r\n')
      const message = new EmailMessage('info@urbanwood.club', 'j.ohagan.tud@gmail.com', raw)
      await c.env.SEND_EMAIL.send(message)
    } catch {
      // Notification is a nice-to-have, not a submission requirement.
    }
  }

  return c.json({ ok: true })
})

// --- Minimal moderation endpoints ---
// Nothing (a permit extraction or a public report) goes live without a pass
// through here first. Auth is a single shared secret for now
// (`wrangler secret put ADMIN_TOKEN`) - fine for one person moderating a
// single-city trial, not fine beyond that.
function requireAdmin(c: { req: { header: (k: string) => string | undefined }; env: Env; json: Function }) {
  const auth = c.req.header('authorization')
  if (!c.env.ADMIN_TOKEN || auth !== `Bearer ${c.env.ADMIN_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return null
}

app.get('/api/admin/reports/pending', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tree_reports WHERE review_status = 'pending' ORDER BY created_at DESC LIMIT 200`
  ).all()
  return c.json((results as Record<string, unknown>[]).map((r) => ({ ...r, photo_url: `/api/reports/${r.id}/photo` })))
})

// Already-live reports - so the admin page can list what's currently on
// the map for takedown, separate from the pending queue above.
app.get('/api/admin/reports/approved', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tree_reports WHERE review_status = 'approved' ORDER BY created_at DESC LIMIT 200`
  ).all()
  return c.json((results as Record<string, unknown>[]).map((r) => ({ ...r, photo_url: `/api/reports/${r.id}/photo` })))
})

app.post('/api/admin/reports/:id/review', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { status } = await c.req.json<{ status: 'approved' | 'rejected' }>()
  if (status !== 'approved' && status !== 'rejected') return c.json({ error: 'invalid status' }, 400)
  await c.env.DB.prepare('UPDATE tree_reports SET review_status = ? WHERE id = ?').bind(status, c.req.param('id')).run()
  return c.json({ ok: true })
})

// Editing a report's own content (species, trunk size, notes, etc.) -
// distinct from the review_status changes above. Whitelisted column list
// so this can never be used to touch id/photo_r2_key/created_at/review_status
// by sending an unexpected key in the body.
const EDITABLE_REPORT_FIELDS = [
  'lat', 'lon', 'status', 'quantity', 'species_known', 'species_name',
  'request_community_id', 'trunk_measure_type', 'trunk_measure_cm',
  'felling_reason', 'felling_reason_other', 'felling_date', 'felling_period',
  'looking_for_arborist', 'arborist_contact', 'felled_date', 'felled_period', 'notes',
] as const

app.patch('/api/admin/reports/:id', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const body = await c.req.json<Record<string, unknown>>()
  const keys = Object.keys(body).filter((k) => (EDITABLE_REPORT_FIELDS as readonly string[]).includes(k))
  if (keys.length === 0) return c.json({ error: 'no editable fields in body' }, 400)
  const setClause = keys.map((k) => `${k} = ?`).join(', ')
  await c.env.DB.prepare(`UPDATE tree_reports SET ${setClause} WHERE id = ?`)
    .bind(...keys.map((k) => body[k]), c.req.param('id'))
    .run()
  return c.json({ ok: true })
})

// Permanent removal - for a community report that's already live (approved)
// and needs to come down, not just the pending-queue approve/reject above.
// Cleans up its R2 photo too, so a deleted report doesn't leave an orphaned
// object behind.
app.delete('/api/admin/reports/:id', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT photo_r2_key FROM tree_reports WHERE id = ?')
    .bind(id)
    .first<{ photo_r2_key: string | null }>()
  await c.env.DB.prepare('DELETE FROM tree_reports WHERE id = ?').bind(id).run()
  if (row?.photo_r2_key) {
    await c.env.PHOTOS.delete(row.photo_r2_key).catch(() => {})
  }
  return c.json({ ok: true })
})

app.get('/api/admin/permits/pending', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM felling_permits WHERE review_status = 'pending' ORDER BY published_at DESC LIMIT 200`
  ).all()
  return c.json(results)
})

// Already-live permits - mirrors /api/admin/reports/approved above, so the
// admin page can list and (for a manual mistake or a since-retracted permit)
// delete something that's already on the public map, not just review the
// pending queue.
app.get('/api/admin/permits/approved', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM felling_permits WHERE review_status = 'approved' ORDER BY published_at DESC LIMIT 200`
  ).all()
  return c.json(results)
})

app.post('/api/admin/permits/:id/review', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { status } = await c.req.json<{ status: 'approved' | 'rejected' }>()
  if (status !== 'approved' && status !== 'rejected') return c.json({ error: 'invalid status' }, 400)
  await c.env.DB.prepare('UPDATE felling_permits SET review_status = ? WHERE id = ?')
    .bind(status, c.req.param('id'))
    .run()
  return c.json({ ok: true })
})

// Editing a permit's own content (title, address, tree count, etc.) -
// distinct from the review_status changes above. Same whitelist pattern as
// the report edit endpoint.
const EDITABLE_PERMIT_FIELDS = [
  'title', 'title_en', 'address', 'lat', 'lon', 'tree_count', 'species', 'reason', 'status',
] as const

app.patch('/api/admin/permits/:id', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const body = await c.req.json<Record<string, unknown>>()
  const keys = Object.keys(body).filter((k) => (EDITABLE_PERMIT_FIELDS as readonly string[]).includes(k))
  if (keys.length === 0) return c.json({ error: 'no editable fields in body' }, 400)
  const setClause = keys.map((k) => `${k} = ?`).join(', ')
  await c.env.DB.prepare(`UPDATE felling_permits SET ${setClause} WHERE id = ?`)
    .bind(...keys.map((k) => body[k]), c.req.param('id'))
    .run()
  return c.json({ ok: true })
})

// Permanent removal, mirroring the report delete endpoint above. Permits
// have no R2 object to clean up alongside them.
app.delete('/api/admin/permits/:id', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  await c.env.DB.prepare('DELETE FROM felling_permits WHERE id = ?').bind(c.req.param('id')).run()
  return c.json({ ok: true })
})

// Manual sync triggers - Cron Triggers can't be fired on demand from
// `wrangler dev`, so these make Tier 1/2 testable locally without waiting
// for the daily schedule. Same admin auth as the review endpoints.
app.post('/api/admin/sync/trees', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  try {
    const count = await syncDelftTrees(c.env)
    return c.json({ ok: true, synced: count })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'sync failed' }, 500)
  }
})

app.post('/api/admin/sync/permits', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  try {
    const count = await syncFellingPermits(c.env)
    return c.json({ ok: true, fetched: count })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'sync failed' }, 500)
  }
})

// Tier 3: one chunk of the publicaties.delft.nl attachment sweep - see
// ingest/publicaties.ts for why this is chunked/resumable and deliberately
// NOT on the daily cron. Call repeatedly (?refresh=1 on the first call, or
// whenever you want to pick up newly published cases) until the response's
// queueRemaining is 0 and discoveryInProgress is false. Matches land in the
// same pending-review queue as everything else on the "Felling permits" tab
// at /admin - nothing here goes live on the map on its own.
app.post('/api/admin/sync/publicaties', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  try {
    const refresh = c.req.query('refresh') === '1'
    const result = await sweepPublicaties(c.env, { refresh })
    return c.json({ ok: true, ...result })
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'sync failed' }, 500)
  }
})

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDailyIngestion(env))
  },
}
