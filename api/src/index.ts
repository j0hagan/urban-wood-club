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

// Tier 2 + 3 + manual (auto-approved on sync - see run.ts; this only ever
// excludes a record someone explicitly rejected by hand). LIMIT bumped from
// 500 - the one-time GRIB bulk import (tier = 'manual') alone adds ~504
// rows on top of whatever Tier 2/3 already has, so 500 would silently clip
// the feed right around that dataset's own size.
app.get('/api/permits', async (c) => {
  const status = c.req.query('status')
  const stmt = status
    ? c.env.DB.prepare(
        `SELECT * FROM felling_permits WHERE review_status = 'approved' AND status = ? ORDER BY published_at DESC LIMIT 2000`
      ).bind(status)
    : c.env.DB.prepare(
        `SELECT * FROM felling_permits WHERE review_status = 'approved' ORDER BY published_at DESC LIMIT 2000`
      )
  const { results } = await stmt.all()
  // photo_r2_key is internal (and, more importantly, never exposed raw -
  // see the GRIB import's own comment on why the original grib.app photo
  // URLs never get stored here at all) - map it to a servable URL the same
  // way /api/reports already does for tree_reports' photo_r2_key.
  return c.json(
    (results as Record<string, unknown>[]).map(({ photo_r2_key, ...rest }) => ({
      ...rest,
      photo_url: photo_r2_key ? `/api/permits/${rest.id}/photo` : null,
    }))
  )
})

app.get('/api/permits/:id/photo', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT photo_r2_key FROM felling_permits WHERE id = ?')
    .bind(id)
    .first<{ photo_r2_key: string | null }>()
  if (!row?.photo_r2_key) return c.notFound()
  const obj = await c.env.PHOTOS.get(row.photo_r2_key)
  if (!obj) return c.notFound()
  return new Response(obj.body, {
    headers: { 'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream' },
  })
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

// Attaches a `photo_urls` array to each report - r.photo_url (the existing
// primary photo, "photo 0") first, then any rows from
// tree_report_extra_photos in upload order. Every report gets an array
// (length 1 when there are no extras) so the frontend never has to special-
// case the single-photo shape.
async function attachExtraPhotoUrls(
  db: D1Database,
  reports: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  if (reports.length === 0) return reports
  const ids = reports.map((r) => r.id as string)
  const placeholders = ids.map(() => '?').join(',')
  const { results: extras } = await db
    .prepare(
      `SELECT id, report_id FROM tree_report_extra_photos WHERE report_id IN (${placeholders}) ORDER BY report_id, position`
    )
    .bind(...ids)
    .all()
  const byReport = new Map<string, string[]>()
  for (const row of extras as { id: string; report_id: string }[]) {
    const list = byReport.get(row.report_id) ?? []
    list.push(`/api/reports/${row.report_id}/extra-photo/${row.id}`)
    byReport.set(row.report_id, list)
  }
  return reports.map((r) => ({
    ...r,
    photo_urls: [r.photo_url as string, ...(byReport.get(r.id as string) ?? [])],
  }))
}

app.get('/api/reports', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${REPORT_COLUMNS} FROM tree_reports WHERE review_status = 'approved' ORDER BY created_at DESC LIMIT 500`
  ).all()
  const withPhotos = (results as Record<string, unknown>[]).map((r) => ({ ...r, photo_url: `/api/reports/${r.id}/photo` }))
  return c.json(await attachExtraPhotoUrls(c.env.DB, withPhotos))
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

// Extra (beyond the primary) photos for a report - same shape/behavior as
// /api/reports/:id/photo above, just keyed by the extra photo's own id too
// so a stale/foreign photoId can't be used to fetch a different report's photo.
app.get('/api/reports/:id/extra-photo/:photoId', async (c) => {
  const row = await c.env.DB.prepare('SELECT r2_key FROM tree_report_extra_photos WHERE id = ? AND report_id = ?')
    .bind(c.req.param('photoId'), c.req.param('id'))
    .first<{ r2_key: string }>()
  if (!row) return c.notFound()
  const obj = await c.env.PHOTOS.get(row.r2_key)
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

  const reportId = crypto.randomUUID()

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
      reportId,
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

  // Extra photos beyond the primary one above (multi-photo upload support -
  // see the "Additional photos" field in ReportWizard.tsx). Each becomes
  // its own R2 object plus a tree_report_extra_photos row recording upload
  // order; failures here are logged but don't fail the submission, since
  // the primary photo and report record are already saved.
  const extraPhotos = form.getAll('extra_photos').filter((v): v is File => v instanceof File)
  for (let i = 0; i < extraPhotos.length; i++) {
    try {
      const extraPhoto = extraPhotos[i]
      const extraKey = `reports/${crypto.randomUUID()}-${extraPhoto.name}`
      await c.env.PHOTOS.put(extraKey, await extraPhoto.arrayBuffer(), {
        httpMetadata: { contentType: extraPhoto.type },
      })
      await c.env.DB.prepare(
        `INSERT INTO tree_report_extra_photos (id, report_id, r2_key, position, created_at) VALUES (?, ?, ?, ?, ?)`
      )
        .bind(crypto.randomUUID(), reportId, extraKey, i, new Date().toISOString())
        .run()
    } catch (err) {
      console.error('extra photo upload failed:', err instanceof Error ? err.message : String(err))
    }
  }

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
  const withPhotos = (results as Record<string, unknown>[]).map((r) => ({ ...r, photo_url: `/api/reports/${r.id}/photo` }))
  return c.json(await attachExtraPhotoUrls(c.env.DB, withPhotos))
})

// Already-live reports - so the admin page can list what's currently on
// the map for takedown, separate from the pending queue above.
app.get('/api/admin/reports/approved', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM tree_reports WHERE review_status = 'approved' ORDER BY created_at DESC LIMIT 200`
  ).all()
  const withPhotos = (results as Record<string, unknown>[]).map((r) => ({ ...r, photo_url: `/api/reports/${r.id}/photo` }))
  return c.json(await attachExtraPhotoUrls(c.env.DB, withPhotos))
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
  const { results: extras } = await c.env.DB.prepare('SELECT r2_key FROM tree_report_extra_photos WHERE report_id = ?')
    .bind(id)
    .all<{ r2_key: string }>()
  await c.env.DB.prepare('DELETE FROM tree_report_extra_photos WHERE report_id = ?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM tree_reports WHERE id = ?').bind(id).run()
  if (row?.photo_r2_key) {
    await c.env.PHOTOS.delete(row.photo_r2_key).catch(() => {})
  }
  for (const extra of extras) {
    await c.env.PHOTOS.delete(extra.r2_key).catch(() => {})
  }
  return c.json({ ok: true })
})

function withPermitPhotoUrl(results: Record<string, unknown>[]) {
  return results.map(({ photo_r2_key, ...rest }) => ({
    ...rest,
    photo_url: photo_r2_key ? `/api/permits/${rest.id}/photo` : null,
  }))
}

app.get('/api/admin/permits/pending', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM felling_permits WHERE review_status = 'pending' ORDER BY published_at DESC LIMIT 200`
  ).all()
  return c.json(withPermitPhotoUrl(results as Record<string, unknown>[]))
})

// Already-live permits - mirrors /api/admin/reports/approved above, so the
// admin page can list and (for a manual mistake or a since-retracted permit)
// delete something that's already on the public map, not just review the
// pending queue. LIMIT stays 200 (a moderation view, not meant to browse
// the full ~500-row GRIB inventory one card at a time) - the public map
// itself reads from /api/permits above, not this endpoint.
app.get('/api/admin/permits/approved', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM felling_permits WHERE review_status = 'approved' ORDER BY published_at DESC LIMIT 200`
  ).all()
  return c.json(withPermitPhotoUrl(results as Record<string, unknown>[]))
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
  // Added for the GRIB tree-by-tree inventory import (see
  // POST /api/admin/inventory/import below) - editable by hand afterward
  // the same way every other permit field already is.
  'requires_permit', 'already_felled', 'species_nl', 'species_lat', 'species_en', 'neighborhood', 'reason_en',
  'planted_year', 'age_years', 'trunk_diameter_class', 'height_class', 'tree_size_class', 'condition_nl', 'condition_en',
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

// Permanent removal, mirroring the report delete endpoint above. Cleans up
// an R2 photo too, if this permit has one (only the GRIB inventory import
// below ever sets photo_r2_key today, but this stays correct either way).
app.delete('/api/admin/permits/:id', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT photo_r2_key FROM felling_permits WHERE id = ?')
    .bind(id)
    .first<{ photo_r2_key: string | null }>()
  await c.env.DB.prepare('DELETE FROM felling_permits WHERE id = ?').bind(id).run()
  if (row?.photo_r2_key) {
    await c.env.PHOTOS.delete(row.photo_r2_key).catch(() => {})
  }
  return c.json({ ok: true })
})

// Batch Dutch->English translation, reused by the import script below to
// translate the ~50 distinct arborist terms behind "Reden vellen" (reason
// for felling) ONCE each rather than once per tree - 504 trees share only a
// few dozen distinct reason phrases (dieback symptoms, fungal indicators,
// structural defects), so translating the small distinct set and
// reassembling client-side keeps this off the request path of the bulk
// import itself (which stays pure SQL, no per-row AI calls, so it can't
// time out a Worker's own request duration limit). Not tied to permits
// specifically - any admin tool that needs a batch of short Dutch phrases
// translated can reuse this.
app.post('/api/admin/translate-batch', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const { texts } = await c.req.json<{ texts: string[] }>()
  if (!Array.isArray(texts) || texts.length === 0) return c.json({ error: 'texts must be a non-empty array' }, 400)
  if (texts.length > 100) return c.json({ error: 'max 100 texts per call' }, 400)
  const results = await Promise.all(texts.map((t) => translateToEnglish(t, c.env.AI).catch(() => null)))
  return c.json({ results })
})

// Tier 5: the Gemeente Delft / GRIB tree-by-tree felling inventory - a full
// export from the same GRIB/Bomenwacht viewer the tier = 'manual' one-off
// form above already targets (see that endpoint's own comment), but a
// one-time bulk load of every tree in the current felling round rather than
// a single hand-checked record. Stays tier = 'manual' (same orange-family
// color on the map, same "Felling inventory" toggle) - entry_source is
// what tells the two apart internally (and is what a future re-run of this
// import should scope its replace-existing wipe to, so it never clobbers a
// one-off record someone added by hand through the "+ Add by hand" form).
// publication_id = `grib-${grib_id}` makes a re-import idempotent (upsert
// on conflict) rather than duplicating every row on a second run.
app.post('/api/admin/inventory/import', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const body = await c.req.json<{
    records: Array<{
      grib_id: string
      lat: number
      lon: number
      species_nl: string | null
      species_lat: string | null
      species_en: string | null
      address: string | null
      neighborhood: string | null
      requires_permit: boolean
      already_felled: boolean
      reason_nl: string | null
      reason_en: string | null
      published_at: string
      planted_year: number | null
      age_years: number | null
      trunk_diameter_class: string | null
      height_class: string | null
      tree_size_class: string | null
      condition_nl: string | null
      condition_en: string | null
    }>
    wipeExisting?: boolean
  }>()
  const records = body.records
  if (!Array.isArray(records) || records.length === 0) return c.json({ error: 'records must be a non-empty array' }, 400)

  // Explicit one-time cleanup, requested directly: replace every existing
  // Felling inventory (orange) record, not just this import's own rows -
  // see this endpoint's header comment for why a future re-run should NOT
  // default to this (it would also wipe any one-off "+ Add by hand" entry).
  if (body.wipeExisting) {
    await c.env.DB.prepare(`DELETE FROM felling_permits WHERE tier = 'manual'`).run()
  }

  const now = new Date().toISOString()
  const statements = records.map((r) => {
    const speciesLabel = r.species_nl ?? r.species_lat ?? 'Tree'
    const speciesLabelEn = r.species_en ?? r.species_lat ?? 'Tree'
    const place = r.address ?? r.neighborhood ?? 'Delft'
    const title = `${speciesLabel} — ${place}`
    const titleEn = `${speciesLabelEn} — ${place}`
    const id = crypto.randomUUID()
    return c.env.DB.prepare(
      `INSERT INTO felling_permits (
         id, publication_id, title, title_en, address, lat, lon, tree_count,
         species, reason, status, tier, source_url, published_at,
         review_status, created_at,
         requires_permit, already_felled, species_nl, species_lat, species_en,
         neighborhood, reason_en, entry_source,
         planted_year, age_years, trunk_diameter_class, height_class, tree_size_class, condition_nl, condition_en
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'aangevraagd', 'manual', ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, 'grib_bulk', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(publication_id) DO UPDATE SET
         title = excluded.title, title_en = excluded.title_en, address = excluded.address,
         lat = excluded.lat, lon = excluded.lon, species = excluded.species, reason = excluded.reason,
         requires_permit = excluded.requires_permit, already_felled = excluded.already_felled,
         species_nl = excluded.species_nl, species_lat = excluded.species_lat, species_en = excluded.species_en,
         neighborhood = excluded.neighborhood, reason_en = excluded.reason_en,
         planted_year = excluded.planted_year, age_years = excluded.age_years,
         trunk_diameter_class = excluded.trunk_diameter_class, height_class = excluded.height_class,
         tree_size_class = excluded.tree_size_class, condition_nl = excluded.condition_nl, condition_en = excluded.condition_en`
    ).bind(
      id,
      `grib-${r.grib_id}`,
      title,
      titleEn,
      r.address,
      r.lat,
      r.lon,
      speciesLabel,
      r.reason_nl,
      'Gemeente Delft tree register (GRIB)',
      r.published_at || now,
      now,
      r.requires_permit ? 1 : 0,
      r.already_felled ? 1 : 0,
      r.species_nl,
      r.species_lat,
      r.species_en,
      r.neighborhood,
      r.reason_en,
      r.planted_year ?? null,
      r.age_years ?? null,
      r.trunk_diameter_class ?? null,
      r.height_class ?? null,
      r.tree_size_class ?? null,
      r.condition_nl ?? null,
      r.condition_en ?? null
    )
  })

  // D1's batch() runs every statement even if inserted alongside others -
  // chunked client-side (see the import script) to stay well under any
  // single request's size/time budget rather than sending all ~500 at once.
  await c.env.DB.batch(statements)

  // Hand back the id D1 assigned to each grib_id (by publication_id) so the
  // import script's next step - uploading each tree's photo - knows which
  // row to attach it to without a second round-trip per record.
  const publicationIds = records.map((r) => `grib-${r.grib_id}`)
  const placeholders = publicationIds.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT id, publication_id FROM felling_permits WHERE publication_id IN (${placeholders})`
  )
    .bind(...publicationIds)
    .all<{ id: string; publication_id: string }>()
  const idByGribId: Record<string, string> = {}
  for (const row of results) {
    idByGribId[row.publication_id.replace(/^grib-/, '')] = row.id
  }
  return c.json({ ok: true, imported: records.length, ids: idByGribId })
})

// One tree's photo from the GRIB inventory import above - separate from the
// bulk JSON import itself so a ~500-row insert never has to carry image
// bytes through the same request. Mirrors POST /api/reports' photo handling
// (multipart form, stored in the same PHOTOS bucket under its own key
// prefix so it can never collide with a community report's own key).
app.post('/api/admin/inventory/:id/photo', async (c) => {
  const unauthorized = requireAdmin(c)
  if (unauthorized) return unauthorized
  const id = c.req.param('id')
  const form = await c.req.formData()
  const photo = form.get('photo')
  if (!(photo instanceof File)) return c.json({ error: 'missing photo' }, 400)
  const key = `inventory/${id}-${photo.name}`
  await c.env.PHOTOS.put(key, await photo.arrayBuffer(), { httpMetadata: { contentType: photo.type } })
  await c.env.DB.prepare('UPDATE felling_permits SET photo_r2_key = ? WHERE id = ?').bind(key, id).run()
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
