// Tier 3 ingestion: felling mentioned inside a bigger permit's own
// attachments, for the subset of Delft permits where that's actually
// possible to find online.
//
// Background (see the project doc's 2026-09-07 Status entries for the
// full investigation): Delft's simple "reguliere procedure" permits
// (most single-tree felling permits, most small permits) don't publish
// any attachments online at all - the case file is "ter inzage",
// by-appointment only at the municipal office. Tier 2 (bekendmakingen.ts)
// already covers those fine, including a felling mention bundled inside
// a bigger simple permit, because the whole notice text is one short
// paragraph that gets full-text searched anyway.
//
// But Delft's bigger/more complex permits ("uitgebreide procedure") DO
// publish real attachments online, at a separate Delft-run document
// portal: https://publicaties.delft.nl (Drupal + the open-source
// "OpenWoo" module - BOPA, Beschikkingen, Omgevingsplan and Woo-verzoeken
// en -besluiten categories). Confirmed working 2026-09-07: no login
// required, every case has a detail page listing its attachments as
// direct links to a public S3 bucket
// (dvg-delft-bucket.s3.eu-central-1.amazonaws.com), and one real felling
// case was found there this way - a Woo-verzoek titled "Kapvergunning
// Hof van Delft" with a real 12-tree felling permit PDF attached.
//
// This module crawls that portal's plain server-rendered listing (NOT its
// AJAX search - that only responds to a genuine simulated browser click,
// not a plain fetch() POST, and isn't needed here anyway since this
// enumerates every case rather than searching by keyword), fetches each
// case's attachment PDFs, extracts their text, and greps for the same
// felling keywords Tier 2 uses. A hit is stored as a Tier 3
// felling_permits row with review_status = 'pending' - unlike Tier 2,
// this is a heuristic keyword match inside a much bigger unrelated
// document, not an authoritative "this permit is about felling" record,
// so it goes through the existing /admin review queue like a Tier 4
// community report does, rather than auto-publishing.
//
// Deliberately NOT wired into the daily Cron Trigger (see run.ts) - this
// is meant to run as an occasional manual sweep via
// POST /api/admin/sync/publicaties, not a daily job:
//   - it's comparatively expensive (one fetch per attachment PDF, plus a
//     full PDF-text-extraction pass per attachment)
//   - based on the 2026-09-07 sample, low-yield relative to that cost
//   - Cloudflare Workers (especially the free plan) cap both the number
//     of outgoing subrequests and CPU time per invocation, so a full
//     sweep of the portal's ~170+ cases has to happen across several
//     admin-triggered calls, not one - see sweepPublicaties below for how
//     that's chunked and resumed.
//
// Not independently verified end-to-end from this session (network to
// publicaties.delft.nl and to the S3 bucket is only reachable from a
// deployed Worker or a real browser, not from this sandbox - see the
// project doc) - test with `wrangler dev` or a real deploy before relying
// on it, and watch the Workers Observability tab (the app.onError
// diagnostic handler already surfaces real errors) for the first few
// runs. The PDF text extraction step (unpdf) in particular is the
// biggest unknown: it's built for edge/Workers runtimes, but PDF parsing
// is CPU-heavy, and if a case's attachments are large scanned-image PDFs
// with no embedded text layer, extraction will just come back empty
// (a normal "no match", not an error) - that's an inherent limitation of
// keyword-searching PDF text, not a bug.

import { extractText, getDocumentProxy } from 'unpdf'
import type { Env } from '../index'
import {
  FELLING_KEYWORDS,
  extractAddress,
  extractReasonHint,
  extractSpeciesHint,
  extractTreeCount,
  geocodeAddress,
  sleep,
  translateToEnglish,
} from './bekendmakingen'

const PORTAL_BASE = 'https://publicaties.delft.nl'
const STATE_KEY = 'publicaties_tier3_state'

interface QueueItem {
  uuid: string
  title: string
  detailUrl: string
  publishedAt: string
  category: string
}

interface SweepState {
  queue: QueueItem[]
  processed: string[]        // uuids already scanned (matched or not) - never rescanned
  discoveryPage: number | null // next listing page to fetch, or null when discovery is complete/not running
  discoveryTotal: number | null // total item count from the portal's own "van N resultaten" line
}

interface Tier3Candidate {
  publicationId: string
  title: string
  titleEn: string | null
  sourceUrl: string
  publishedAt: string
  address: string | null
  lat: number | null
  lon: number | null
  treeCount: number | null
  species: string | null
  reason: string
}

export interface SweepResult {
  itemsScanned: number
  matched: number
  queueRemaining: number
  discoveryInProgress: boolean
}

async function loadState(env: Env): Promise<SweepState> {
  const row = await env.DB.prepare(`SELECT value FROM ingestion_state WHERE key = ?`)
    .bind(STATE_KEY)
    .first<{ value: string }>()
    .catch(() => null)
  if (!row?.value) {
    return { queue: [], processed: [], discoveryPage: null, discoveryTotal: null }
  }
  try {
    return JSON.parse(row.value) as SweepState
  } catch {
    return { queue: [], processed: [], discoveryPage: null, discoveryTotal: null }
  }
}

async function saveState(env: Env, state: SweepState): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ingestion_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
    .bind(STATE_KEY, JSON.stringify(state))
    .run()
}

// Parses one plain (non-AJAX) listing page - `?page=N`, 0-indexed, 10
// results per page - into queue items plus the portal's own reported
// total result count. Confirmed 2026-09-07: this is a normal
// server-rendered page, no JS/AJAX needed, so a plain fetch() sees the
// same markup a browser does.
const LISTING_ITEM_RE =
  /<a class="openwoo__teaser-link" href="([^"]+)">([^<]*)<\/a>\s*<\/h4><time datetime="([^"]+)"[^>]*>[^<]*<\/time>[\s\S]*?<div class="openwoo__teaser-tag openwoo__teaser-category">([^<]*)<\/div>/g

const LISTING_TOTAL_RE = /van\s+(\d+)\s+resultaten/

async function fetchListingPage(page: number): Promise<{ items: QueueItem[]; total: number | null }> {
  const res = await fetch(`${PORTAL_BASE}/?page=${page}`)
  if (!res.ok) throw new Error(`listing page ${page}: ${res.status}`)
  const html = await res.text()

  const totalMatch = html.match(LISTING_TOTAL_RE)
  const total = totalMatch ? Number(totalMatch[1]) : null

  const items: QueueItem[] = []
  for (const m of html.matchAll(LISTING_ITEM_RE)) {
    const href = m[1]
    const uuidMatch = href.match(/result\/([0-9a-f-]{36})/i)
    if (!uuidMatch) continue
    items.push({
      uuid: uuidMatch[1],
      title: decodeHtml(m[2].trim()),
      detailUrl: href.startsWith('http') ? href : `${PORTAL_BASE}${href}`,
      publishedAt: m[3],
      category: decodeHtml(m[4].trim()),
    })
  }
  return { items, total }
}

// Parses one case detail page into its list of attachment PDF links.
// Confirmed 2026-09-07: also plain server-rendered markup, no JS needed.
const ATTACHMENT_RE = /<a href="([^"]+)" class="attachments openwoo__attachments">([^<]*)<\/a>/g

async function fetchAttachments(detailUrl: string): Promise<Array<{ url: string; filename: string }>> {
  const res = await fetch(detailUrl)
  if (!res.ok) throw new Error(`detail page ${detailUrl}: ${res.status}`)
  const html = await res.text()
  const attachments: Array<{ url: string; filename: string }> = []
  for (const m of html.matchAll(ATTACHMENT_RE)) {
    if (!/\.pdf(\?|$)/i.test(m[1])) continue // skip non-PDF attachments (images, etc.) - nothing to text-search there
    attachments.push({ url: m[1], filename: decodeHtml(m[2].trim()) })
  }
  return attachments
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
}

// Downloads one PDF and extracts its plain text. unpdf is built for
// edge/Workers runtimes specifically (no Node-native dependencies), but
// this is the least-tested part of the pipeline from this session - see
// the file header. A failure or an image-only PDF with no text layer both
// just come back as null, treated the same as "no match" rather than an
// error, so one bad attachment can't sink the whole sweep.
async function extractPdfText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const buffer = new Uint8Array(await res.arrayBuffer())
    const pdf = await getDocumentProxy(buffer)
    const { text } = await extractText(pdf, { mergePages: true })
    return text || null
  } catch (err) {
    console.error(`pdf text extraction failed for ${url}:`, err)
    return null
  }
}

// Looks for the first felling-keyword hit in a PDF's extracted text and
// builds a candidate record from a window of text around it - the same
// best-effort extractors Tier 2 uses (tree count, species, reason,
// address), just run against that window instead of a short RSS title,
// since a PDF is far too long to run them against wholesale.
const SNIPPET_RADIUS = 400

function findFellingMention(
  text: string
): { keyword: string; snippet: string } | null {
  const lower = text.toLowerCase()
  for (const keyword of FELLING_KEYWORDS) {
    const idx = lower.indexOf(keyword)
    if (idx === -1) continue
    const start = Math.max(0, idx - SNIPPET_RADIUS)
    const end = Math.min(text.length, idx + keyword.length + SNIPPET_RADIUS)
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim()
    return { keyword, snippet }
  }
  return null
}

// Sweeps the publicaties.delft.nl portal for felling mentions, resuming
// discovery and item processing from wherever a previous call left off
// (state persisted in ingestion_state, keyed STATE_KEY - see loadState/
// saveState above). Chunked and resumable because Cloudflare Workers cap
// both outgoing subrequests and CPU time per invocation, and this portal
// has ~170+ cases with sometimes 20+ attachments each - one call can't
// realistically get through all of it. Call this repeatedly (e.g. from
// the admin page or a curl loop) until the result's queueRemaining is 0
// and discoveryInProgress is false.
//
// `refresh: true` restarts discovery from page 0 to pick up newly
// published cases (previously processed uuids are still skipped, so this
// doesn't re-scan the whole portal - just re-lists it to find what's new).
// Without it, discovery only runs the first time this is ever called
// (when no state exists yet).
export async function sweepPublicaties(
  env: Env,
  opts: { refresh?: boolean; maxSubrequests?: number } = {}
): Promise<SweepResult> {
  const maxSubrequests = opts.maxSubrequests ?? 45 // headroom under Workers Free's 50-subrequest cap
  let budget = maxSubrequests

  const state = await loadState(env)
  if (opts.refresh) {
    state.discoveryPage = 0
    state.discoveryTotal = null
  } else if (state.discoveryPage === null && state.processed.length === 0 && state.queue.length === 0) {
    // First run ever - kick off discovery.
    state.discoveryPage = 0
  }

  const processedSet = new Set(state.processed)
  const queuedUuids = new Set(state.queue.map((q) => q.uuid))

  // --- Discovery: page through the plain listing, queueing anything not
  // already processed or already queued. Resumable via discoveryPage. ---
  if (state.discoveryPage !== null) {
    while (budget > 0) {
      if (state.discoveryTotal !== null && state.discoveryPage * 10 >= state.discoveryTotal) break
      const { items, total } = await fetchListingPage(state.discoveryPage)
      budget--
      if (total !== null) state.discoveryTotal = total
      for (const item of items) {
        if (processedSet.has(item.uuid) || queuedUuids.has(item.uuid)) continue
        state.queue.push(item)
        queuedUuids.add(item.uuid)
      }
      state.discoveryPage++
      if (items.length === 0) break // defensive: unexpected empty page, stop rather than loop forever
      await sleep(150)
    }
    if (state.discoveryTotal !== null && state.discoveryPage * 10 >= state.discoveryTotal) {
      state.discoveryPage = null // discovery complete
    }
  }

  // --- Processing: work through the queue, one case at a time. ---
  const matched: Tier3Candidate[] = []
  let itemsScanned = 0

  while (budget > 0 && state.queue.length > 0) {
    const item = state.queue[0]
    let attachments: Array<{ url: string; filename: string }>
    try {
      attachments = await fetchAttachments(item.detailUrl)
      budget--
    } catch (err) {
      console.error(`tier3: failed to fetch attachments for ${item.uuid}:`, err)
      // Drop it either way - a permanently-broken detail page would
      // otherwise wedge the queue forever retrying the same failure.
      state.queue.shift()
      state.processed.push(item.uuid)
      itemsScanned++
      continue
    }

    if (attachments.length > budget) {
      // Not enough budget left to check every attachment on this case -
      // stop here without marking it processed, so the next call picks
      // this exact case back up (and re-fetches its (cheap) detail page,
      // the only real cost of not finishing it now).
      break
    }

    let hit: Tier3Candidate | null = null
    for (const att of attachments) {
      const text = await extractPdfText(att.url)
      budget--
      if (!text) continue
      const mention = findFellingMention(text)
      if (!mention) continue

      const address = extractAddress(mention.snippet)
      hit = {
        publicationId: `publicaties:${item.uuid}`,
        title: `${item.title} — possible felling mention (Tier 3, matched "${mention.keyword}" in ${att.filename})`,
        titleEn: null,
        sourceUrl: item.detailUrl,
        publishedAt: new Date(item.publishedAt).toISOString(),
        address,
        lat: null,
        lon: null,
        treeCount: extractTreeCount(mention.snippet),
        species: extractSpeciesHint(mention.snippet),
        reason: `"…${mention.snippet}…"`,
      }
      break // one hit is enough to flag the case - the human reviewer can open source_url for full context
    }

    state.queue.shift()
    state.processed.push(item.uuid)
    itemsScanned++
    if (hit) matched.push(hit)
  }

  // Best-effort geocode + translation for whatever matched this run -
  // same best-effort spirit as Tier 2, a miss just leaves the field null.
  for (const c of matched) {
    if (c.address) {
      const coords = await geocodeAddress(c.address).catch(() => null)
      if (coords) {
        c.lat = coords.lat
        c.lon = coords.lon
      }
    }
    c.titleEn = await translateToEnglish(c.title, env.AI).catch(() => null)
  }

  await saveState(env, state)

  for (const c of matched) {
    await env.DB.prepare(
      `INSERT INTO felling_permits
         (id, publication_id, title, title_en, address, lat, lon, tree_count, species, reason, status, tier, source_url, published_at, review_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aangevraagd', 'tier3', ?, ?, 'pending', ?)
       ON CONFLICT(publication_id) DO UPDATE SET
         title = excluded.title,
         title_en = coalesce(excluded.title_en, felling_permits.title_en),
         address = coalesce(excluded.address, felling_permits.address),
         lat = coalesce(excluded.lat, felling_permits.lat),
         lon = coalesce(excluded.lon, felling_permits.lon),
         tree_count = coalesce(excluded.tree_count, felling_permits.tree_count),
         species = coalesce(excluded.species, felling_permits.species),
         reason = excluded.reason`
    )
      .bind(
        crypto.randomUUID(),
        c.publicationId,
        c.title,
        c.titleEn,
        c.address,
        c.lat,
        c.lon,
        c.treeCount,
        c.species,
        c.reason,
        c.sourceUrl,
        c.publishedAt,
        new Date().toISOString()
      )
      .run()
  }

  return {
    itemsScanned,
    matched: matched.length,
    queueRemaining: state.queue.length,
    discoveryInProgress: state.discoveryPage !== null,
  }
}
