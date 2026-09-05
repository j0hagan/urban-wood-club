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

// Tier 4: public photo reports
app.get('/api/uploads', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, lat, lon, note, created_at FROM photo_uploads WHERE status = 'approved' ORDER BY created_at DESC LIMIT 500`
  ).all()
  return c.json((results as Record<string, unknown>[]).map((r) => ({ ...r, photo_url: `/api/uploads/${r.id}/photo` })))
})

app.get('/api/uploads/:id/photo', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT r2_key FROM photo_uploads WHERE id = ?')
    .bind(id)
    .first<{ r2_key: string }>()
  if (!row) return c.notFound()
  const obj = await c.env.PHOTOS.get(row.r2_key)
  if (!obj) return c.notFound()
  return new Response(obj.body, {
    headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream' },
  })
})

app.post('/api/uploads', async (c) => {
  const form = await c.req.formData()
  const photo = form.get('photo')
  const lat = Number(form.get('lat'))
  const lon = Number(form.get('lon'))
  const note = String(form.get('note') ?? '')
  if (!(photo instanceof File)) return c.json({ error: 'missing photo' }, 400)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return c.json({ error: 'missing lat/lon' }, 400)

  const key = `uploads/${crypto.randomUUID()}-${photo.name}`
  await c.env.PHOTOS.put(key, await photo.arrayBuffer(), {
    httpMetadata: { contentType: photo.type },
  })

  await c.env.DB.prepare(
    `INSERT INTO photo_uploads (id, lat, lon, note, r2_key, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  )
    .bind(crypto.randomUUID(), lat, lon, note, key, new Date().toISOString())
    .run()

  return c.json({ ok: true })
})

// --- Minimal moderation endpoints ---
// Nothing (a permit extraction or a public photo) goes live without a pass
// through here first - see the review_status/status columns in schema.sql.
// Auth is a single shared secret for now (`wrangler secret put ADMIN_TOKEN`),
// deliberately not a real auth system - fine for one person moderating a
// single-city trial, not fine beyond that.
function requireAdmin(c: { req: { header: (k: string) => string | undefined }; env: Env; json: Function }) {
  const auth = c.req.header('authorization')
  if (!c.env.ADMIN_TOKEN || auth !== `Bearer ${c.env.ADMIN_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  return null
}

app.get('/api/admin/uploads/pending', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { results } = await c.env.DB.prepare(
    `SELECT id, lat, lon, note, created_at FROM photo_uploads WHERE status = 'pending' ORDER BY created_at DESC LIMIT 200`
  ).all()
  return c.json((results as Record<string, unknown>[]).map((r) => ({ ...r, photo_url: `/api/uploads/${r.id}/photo` })))
})

app.post('/api/admin/uploads/:id/review', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { status } = await c.req.json<{ status: 'approved' | 'rejected' }>()
  if (status !== 'approved' && status !== 'rejected') return c.json({ error: 'invalid status' }, 400)
  await c.env.DB.prepare('UPDATE photo_uploads SET status = ? WHERE id = ?').bind(status, c.req.param('id')).run()
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
