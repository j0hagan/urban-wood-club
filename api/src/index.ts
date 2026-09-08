import { Hono } from 'hono'
import { runDailyIngestion, syncDelftTrees, syncFellingPermits } from './ingest/run'
import { sweepPublicaties } from './ingest/publicaties'
import { geocodeAddress, translateToEnglish } from './ingest/bekendmakingen'

export interface Env {
  DB: D1Database
  PHOTOS: R2Bucket
  ADMIN_TOKEN?: string
  // Workers AI - Dutch->English permit-title translation, see the comment
  // in api/src/ingest/bekendmakingen.ts's translateToEnglish() for why
  // this replaced MyMemory as the primary translator.
  AI: Ai
  // Resend (resend.com), not Cloudflare's own Email Routing send_email
  // binding - switched 2026-09-08 because that binding's sends were
  // succeeding with zero errors but never actually reaching the inbox
  // (no DKIM signing, no DMARC record, a brand-new sending domain with no
  // reputation, and Cloudflare's own Email Routing product gives no
  // delivery/bounce visibility to diagnose it further). Resend gives a
  // real per-message delivery status and proper DKIM once the domain is
  // verified there. A plain secret, not a binding - set via
  // `wrangler secret put RESEND_API_KEY`, never committed to
  // wrangler.jsonc.
  RESEND_API_KEY?: string
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

  // Best-effort email notification via Resend's HTTP API (api.resend.com) -
  // never lets a failed/unconfigured send break the actual report
  // submission. See the Env.RESEND_API_KEY comment above for why this
  // isn't Cloudflare's own Email Routing send_email binding any more.
  if (c.env.RESEND_API_KEY) {
    try {
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
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${c.env.RESEND_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: 'Urban Wood Club <info@urbanwood.club>',
          to: 'j.ohagan.tud@gmail.com',
          subject: 'New tree report on Urban Wood Club',
          text: lines.join('\n'),
        }),
      })
      if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`)
      const body = (await res.json()) as { id?: string }
      console.log('report notification email sent, resend id:', body.id)
    } catch (err) {
      // Notification is a nice-to-have, not a submission requirement - but
      // log it (visible in Workers Observability > Logs) since this is
      // otherwise a silent failure with no other way to diagnose it.
      console.error('report notification email failed:', err instanceof Error ? err.message : String(err))
    }
  } else {
    console.log('report notification skipped: RESEND_API_KEY not set')
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
  'title', 'title_en', 'address', 'lat', 'lon', 'tree_count', 'species', 'reason', 'status', 'source_url',
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

// Manually adding a felling record by hand - distinct from Tier 2/3, which
// both come from crawling an official feed automatically. This is for a
// tree/permit the site owner has personally verified from a source this
// project can't crawl automatically (the GRIB/Bomenwacht viewer is the
// motivating case - see the project roadmap's Tier 3/GRIB research notes
// for why that source stays a manual, occasional check rather than an
// automated pipeline: it's access-code-gated and its markers only click
// reliably ~35-40% of the time). Tagged tier = 'manual' so the public map
// can render it in a different color (orange) from an auto-scraped Tier
// 2/3 record (yellow) - see TreeMap.tsx's permit marker color.
app.post('/api/admin/permits', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const body = await c.req.json<Record<string, unknown>>()
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return c.json({ error: 'title is required' }, 400)

  const status = typeof body.status === 'string' && body.status.trim() ? body.status.trim() : 'aangevraagd'
  const address = typeof body.address === 'string' && body.address.trim() ? body.address.trim() : null
  let lat = typeof body.lat === 'number' ? body.lat : null
  let lon = typeof body.lon === 'number' ? body.lon : null
  if ((lat == null || lon == null) && address) {
    // The first real use of this endpoint had the admin type a coordinate
    // pair ("52.00526, 4.37174") into the Address field instead of the
    // dedicated Lat/Lon fields - PDOK's geocoder obviously can't resolve
    // that as a street address, so it silently came back null and the
    // record never got a map marker. Catch that shape directly rather
    // than relying only on the frontend sending the right fields.
    const coordMatch = address.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/)
    if (coordMatch) {
      lat = Number(coordMatch[1])
      lon = Number(coordMatch[2])
    } else {
      // A real address - geocode it via the same free PDOK lookup Tier
      // 2/3 already use, so the admin doesn't have to go find coordinates
      // by hand for every manual entry.
      const coords = await geocodeAddress(address).catch(() => null)
      if (coords) {
        lat = coords.lat
        lon = coords.lon
      }
    }
  }
  const treeCount = typeof body.tree_count === 'number' ? body.tree_count : null
  const species = typeof body.species === 'string' && body.species.trim() ? body.species.trim() : null
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null
  const sourceUrl = typeof body.source_url === 'string' && body.source_url.trim() ? body.source_url.trim() : 'Added by hand in /admin'
  const titleEn = await translateToEnglish(title, c.env.AI).catch(() => null)

  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO felling_permits
       (id, publication_id, title, title_en, address, lat, lon, tree_count, species, reason, status, tier, source_url, published_at, review_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, 'approved', ?)`
  )
    .bind(id, `manual-${id}`, title, titleEn, address, lat, lon, treeCount, species, reason, status, sourceUrl, now, now)
    .run()

  const row = await c.env.DB.prepare('SELECT * FROM felling_permits WHERE id = ?').bind(id).first()
  return c.json(row, 201)
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
