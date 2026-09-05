// Tier 2 ingestion: the national "Officiele Bekendmakingen" system (run by
// KOOP/overheid.nl) publishes every Dutch municipality's permit decisions,
// felling permits included, as CC0-licensed public records, searchable
// through a public SRU 2.0 API.
//
// Dataset page: https://data.overheid.nl/dataset/officiele-bekendmakingen
// Endpoint:     https://zoek.officielebekendmakingen.nl/sru/Search
// Protocol:     SRU 2.0, query language CQL
//
// IMPORTANT: the exact CQL field names below (dt.creator, dt.date,
// cql.textAndIndexes) are best-effort from public documentation, not
// verified against a live response yet (a direct fetch got blocked in this
// environment while researching). Before relying on this: pull the KOOP
// SRU user-guide PDF (search "Basiswettenbestand Gebruikersdocumentatie
// SRU" on puc.overheid.nl) and confirm field names + response shape
// against a real query, then fill in parseSruResponse below.

const SRU_ENDPOINT = 'https://zoek.officielebekendmakingen.nl/sru/Search'

const FELLING_KEYWORDS = ['kappen', 'vellen', 'houtopstand', 'kapvergunning']

export interface FellingAnnouncement {
  publicationId: string
  title: string
  publishedAt: string
  sourceUrl: string
}

export async function fetchDelftFellingAnnouncements(
  sinceDateYYYYMMDD: string
): Promise<FellingAnnouncement[]> {
  const keywordClause = FELLING_KEYWORDS.map((k) => `cql.textAndIndexes="${k}"`).join(' OR ')
  const cql = [`dt.creator="gemeente Delft"`, `(${keywordClause})`, `dt.date>=${sinceDateYYYYMMDD}`].join(
    ' AND '
  )

  const url = new URL(SRU_ENDPOINT)
  url.searchParams.set('version', '2.0')
  url.searchParams.set('operation', 'searchRetrieve')
  url.searchParams.set('query', cql)
  url.searchParams.set('maximumRecords', '100')

  const res = await fetch(url.toString(), { headers: { Accept: 'application/xml' } })
  if (!res.ok) {
    throw new Error(`SRU query failed: ${res.status} ${res.statusText}`)
  }
  const xml = await res.text()
  return parseSruResponse(xml)
}

function parseSruResponse(_xml: string): FellingAnnouncement[] {
  // TODO: parse the SRU/Dublin-Core XML into records. Workers don't have
  // DOMParser, so use a small XML parser package (e.g. fast-xml-parser)
  // once dependencies can be installed. Each <recordData> entry should map
  // roughly to { publicationId (e.g. gmb-2026-123456), title, publishedAt,
  // sourceUrl (the zoek.officielebekendmakingen.nl/<id>.html page) }.
  return []
}
