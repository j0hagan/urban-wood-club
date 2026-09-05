import { Hono } from 'hono'
import { runDailyIngestion } from './ingest/run'

export interface Env {
  DB: D1Database
  PHOTOS: R2Bucket
}

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (c) => c.json({ ok: true }))

app.get('/api/trees', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, lat, lon, species_nl, species_lat, source, is_monumental FROM trees LIMIT 5000'
  ).all()
  return c.json(results)
})

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

// Tier 4: public photo upload
app.post('/api/uploads', async (c) => {
  const form = await c.req.formData()
  const photo = form.get('photo')
  const lat = Number(form.get('lat'))
  const lon = Number(form.get('lon'))
  const note = String(form.get('note') ?? '')
  if (!(photo instanceof File)) return c.json({ error: 'missing photo' }, 400)

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

export default {
  fetch: app.fetch,
  // Cloudflare Cron Trigger entrypoint — see wrangler.jsonc "triggers.crons"
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDailyIngestion(env))
  },
}
