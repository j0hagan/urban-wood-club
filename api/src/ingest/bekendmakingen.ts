// Tier 2 ingestion: the national "Officiele Bekendmakingen" system (run by
// KOOP/overheid.nl) publishes every Dutch municipality's permit decisions,
// felling permits included, as CC0-licensed public records.
//
// Dataset page: https://data.overheid.nl/dataset/officiele-bekendmakingen
//
// IMPORTANT (Sept 2026): this file originally queried the documented SRU
// endpoint (zoek.officielebekendmakingen.nl/sru/Search, x-connection=oep,
// version=1.2). That endpoint is broken - confirmed by testing the exact
// same query from a sandboxed environment, a Cloudflare Worker running on
// a real Mac (this app's own `wrangler dev`), and a fully logged-in real
// Chrome browser on a home network: all three get a plain
// "500: Er is iets mis gegaan" from the endpoint itself, even for the
// simplest possible query (`creator=Delft`, nothing else). This isn't a
// bot-detection/fingerprinting thing - it's the endpoint itself being down
// or deprecated - so there was no header or client-side fix available.
//
// The fix: the modern search UI at zoek.officielebekendmakingen.nl doesn't
// use that SRU endpoint at all - it hits a different backend with a CQL-ish
// query language (found by watching the real search page's own network
// requests), and that one works fine, including from plain server-side
// fetch() with no special headers. Better still, every search on that site
// has an "RSS van deze zoekvraag" link exposing the exact same result set
// as clean RSS 2.0 XML - RSS being meant for automated/machine consumption
// to begin with, unlike the old SRU endpoint apparently was.
//
// Confirmed live (Sept 2026) via a real browser AND plain curl (no special
// headers, no cookies):
//   https://zoek.officielebekendmakingen.nl/rss?q=<query>
// where <query> is:
//   (c.product-area=="officielepublicaties")
//   and(((w.publicatienaam=="Tractatenblad"))or((w.publicatienaam=="Staatsblad"))
//       or((w.publicatienaam=="Staatscourant"))or((w.publicatienaam=="Gemeenteblad"))
//       or((w.publicatienaam=="Provinciaal blad"))or((w.publicatienaam=="Waterschapsblad"))
//       or((w.publicatienaam=="Blad gemeenschappelijke regeling")))
//   and(cql.textAndIndexes="Delft" and cql.textAndIndexes="<keyword>")
// (the publicatienaam OR-block is just the default "official publications"
// scope the search UI itself applies - copied verbatim rather than
// re-derived, since it's known to work).
//
// This searches full document text for "Delft" + the keyword together,
// which is broader than the old creator=Delft field match - it can also
// match documents from OTHER municipalities that happen to mention Delft
// (e.g. a Castricum bulletin mentioning Delft in passing), so results are
// filtered afterwards to organization === "Delft", read off each item's
// own <title> field (format "gmb-2026-123456 : Delft").
//
// The RSS feed for one query returns the FULL result set in one response
// (confirmed: a query matching 130 results returned all 130 <item> blocks,
// not just a paginated page of 10), so no pagination handling is needed
// for the volumes one municipality's felling permits produce. There's no
// confirmed date-filter query syntax for this endpoint, so instead of
// guessing at one, results are filtered to the requested date window
// client-side using each item's <pubDate>.
//
// Titles are free text, not structured data - address, tree count, species
// and status below are all best-effort extraction from that string (now
// each item's <description>, not <title> - the RSS <title> is just the
// "id : organization" identifier), not guaranteed fields. Workers don't
// have DOMParser, so parsing below is a small hand-rolled regex extractor
// scoped to RSS's flat, non-nested <item> structure.
//
// Geocoding (title address text -> lat/lon) goes through PDOK's free
// Locatieserver (api.pdok.nl, no key required) - unaffected by any of the
// above, and confirmed live independently: it resolves both full addresses
// ("Hoogenhouckstraat 28 2614BX Delft") and bare street names ("Sint
// Jorisweg Delft", falling back to the street's own centroid point).

const RSS_ENDPOINT = 'https://zoek.officielebekendmakingen.nl/rss'
const PDOK_FREE_ENDPOINT = 'https://api.pdok.nl/bzk/locatieserver/search/v3_1/free'

// 'rooien' (uproot/remove) is a common synonym for felling that Delft's
// own notices use interchangeably with 'kappen' - added explicitly
// (2026-09-07) rather than relying on it only showing up incidentally
// alongside one of the other keywords elsewhere in a document's text.
export const FELLING_KEYWORDS = ['kappen', 'vellen', 'houtopstand', 'kapvergunning', 'rooien']

// This full-text search (see the file header) matches ANY Delft
// publication whose body mentions one of the keywords above, which is
// broader than felling-specific notices - it also catches, correctly,
// a felling mention buried inside an otherwise-unrelated permit (a home
// extension, an electrical substation, a road project). But it also
// catches generic municipal policy/regulation documents that reference
// tree-felling rules in passing without being about any specific tree
// or address at all - confirmed 2026-09-07 against the first live sync
// (6 of 119 stored rows: a subsidy scheme, a hearing-procedure
// decision, an enforcement strategy, the tree ordinance itself, a fees
// ordinance, a replacement-scheduling handbook - all with no address,
// no tree count, nothing for the map). These are filtered out by title
// shape below rather than by "has an address", since roughly a third
// of genuine felling permits also have no cleanly-extractable address
// (extractAddress below is best-effort and often comes up empty even
// for a real permit whose title plainly states one) - filtering on
// that would silently drop real permits, not just junk.
const NON_PERMIT_DOCUMENT_PATTERN =
  /^(Verordening|Subsidieregeling|Handhavingsstrategie|Aanwijzingsbesluit|Handboek|Beleidsregel|Nota |Regeling van|Technische publicatie|Besluit van (Gedeputeerde|Provinciale) Staten)/i

// The search UI's own default scope filter (restricts to actual official
// publications, excluding e.g. parliamentary documents) - copied verbatim
// from a real search rather than re-derived.
const PUBLICATION_SCOPE =
  '(c.product-area=="officielepublicaties")and(((w.publicatienaam=="Tractatenblad"))' +
  'or((w.publicatienaam=="Staatsblad"))or((w.publicatienaam=="Staatscourant"))' +
  'or((w.publicatienaam=="Gemeenteblad"))or((w.publicatienaam=="Provinciaal blad"))' +
  'or((w.publicatienaam=="Waterschapsblad"))or((w.publicatienaam=="Blad gemeenschappelijke regeling")))'

export interface FellingAnnouncement {
  publicationId: string
  title: string
  titleEn: string | null
  publishedAt: string
  sourceUrl: string
  status: 'aangevraagd' | 'verleend' | 'definitief' | 'geweigerd'
  address: string | null
  treeCount: number | null
  speciesHint: string | null
  reasonHint: string | null
  lat: number | null
  lon: number | null
}

export async function fetchDelftFellingAnnouncements(
  sinceDateYYYYMMDD: string,
  ai?: Ai
): Promise<FellingAnnouncement[]> {
  const byId = new Map<string, FellingAnnouncement>()
  const since = new Date(`${sinceDateYYYYMMDD}T00:00:00Z`)

  for (const keyword of FELLING_KEYWORDS) {
    const cql = `${PUBLICATION_SCOPE}and(cql.textAndIndexes="Delft" and cql.textAndIndexes="${keyword}")`
    const url = new URL(RSS_ENDPOINT)
    url.searchParams.set('q', cql)

    try {
      const res = await fetch(url.toString())
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const xml = await res.text()
      for (const record of parseRssResponse(xml, since)) {
        if (!byId.has(record.publicationId)) byId.set(record.publicationId, record)
      }
    } catch (err) {
      // One bad keyword shouldn't sink the whole sync - log and carry on
      // with whatever the other keywords turn up.
      console.error(`bekendmakingen RSS query for "${keyword}" failed:`, err)
    }

    // Be polite - no confirmed rate limit on this endpoint yet, but the
    // old SRU one was aggressive about it, so keep the same pacing.
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

  // Best-effort English translation of the free-text Dutch title, shown
  // alongside the original on the map popup rather than replacing it - a
  // miss (translator down, rate-limited, etc.) just leaves titleEn null
  // and the popup falls back to Dutch-only.
  for (const a of announcements) {
    a.titleEn = await translateToEnglish(a.title, ai)
    await sleep(200)
  }

  return announcements
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
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

export function extractAddress(title: string): string | null {
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

// "6 bomen" / "een boom" -> 6 / 1. No count in the title just leaves this
// null rather than guessing.
//
// Tree-noun forms the count can attach to. Dutch pluralises irregularly
// here (boom -> bomen, not "boomen"; els -> elzen, not "elsen"), so each
// form is spelled out explicitly rather than derived from a shared stem -
// sorted longest-first so the alternation doesn't short-circuit on a shorter
// prefix. "houtopstand(en)" and "conifeer/coniferen" are included because
// they're used interchangeably with "boom(en)" in real notice titles (and
// "houtopstand" is already one of this file's own FELLING_KEYWORDS).
const TREE_NOUN_FORMS = [
  'bomen', 'boom', 'iepen', 'iep', 'eiken', 'eik', 'beuken', 'beuk',
  'essen', 'es', 'linden', 'linde', 'kastanjes', 'kastanje',
  'populieren', 'populier', 'wilgen', 'wilg', 'treurwilgen', 'treurwilg',
  'elzen', 'els', 'esdoorns', 'esdoorn', 'berken', 'berk', 'kersen', 'kers',
  'paardekastanjes', 'paardekastanje', 'houtopstanden', 'houtopstand',
  'coniferen', 'conifeer',
].sort((a, b) => b.length - a.length)

// Matches "<count> <noun>" allowing up to 2 descriptive words in between
// (e.g. "een zieke sierkers boom", "twee Canadese populieren") - a plain
// "<count> bomen/boom" (the original, narrower pattern) still matches too
// since 0 intervening words is allowed.
const TREE_COUNT_PATTERN = new RegExp(
  `\\b(\\d{1,3}|een|twee|drie|vier|vijf|zes|zeven|acht|negen|tien)\\b` +
    `\\s+(?:\\w+\\s+){0,2}(?:${TREE_NOUN_FORMS.join('|')})\\b`,
  'i'
)

export function extractTreeCount(title: string): number | null {
  const m = title.match(TREE_COUNT_PATTERN)
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

export function extractSpeciesHint(title: string): string | null {
  for (const [re, label] of SPECIES_HINTS) {
    if (re.test(title)) return label
  }
  return null
}

// A rough "why is this being felled" hint, same best-effort spirit as
// species above - pulled from common Dutch phrasing in the free-text
// title. Deliberately returns an English label directly (unlike
// speciesHint, which keeps the Dutch tree-name word) since this is a
// short tag for the popup, not a translation of anything specific.
const REASON_HINTS: Array<[RegExp, string]> = [
  [/\bziek(e)?\b|\bafgestorven\b|\bafsterven\b|\bdode?\b/i, 'diseased / dead tree'],
  [/\bstorm(schade)?\b|\bwindschade\b/i, 'storm damage'],
  [/\bgevaar(zetting)?\b|\bveiligheid\b|\bonveilig\b|\brisico\b/i, 'safety hazard'],
  [/\bachterstallig onderhoud\b/i, 'deferred maintenance'],
  [/\bwortelschade\b|\bwortelopdruk\b|\bwortels\b/i, 'root damage'],
  [/\bnieuwbouw\b|\bontwikkeling\b|\brenovatie\b|\bverbouwing\b|\bbouwproject\b/i, 'construction / development'],
  [/\bkabels\b|\bleidingen\b|\bgassanering\b|\brioolvervanging\b|\brioolwerkzaamheden\b/i, 'utility works'],
  [/\bfietspad\b|\bHOV-baan\b|\bspoorse\b|\binfrastructuur\b/i, 'infrastructure works'],
  [/\bherplant(en)?\b|\bvervangen\b/i, 'replacement planting'],
  [/\boverlast\b/i, 'nuisance (overlast)'],
]

export function extractReasonHint(title: string): string | null {
  for (const [re, label] of REASON_HINTS) {
    if (re.test(title)) return label
  }
  return null
}

// Parses one RSS 2.0 response from the search feed into announcements.
// Each <item> looks like:
//   <item>
//     <link>https://zoek.officielebekendmakingen.nl/gmb-2026-339555.html</link>
//     <category>Gemeenteblad</category>
//     <title>gmb-2026-339555 : Delft</title>
//     <description>Aanvraag vergunning voor het kappen van 10 bomen...</description>
//     <pubDate>Wed, 15 Jul 2026 00:00:00 +0200</pubDate>
//   </item>
// <title> here is just "<publication id> : <organization>", not the
// permit's actual free-text title - that's in <description>. Filtered to
// organization === "Delft" (full-text search can match other
// municipalities' publications that merely mention Delft) and to
// pubDate >= since (this endpoint has no confirmed date-filter query
// syntax, so the date window is applied here instead of server-side).
function parseRssResponse(xml: string, since: Date): FellingAnnouncement[] {
  const announcements: FellingAnnouncement[] = []
  const itemBlocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? []

  for (const block of itemBlocks) {
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/)
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/)
    const descMatch = block.match(/<description>([\s\S]*?)<\/description>/)
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)
    if (!linkMatch || !titleMatch || !descMatch || !pubDateMatch) continue

    const sourceUrl = decodeXmlEntities(linkMatch[1]).trim()
    const rawTitle = decodeXmlEntities(titleMatch[1]).trim()
    const description = decodeXmlEntities(descMatch[1]).trim()
    const pubDateRaw = decodeXmlEntities(pubDateMatch[1]).trim()

    const [idPart, orgPart] = rawTitle.split(':').map((s) => s.trim())
    if (!idPart || orgPart !== 'Delft') continue
    if (NON_PERMIT_DOCUMENT_PATTERN.test(description)) continue

    const publishedAt = new Date(pubDateRaw)
    if (Number.isNaN(publishedAt.getTime()) || publishedAt < since) continue

    announcements.push({
      publicationId: idPart,
      title: description,
      titleEn: null,
      publishedAt: publishedAt.toISOString(),
      sourceUrl,
      status: deriveStatus(description),
      address: extractAddress(description),
      treeCount: extractTreeCount(description),
      speciesHint: extractSpeciesHint(description),
      reasonHint: extractReasonHint(description),
      lat: null,
      lon: null,
    })
  }

  return announcements
}

// Dutch->English translation for permit titles, shown alongside the Dutch
// original on the map popup (never replacing it - the Dutch is the actual
// legal text). Workers AI first, MyMemory as a fallback:
//
// MyMemory (api.mymemory.translated.net) was the original, keyless choice
// here and it's still a fine fallback, but as the *primary* path it turned
// out to be broken in production specifically: confirmed 2026-09-08 that
// all 119 already-synced permits had title_en = null on the live site,
// despite this exact code working fine testing locally via `wrangler dev`.
// MyMemory's free anonymous tier is rate-limited per IP, and every
// Cloudflare Worker on the platform shares the same pool of egress IPs -
// so unlike a request from one person's own laptop, this Worker's
// requests were very likely arriving already past quota, every time,
// silently downgraded to a "MYMEMORY WARNING" response that the code
// below correctly treats as a miss (hence null, not an error). Workers AI
// runs inside Cloudflare's own infrastructure instead of going out over
// the open internet, so it isn't subject to that shared-IP quota at all.
export async function translateToEnglish(text: string, ai?: Ai): Promise<string | null> {
  if (ai) {
    try {
      const result = await ai.run('@cf/meta/m2m100-1.2b', {
        text,
        source_lang: 'nl',
        target_lang: 'en',
      })
      const translated = (result as { translated_text?: string })?.translated_text?.trim()
      if (translated && translated.toLowerCase() !== text.trim().toLowerCase()) {
        return translated
      }
    } catch (err) {
      console.error('Workers AI translation failed, falling back to MyMemory:', err instanceof Error ? err.message : String(err))
    }
  }

  const url = new URL('https://api.mymemory.translated.net/get')
  url.searchParams.set('q', text)
  url.searchParams.set('langpair', 'nl|en')

  try {
    const res = await fetch(url.toString())
    if (!res.ok) return null
    const data = await res.json<{ responseData?: { translatedText?: string } }>()
    const translated = data.responseData?.translatedText
    if (!translated) return null
    // MyMemory echoes the input back untranslated (or an "INVALID..."
    // notice) rather than erroring when it can't help - treat those as a
    // miss too rather than storing garbage as if it were English.
    if (translated.trim().toLowerCase() === text.trim().toLowerCase()) return null
    if (/^(MYMEMORY WARNING|INVALID)/i.test(translated)) return null
    return decodeXmlEntities(translated).trim()
  } catch {
    return null
  }
}

interface PdokFreeResponse {
  response?: {
    docs?: Array<{ centroide_ll?: string }>
  }
}

export async function geocodeAddress(address: string): Promise<{ lat: number; lon: number } | null> {
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
