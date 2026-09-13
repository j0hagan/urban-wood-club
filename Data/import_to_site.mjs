// One-time import of the GRIB tree-by-tree felling inventory (data/import_records.json
// + data/processed_photos/) into the live Urban Wood Club site.
//
// Run this from the `data/` folder (or anywhere - it resolves its own paths),
// with your admin token as an environment variable so it's never typed
// anywhere Claude can see it:
//
//   UWC_ADMIN_TOKEN="paste-the-token-here" node import_to_site.mjs
//
// Requires Node 18+ (uses the built-in fetch/FormData/Blob - no npm install
// needed). Safe to re-run: the backend upserts by grib_id, but note the
// FIRST run wipes every existing "Felling inventory" (orange) record first
// (WIPE_EXISTING below) - a re-run after that will just update rows in
// place, not wipe again, since WIPE_EXISTING is a one-time constant here.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE_URL = 'https://urbanwood.club'
const TOKEN = process.env.UWC_ADMIN_TOKEN
const RECORDS_PATH = path.join(__dirname, 'import_records.json')
const PHOTOS_DIR = path.join(__dirname, 'processed_photos')
const CHUNK_SIZE = 100
const PHOTO_CONCURRENCY = 5

// Only the very FIRST run of this script against a fresh dataset should
// wipe existing orange records (per "delete all existing orange, add all
// of these trees"). Flip to false if you ever re-run this script later
// just to refresh the same GRIB export (the upsert-by-grib_id already
// handles that safely without wiping anything).
const WIPE_EXISTING_ON_FIRST_CHUNK = false

if (!TOKEN) {
  console.error('Missing UWC_ADMIN_TOKEN environment variable. Run as:\n  UWC_ADMIN_TOKEN="..." node import_to_site.mjs')
  process.exit(1)
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${TOKEN}`, ...extra }
}

async function readJson(res, label) {
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`${label} failed: ${res.status} ${text.slice(0, 300)}`)
  }
  return res.json()
}

async function main() {
  const records = JSON.parse(await readFile(RECORDS_PATH, 'utf-8'))
  console.log(`Loaded ${records.length} tree records from ${RECORDS_PATH}`)

  // --- Step 1: translate the distinct Dutch felling-reason TERMS once,
  // not once per tree (504 trees share only ~50 distinct terms) - see the
  // backend's own comment on POST /api/admin/translate-batch for why.
  const termSet = new Set()
  for (const r of records) {
    if (!r.reason_nl) continue
    for (const term of r.reason_nl.split(',')) {
      const t = term.trim()
      if (t) termSet.add(t)
    }
  }
  const terms = [...termSet]
  console.log(`Translating ${terms.length} distinct reason terms...`)
  const translateRes = await fetch(`${BASE_URL}/api/admin/translate-batch`, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ texts: terms }),
  })
  const { results: translations } = await readJson(translateRes, 'translate-batch')
  const termToEn = new Map(terms.map((t, i) => [t, translations[i] ?? null]))

  function reasonEnFor(reasonNl) {
    if (!reasonNl) return null
    const parts = reasonNl.split(',').map((t) => t.trim()).filter(Boolean)
    const translated = parts.map((p) => termToEn.get(p) || p)
    return translated.join(', ')
  }

  // --- Step 2: bulk insert/upsert the tree records themselves, in chunks.
  const idByGribId = {}
  let imported = 0
  for (let i = 0; i < records.length; i += CHUNK_SIZE) {
    const chunk = records.slice(i, i + CHUNK_SIZE)
    const payloadRecords = chunk.map((r) => ({
      grib_id: r.grib_id,
      lat: r.lat,
      lon: r.lon,
      species_nl: r.species_nl,
      species_lat: r.species_lat,
      species_en: r.species_en,
      address: r.address,
      neighborhood: r.neighborhood,
      requires_permit: !!r.requires_permit,
      already_felled: !!r.already_felled,
      reason_nl: r.reason_nl,
      reason_en: reasonEnFor(r.reason_nl),
      planted_year: r.planted_year ?? null,
      age_years: r.age_years ?? null,
      trunk_diameter_class: r.trunk_diameter_class ?? null,
      height_class: r.height_class ?? null,
      tree_size_class: r.tree_size_class ?? null,
      condition_nl: r.condition_nl ?? null,
      condition_en: r.condition_en ?? null,
    }))
    const wipeExisting = i === 0 && WIPE_EXISTING_ON_FIRST_CHUNK
    const res = await fetch(`${BASE_URL}/api/admin/inventory/import`, {
      method: 'POST',
      headers: authHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ records: payloadRecords, wipeExisting }),
    })
    const body = await readJson(res, `inventory/import chunk ${i}`)
    Object.assign(idByGribId, body.ids)
    imported += body.imported
    console.log(`  chunk ${i / CHUNK_SIZE + 1}: imported ${body.imported} (wipeExisting=${wipeExisting})`)
  }
  console.log(`Imported/updated ${imported} tree records total.`)

  // --- Step 3: upload each tree's photo, with light concurrency.
  const withPhoto = records.filter((r) => r.has_photo && idByGribId[r.grib_id])
  console.log(`Uploading ${withPhoto.length} photos...`)
  let uploaded = 0
  let failed = 0
  const failures = []
  for (let i = 0; i < withPhoto.length; i += PHOTO_CONCURRENCY) {
    const batch = withPhoto.slice(i, i + PHOTO_CONCURRENCY)
    await Promise.all(
      batch.map(async (r) => {
        const id = idByGribId[r.grib_id]
        const filePath = path.join(PHOTOS_DIR, r.photo_filename)
        try {
          const bytes = await readFile(filePath)
          const form = new FormData()
          form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), r.photo_filename)
          const res = await fetch(`${BASE_URL}/api/admin/inventory/${id}/photo`, {
            method: 'POST',
            headers: authHeaders(),
            body: form,
          })
          if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
          uploaded++
        } catch (e) {
          failed++
          failures.push({ grib_id: r.grib_id, error: e instanceof Error ? e.message : String(e) })
        }
      })
    )
    process.stdout.write(`\r  uploaded ${uploaded}/${withPhoto.length} (failed: ${failed})`)
  }
  console.log()
  if (failures.length) {
    console.log('Failures:')
    for (const f of failures.slice(0, 20)) console.log(' ', f.grib_id, f.error)
  }
  console.log(`\nDone. ${imported} trees imported, ${uploaded} photos uploaded, ${failed} photo failures.`)
}

main().catch((e) => {
  console.error('Import failed:', e instanceof Error ? e.stack : e)
  process.exit(1)
})
