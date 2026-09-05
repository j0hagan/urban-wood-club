import { Hono } from 'hono'
import { runDailyIngestion } from './ingest/run'

export interface Env {
  DB: D1Database
  PHOTOS: R2Bucket
  ADMIN_TOKEN?: string
}

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ ok: true }))

// Tier 1 + 1b
app.get('/api/trees', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, lat, lon, species_nl, species_lat, source, is_monumental FROM trees LIMIT 5000'
  ).all()
  return c.json(results)
})

// Tier 2 + 3 (only ever serves reviewed/approved records)
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

app.post('/api/admin/reports/:id/review', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { status } = await c.req.json<{ status: 'approved' | 'rejected' }>()
  if (status !== 'approved' && status !== 'rejected') return c.json({ error: 'invalid status' }, 400)
  await c.env.DB.prepare('UPDATE tree_reports SET review_status = ? WHERE id = ?').bind(status, c.req.param('id')).run()
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

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDailyIngestion(env))
  },
}
