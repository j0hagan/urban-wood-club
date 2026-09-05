// Tier 2 ingestion: the national "Officiele Bekendmakingen" system (run by
// KOOP/overheid.nl) publishes every Dutch municipality's permit decisions,
// felling permits included, as CC0-licensed public records, through a
// public SRU-ish API.
//
// Dataset page: https://data.overheid.nl/dataset/officiele-bekendmakingen
// Endpoint:     https://zoek.officielebekendmakingen.nl/sru/Search
//
// Confirmed live (Sept 2026) by literally issuing these fetch calls from a
// real browser - this host 403s/blocks requests from every sandboxed
// environment available while building this (no way to curl it directly),
// so a real browser was the only way to verify it:
//   - requires x-connection=oep (the "Officiele Publicaties" connection).
//     The version=2.0 query this file used to build, with no x-connection
//     and dt.creator/cql.textAndIndexes field names, 500'd on every
//     attempt - those fields don't exist on this connection at all.
//   - version=1.2, CQL fields are plain (creator, title, date - not
//     dt.creator etc.), string match is %wildcard% with no quotes, and
//     comparison operators like date>=YYYY-MM-DD work.
//   - creator is just the bare municipality name ("Delft"), not
//     "gemeente Delft".
//   - grouped OR / parens in one query, e.g. "(title=%a% OR title=%b%)",
//     500'd on every attempt - so each keyword below is queried
//     separately and results are merged/de-duplicated by identifier.
//   - the endpoint rate-limits aggressively: repeat queries in quick
//     succession started 500'ing mid-verification (even ones that had
//     just worked). The per-keyword/per-geocode loops below pace
//     themselves with a small delay for that reason.
//   - response is SRU searchRetrieveResponse XML. The fields read below
//     (dcterms:title, dcterms:identifier, dcterms:creator, the
//     owmsmantel dcterms:date, and enrichedData > url) were all read off
//     a real response for `creator=Delft AND title=%kap%`, e.g.
//     identifier "gmb-2026-411379", title "Aanvraag vergunning voor het
//     kappen van 6 bomen in verband met achterstallig onderhoud aan Sint
//     Jorisweg Delft", url "https://zoek.officielebekendmakingen.nl/gmb-2026-411379.html".
//
// Titles are free text, not structured data - address, tree count,
// species and status below are all best-effort extraction from that
// string, not guaranteed fields. Workers don't have DOMParser, and this
// environment can't reach the npm registry to add a real XML parser
// dependency, so parseSruResponse below is a small hand-rolled
// block-by-block regex extractor scoped to the flat, non-nested fields
// this feed actually needs.
//
// Geocoding (title address text -> lat/lon) goes through PDOK's free
// Locatieserver (api.pdok.nl, no key required) - also confirmed live: it
// resolves both full addresses ("Hoogenhouckstraat 28 2614BX Delft") and
// bare street names ("Sint Jorisweg Delft", falling back to the street's
// own centroid point).

const SRU_ENDPOINT = 'https://zoek.officielebekendmakingen.nl/sru/Search'
const PDOK_FREE_ENDPOINT = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free'

const FELLING_KEYWORDS = ['kappen', 'vellen', 'houtopstand', 'kapvergunning']

export interface FellingAnnouncement {
  publicationId: string
  title: string
  publishedAt: string
  sourceUrl: string
  status: 'aangevraagd' | 'verleend' | 'definitief' | 'geweigerd'
  address: string | null
  treeCount: number | null
  speciesHint: string | null
  lat: number | null
  lon: number | null
}

export async function fetchDelftFellingAnnouncements(
  sinceDateYYYYMMDD: string
): Promise<FellingAnnouncement[]> {
  const byId = new Map<string, FellingAnnouncement>()

  for (const keyword of FELLING_KEYWORDS) {
    const cql = `creator=Delft AND title=%${keyword}% AND date>=${sinceDateYYYYMMDD}`
    const url = new URL(SRU_ENDPOINT)
    url.searchParams.set('version', '1.2')
    url.searchParams.set('operation', 'searchRetrieve')
    url.searchParams.set('x-connection', 'oep')
    url.searchParams.set('startRecord', '1')
    url.searchParams.set('maximumRecords', '100')
    url.searchParams.set('query', cql)

    try {
      const res = await fetch(url.toString(), { headers: { Accept: 'application/xml' } })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const xml = await res.text()
      for (const record of parseSruResponse(xml)) {
        if (!byId.has(record.publicationId)) byId.set(record.publicationId, record)
      }
    } catch (err) {
      // One bad keyword shouldn't sink the whole sync - log and carry on
      // with whatever the other keywords turn up.
      console.error(`bekendmakingen SRU query for "${keyword}" failed:`, err)
    }

    // Be polite - the endpoint 500s under rapid repeat requests.
    await sleep(500)
  }

  const announcements = [...byId.values()]

  // Geocode whatever address text we could pull from each title.
  // Best-effort: a miss just leaves lat/lon null (the record still gets
  // stored and shows up in the moderation queue unplaced, rather than
  // being dropped, so a human can fill in the location by hand).
  for (const a of announcements) {
    if (!a.address) continue
    const coords = await geocodeAddress(a.address)
    if (coords) {
      a.lat = coords.lat
      a.lon = coords.lon
    }
    await sleep(200)
  }

  return announcements
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
}

function extractTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  if (!m) return null
  const text = decodeXmlEntities(m[1]).trim()
  return text || null
}

function deriveStatus(title: string): FellingAnnouncement['status'] {
  const t = title.toLowerCase()
  if (/geweigerd|weigering/.test(t)) return 'geweigerd'
  if (/definitief/.test(t)) return 'definitief'
  if (/verlening|verleend|verleende/.test(t)) return 'verleend'
  return 'aangevraagd'
}

// Best-effort street(+number+postcode) extraction from a Dutch permit
// title, e.g.:
//   "... Hoogenhouckstraat 28 2614BX Delft"  -> "Hoogenhouckstraat 28 2614BX Delft"
//   "... aan Sint Jorisweg Delft"            -> "Sint Jorisweg Delft"
// Looks for a capitalized word ending in a common Dutch street suffix,
// optionally followed by a house number and/or postcode, ending at
// "Delft". Titles that don't contain a recognizable street name (e.g.
// "kappen van 6 bomen in het Delftse Hout") come back null.
const STREET_SUFFIXES =
  'straat|weg|laan|plein|kade|singel|pad|hof|dijk|gracht|baan|dreef|park|plantsoen|erf|steeg|markt'
const ADDRESS_RE = new RegExp(
  `([A-ZÀ-ÿ][\\wÀ-ÿ'.]*(?:\\s[A-ZÀ-ÿ][\\wÀ-ÿ'.]*)*(?:${STREET_SUFFIXES}))` +
    `((?:\\s\\d+[a-zA-Z]?)?(?:\\s\\d{4}\\s?[A-Z]{2})?\\s*Delft)`
)

function extractAddress(title: string): string | null {
  const m = title.match(ADDRESS_RE)
  return m ? `${m[1]}${m[2]}`.replace(/\s+/g, ' ').trim() : null
}

const DUTCH_NUMBER_WORDS: Record<string, number> = {
  een: 1,
  twee: 2,
  drie: 3,
  vier: 4,
  vijf: 5,
  zes: 6,
  zeven: 7,
  acht: 8,
  negen: 9,
  tien: 10,
}

// "6 bomen" / "een boom" -> 6 / 1. Only matches an explicit count right
// next to "boom"/"bomen" - no count in the title just leaves this null
// rather than guessing.
function extractTreeCount(title: string): number | null {
  const m = title.match(/\b(\d{1,3}|een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien)\b\s+(?:bomen|boom)\b/i)
  if (!m) return null
  const raw = m[1].toLowerCase()
  return /^\d+$/.test(raw) ? Number(raw) : (DUTCH_NUMBER_WORDS[raw] ?? null)
}

// A rough species hint pulled from common Dutch tree-name words in the
// title (e.g. "twee Canadese populieren" -> "populier"). This is not
// authoritative species data - Tier 1's own species_nl field is - just
// something to show while a permit is still pending review/geocoding.
const SPECIES_HINTS: Array<[RegExp, string]> = [
  [/\beiken?\b/i, 'eik'],
  [/\bbeuken?\b/i, 'beuk'],
  [/\blindes?\b/i, 'linde'],
  [/\bkastanjes?\b/i, 'kastanje'],
  [/\bpopulieren?\b/i, 'populier'],
  [/\bwilgen?\b/i, 'wilg'],
  [/\belzen?\b/i, 'els'],
  [/\besdoorns?\b/i, 'esdoorn'],
  [/\bberken?\b/i, 'berk'],
  [/\biepen?\b/i, 'iep'],
  [/\bplatan(?:en|e)?\b/i, 'plataan'],
  [/\bden(?:nen)?\b/i, 'den'],
  [/\bspar(?:ren)?\b/i, 'spar'],
]

function extractSpeciesHint(title: string): string | null {
  for (const [re, label] of SPECIES_HINTS) {
    if (re.test(title)) return label
  }
  return null
}

function parseSruResponse(xml: string): FellingAnnouncement[] {
  const announcements: FellingAnnouncement[] = []
  const recordBlocks = xml.match(/<record>[\s\S]*?<\/record>/g) ?? []

  for (const block of recordBlocks) {
    const publicationId = extractTag(block, 'dcterms:identifier')
    const title = extractTag(block, 'dcterms:title')
    const publishedAt = extractTag(block, 'dcterms:date') ?? extractTag(block, 'dcterms:modified')
    const urlMatch = block.match(/<url>([\s\S]*?)<\/url>/)
    const sourceUrl = urlMatch ? decodeXmlEntities(urlMatch[1]).trim() : null

    if (!publicationId || !title || !sourceUrl) continue

    announcements.push({
      publicationId,
      title,
      publishedAt: publishedAt ?? new Date().toISOString().slice(0, 10),
      sourceUrl,
      status: deriveStatus(title),
      address: extractAddress(title),
      treeCount: extractTreeCount(title),
      speciesHint: extractSpeciesHint(title),
      lat: null,
      lon: null,
    })
  }

  return announcements
}

interface PdokFreeResponse {
  response?: {
    docs?: Array<{ centroide_ll?: string }>
  }
}

async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null> {
  const url = new URL(PDOK_FREE_ENDPOINT)
  url.searchParams.set('q', address)
  url.searchParams.set('rows', '1')
  url.searchParams.set('fl', 'centroide_ll')

  try {
    const res = await fetch(url.toString())
    if (!res.ok) return null
    const data = await res.json<PdokFreeResponse>()
    const point = data.response?.docs?.[0]?.centroide_ll
    if (!point) return null
    // PDOK returns "POINT(lon lat)" (WGS84).
    const m = point.match(/POINT\(([-\d.]+)\s+([-\d.]+)\)/)
    if (!m) return null
    return { lon: Number(m[1]), lat: Number(m[2]) }
  } catch {
    return null
  }
}
