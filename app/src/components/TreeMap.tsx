import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const DELFT_CENTER: [number, number] = [4.3571, 52.0116]

interface Tree {
  id: string
  lat: number
  lon: number
  species_nl?: string | null
  planted_year?: number | null
  height_class?: string | null
  diameter_cm?: number | null
  neighborhood?: string | null
  site_type?: string | null
  management_group?: string | null
  notes?: string | null
  is_monumental?: number
}
type Permit = {
  id: string
  lat: number | null
  lon: number | null
  title: string
  title_en?: string | null
  status: string
  address?: string | null
  tree_count?: number | null
  species?: string | null
  reason?: string | null
  published_at?: string | null
  source_url?: string | null
}
type Report = {
  id: string
  lat: number
  lon: number
  status: 'marked_for_felling' | 'felled' | 'new_tree_planted'
  quantity?: string
  species_known?: number
  species_name?: string
  request_community_id?: number
  trunk_measure_type?: string
  trunk_measure_cm?: number | null
  felling_reason?: string
  felling_reason_other?: string
  felling_date?: string
  felling_period?: string
  looking_for_arborist?: number
  felled_date?: string
  felled_period?: string
  notes?: string
  photo_url: string
  created_at?: string
}

// What the sidebar needs to render its always-visible community report
// feed - a trimmed view of Report, kept as its own type (rather than
// exporting/importing Report) to match how this file's other shared shapes
// (Layers) are already just redeclared per-file rather than shared.
type ReportSummary = {
  id: string
  photo_url: string
  status: 'marked_for_felling' | 'felled' | 'new_tree_planted'
  species_name?: string
  created_at?: string
}

type Layers = { trees: boolean; permits: boolean; reports: boolean }

const STATUS_LABEL: Record<Report['status'], string> = {
  marked_for_felling: 'Marked for felling',
  felled: 'Already felled',
  new_tree_planted: 'New tree planted',
}

const PERMIT_STATUS_LABEL: Record<string, string> = {
  aangevraagd: 'Application submitted',
  verleend: 'Permit granted',
  definitief: 'Final decision',
  geweigerd: 'Application refused',
}

// Small colored-dot markers (rather than MapLibre's default big teardrop
// pin) - closer to urbanwood.club's map style, and much lighter-weight
// for the handful of permit/report pins on screen at once.
function dotElement(color: string): HTMLDivElement {
  const el = document.createElement('div')
  el.style.width = '13px'
  el.style.height = '13px'
  el.style.borderRadius = '50%'
  el.style.background = color
  el.style.border = '2px solid #fbfaf5'
  el.style.boxShadow = '0 1px 3px rgba(23,19,15,0.45)'
  return el
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

// --- Species lookup (Wikidata) ------------------------------------------
//
// openbomenkaart.org ships its own hand-curated 469KB taxon-name file to
// get English/Dutch common names + Wikipedia links per species. That file
// is the site author's own substantial curated dataset, so rather than
// copy it, this looks the same information up live from Wikidata, which
// carries sitelinks to each language's Wikipedia for most tree species,
// plus (for many) a "taxon common name" (P1843) statement per language -
// the property Wikidata actually uses for vernacular names. (An earlier
// version of this read the item's plain label instead, but Wikidata's own
// convention keeps a taxon's label as the scientific name in every
// language, so that almost always came back empty - P1843 is the fix.)
// Falls back to the Wikipedia article's own title when P1843 has nothing
// but the title itself differs from the scientific name.

interface SpeciesInfo {
  en: string | null
  nl: string | null
  enUrl: string | null
  nlUrl: string | null
}

const speciesInfoCache = new Map<string, Promise<SpeciesInfo | null>>()

// Delft's own species field carries a cultivar suffix sometimes, e.g.
// `Tilia platyphyllos 'Delft'` - Wikidata indexes the species itself, not
// the cultivar, so strip anything from the first quote mark onward.
function stripCultivar(name: string): string {
  return name.split(/['"‘’“”]/)[0].trim()
}

function wikipediaUrlFor(lang: 'en' | 'nl', title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`
}

async function lookupSpeciesInfo(rawName: string): Promise<SpeciesInfo | null> {
  const name = stripCultivar(rawName)
  if (!name) return null

  const cached = speciesInfoCache.get(name)
  if (cached) return cached

  const promise = (async (): Promise<SpeciesInfo | null> => {
    try {
      // Step 1: find the Wikidata item for this scientific name.
      const searchUrl =
        `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}` +
        `&language=en&type=item&limit=1&format=json&origin=*`
      const searchRes = await fetch(searchUrl)
      if (!searchRes.ok) return null
      const searchData = (await searchRes.json()) as any
      const id: string | undefined = searchData?.search?.[0]?.id
      if (!id) return null

      // Step 2: pull the taxon common name (P1843) + Wikipedia sitelinks.
      const entityUrl =
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${id}` +
        `&props=claims|sitelinks&sitefilter=enwiki|nlwiki&format=json&origin=*`
      const entityRes = await fetch(entityUrl)
      if (!entityRes.ok) return null
      const entityData = (await entityRes.json()) as any
      const entity = entityData?.entities?.[id]
      if (!entity) return null

      const enTitle: string | null = entity.sitelinks?.enwiki?.title ?? null
      const nlTitle: string | null = entity.sitelinks?.nlwiki?.title ?? null

      // P1843 ("taxon common name") holds one monolingual-text value per
      // vernacular name Wikidata has on record - often several per
      // language (regional variants, alternate spellings). Verified live
      // against several real Delft species: a species can have half a
      // dozen Dutch or English entries, so picking just the first one is
      // a coin flip (e.g. Tilia platyphyllos's first 'nl' entry is
      // "Grootbladige linde", a literal translation, while its Wikipedia
      // article is titled "Zomerlinde" - the name actually in use).
      const commonNameClaims: any[] = entity.claims?.P1843 ?? []
      const commonNamesFor = (lang: 'en' | 'nl'): string[] =>
        commonNameClaims
          .map((claim) => claim?.mainsnak?.datavalue?.value)
          .filter((value) => value && typeof value.text === 'string' && String(value.language).split('-')[0] === lang)
          .map((value) => value.text as string)

      // Prefer whichever P1843 value matches that language's Wikipedia
      // article title (the strongest signal of "the" common name in
      // use); otherwise fall back to the first value Wikidata has.
      const pickCommonName = (lang: 'en' | 'nl', wikiTitle: string | null): string | null => {
        const candidates = commonNamesFor(lang)
        if (!candidates.length) return null
        const matchingTitle = wikiTitle && candidates.find((c) => c.toLowerCase() === wikiTitle.toLowerCase())
        return matchingTitle || candidates[0]
      }

      // If Wikidata has no P1843 common name in a language at all, but
      // that language's Wikipedia article is titled something other than
      // the plain scientific name, show that title instead of nothing.
      const titleIfDistinct = (title: string | null) =>
        title && title.toLowerCase() !== name.toLowerCase() ? title : null

      return {
        en: pickCommonName('en', enTitle) ?? titleIfDistinct(enTitle),
        nl: pickCommonName('nl', nlTitle) ?? titleIfDistinct(nlTitle),
        enUrl: enTitle ? wikipediaUrlFor('en', enTitle) : null,
        nlUrl: nlTitle ? wikipediaUrlFor('nl', nlTitle) : null,
      }
    } catch {
      return null
    }
  })()

  speciesInfoCache.set(name, promise)
  return promise
}

// The popup shows a fixed field list (species header, English/Dutch common
// name, planted year, height, diameter, neighborhood, coordinates,
// Wikipedia links) - deliberately not every column the API returns, to
// match the compact spec-sheet layout openbomenkaart.org uses.
function treePopupHtml(t: Tree, info?: SpeciesInfo | null, loadingInfo?: boolean): string {
  const row = (label: string, value: string | number | null | undefined) =>
    `<div class="tree-popup-row"><span>${label}</span><strong>${value != null && value !== '' ? escapeHtml(String(value)) : '—'}</strong></div>`
  const rawRow = (label: string, html: string) => `<div class="tree-popup-row"><span>${label}</span><strong>${html}</strong></div>`

  const englishValue = loadingInfo ? '…' : (info?.en ?? null)
  const dutchValue = loadingInfo ? '…' : (info?.nl ?? null)

  const wikiHtml = loadingInfo
    ? 'Looking up&hellip;'
    : info && (info.enUrl || info.nlUrl)
      ? [
          info.enUrl ? `<a href="${info.enUrl}" target="_blank" rel="noopener noreferrer">Wikipedia (EN)</a>` : '',
          info.nlUrl ? `<a href="${info.nlUrl}" target="_blank" rel="noopener noreferrer">Wikipedia (NL)</a>` : '',
        ]
          .filter(Boolean)
          .join(' &middot; ')
      : '—'

  const coordinates = `${t.lat.toFixed(5)}, ${t.lon.toFixed(5)}`

  return `
    <div class="tree-popup tree-popup-wide">
      <h3>${t.species_nl ? escapeHtml(t.species_nl) : 'Unspecified species'}</h3>
      ${row('English name', englishValue)}
      ${row('Dutch name', dutchValue)}
      ${row('Planted', t.planted_year)}
      ${row('Height', t.height_class)}
      ${row('Diameter', t.diameter_cm != null ? `${t.diameter_cm} cm` : null)}
      ${row('Neighborhood', t.neighborhood)}
      ${row('Coordinates', coordinates)}
      ${rawRow('More info on species', wikiHtml)}
      <div class="tree-popup-report">
        <p>See something different in person - marked for felling, already felled, or a new tree planted here? Add a community report and it'll show up on the map as a red marker.</p>
        <button type="button" class="tree-popup-report-btn">Report this tree</button>
      </div>
    </div>
  `
}

// Bekendmakingen titles are full sentences, not structured data - address,
// tree count and species below are all best-effort extraction done at
// ingest time (see api/src/ingest/bekendmakingen.ts), not guaranteed
// fields, so each falls back to an em dash when missing.
// The title translation (title_en) is best-effort machine translation
// done at ingest time (see api/src/ingest/bekendmakingen.ts) - shown as
// the heading when available, with the original Dutch text always kept
// directly below it in its own line rather than replaced, since the
// translation can be rough and the Dutch is the actual legal text.
function permitPopupHtml(p: Permit): string {
  const row = (label: string, value: string | number | null | undefined) =>
    `<div class="tree-popup-row"><span>${label}</span><strong>${value != null && value !== '' ? escapeHtml(String(value)) : '—'}</strong></div>`
  const rawRow = (label: string, html: string) => `<div class="tree-popup-row"><span>${label}</span><strong>${html}</strong></div>`

  const statusLabel = PERMIT_STATUS_LABEL[p.status] ?? p.status
  const sourceHtml = p.source_url
    ? `<a href="${p.source_url}" target="_blank" rel="noopener noreferrer">Officiële bekendmakingen</a>`
    : '—'

  const heading = p.title_en
    ? `<h3>${escapeHtml(p.title_en)}</h3>
       <div class="tree-popup-original">${escapeHtml(p.title)}</div>`
    : `<h3>${escapeHtml(p.title)}</h3>`

  return `
    <div class="tree-popup tree-popup-wide">
      ${heading}
      ${row('Status', statusLabel)}
      ${row('Address', p.address)}
      ${row('Trees', p.tree_count)}
      ${row('Species (reported)', p.species)}
      ${row('Reason', p.reason)}
      ${row('Published', p.published_at ? p.published_at.slice(0, 10) : null)}
      ${rawRow('Source', sourceHtml)}
    </div>
  `
}

const QUANTITY_LABEL: Record<string, string> = {
  single: 'Single tree',
  few: 'A few (2-5)',
  several: 'Several (6-20)',
  street_row: 'Street row / many',
}

const FELLING_REASON_LABEL: Record<string, string> = {
  diseased: 'Diseased / dying',
  storm_damaged: 'Storm damaged',
  infrastructure: 'Infrastructure threat',
  building_development: 'Building development',
  light_improvement: 'Light improvement',
}

// Same fixed-heading, "-" ("—") for anything unfilled spec-sheet style as
// treePopupHtml/permitPopupHtml above, so all three marker types (tree,
// permit, community report) read as one consistent system - every row
// always appears, whether or not that particular report has that field.
function reportPopupHtml(r: Report): string {
  const row = (label: string, value: string | number | null | undefined) =>
    `<div class="tree-popup-row"><span>${label}</span><strong>${value != null && value !== '' ? escapeHtml(String(value)) : '—'}</strong></div>`

  const reasonValue =
    r.felling_reason === 'other' ? r.felling_reason_other : r.felling_reason ? FELLING_REASON_LABEL[r.felling_reason] : null
  const expectedValue = r.felling_date || r.felling_period || null
  const felledValue = r.felled_date || r.felled_period || null
  const trunkValue = r.trunk_measure_cm ? `${r.trunk_measure_cm} cm (${r.trunk_measure_type ?? '?'})` : null
  const speciesValue = r.species_known ? r.species_name : null

  return `
    <div class="tree-popup tree-popup-wide">
      <img class="tree-popup-photo" src="${r.photo_url}" alt="Submitted photo" />
      <h3>${STATUS_LABEL[r.status]}</h3>
      ${row('Quantity', r.quantity ? QUANTITY_LABEL[r.quantity] ?? r.quantity : null)}
      ${row('Species', speciesValue)}
      ${row('Trunk', trunkValue)}
      ${row('Reason', reasonValue)}
      ${row('Expected', expectedValue)}
      ${row('Felled', felledValue)}
      ${row('Looking for arborist', r.looking_for_arborist ? 'Yes' : null)}
      ${row('Wants community ID', r.request_community_id ? 'Yes' : null)}
      ${row('Notes', r.notes)}
      ${row('Location', `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}`)}
      ${row('Submitted', r.created_at ? r.created_at.slice(0, 10) : null)}
    </div>
  `
}

export default function TreeMap({
  layers,
  pickMode,
  onPick,
  refreshKey,
  onCounts,
  onReportTree,
  onReportsChange,
}: {
  layers: Layers
  pickMode: boolean
  onPick: (lat: number, lon: number) => void
  refreshKey: number
  onCounts?: (counts: {
    trees: number
    permits: number
    reports: number
    permitTreeTotal: number
  }) => void
  onReportTree?: (lat: number, lon: number) => void
  onReportsChange?: (reports: ReportSummary[]) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  // Only one popup (tree, permit, or community report) open at a time -
  // every popup below is wired through registerPopup() before it's ever
  // shown, so whichever one opens next closes whatever was open before it.
  const activePopupRef = useRef<maplibregl.Popup | null>(null)
  function registerPopup(popup: maplibregl.Popup) {
    popup.on('open', () => {
      if (activePopupRef.current && activePopupRef.current !== popup) {
        activePopupRef.current.remove()
      }
      activePopupRef.current = popup
    })
    return popup
  }
  const [mapLoaded, setMapLoaded] = useState(false)
  const [trees, setTrees] = useState<Tree[]>([])
  const [permits, setPermits] = useState<Permit[]>([])
  const [reports, setReports] = useState<Report[]>([])

  // map init (once)
  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json', // free, keyless CARTO basemap
      center: DELFT_CENTER,
      zoom: 13,
    })
    mapRef.current = map
    // Zoom in/out buttons, per your request - compass/rotate control left
    // off since this map never rotates.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), 'top-right')
    map.on('load', () => setMapLoaded(true))
    return () => map.remove()
  }, [])

  // click-to-pick a location for a new report
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!pickMode) return
    const handler = (e: maplibregl.MapMouseEvent) => onPick(e.lngLat.lat, e.lngLat.lng)
    map.getCanvas().style.cursor = 'crosshair'
    map.on('click', handler)
    return () => {
      map.off('click', handler)
      map.getCanvas().style.cursor = ''
    }
  }, [pickMode, onPick])

  // data fetch, re-run after a new report is submitted (refreshKey bump)
  useEffect(() => {
    fetch('/api/trees').then((r) => r.json()).then(setTrees).catch(() => setTrees([]))
    fetch('/api/permits').then((r) => r.json()).then(setPermits).catch(() => setPermits([]))
    fetch('/api/reports').then((r) => r.json()).then(setReports).catch(() => setReports([]))
  }, [refreshKey])

  // surface item counts to the parent, so the sidebar can show a count
  // beside each layer's toggle. permitTreeTotal sums each permit's own
  // tree_count (how many trees that felling notice covers) - a different,
  // usually larger number than permits.length (how many permit markers are
  // plotted), since one permit can cover several trees. Permits with an
  // unknown tree_count (null/undefined - the count couldn't be parsed from
  // the notice title) are skipped rather than counted as 0.
  useEffect(() => {
    const permitTreeTotal = permits.reduce(
      (sum, p) => (typeof p.tree_count === 'number' ? sum + p.tree_count : sum),
      0
    )
    onCounts?.({ trees: trees.length, permits: permits.length, reports: reports.length, permitTreeTotal })
  }, [trees, permits, reports, onCounts])

  // the sidebar keeps its own always-visible feed of community reports
  // (independent of whether the map's "Community reports" layer toggle is
  // on) - reports is already the approved list from /api/reports, in the
  // same most-recent-first order the API returns
  useEffect(() => {
    onReportsChange?.(
      reports.map((r) => ({
        id: r.id,
        photo_url: r.photo_url,
        status: r.status,
        species_name: r.species_name,
        created_at: r.created_at,
      }))
    )
  }, [reports, onReportsChange])

  // Trees: a single GPU-rendered circle layer, not one DOM marker per tree -
  // the only approach that stays smooth at tens of thousands of points.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded) return

    // Built as a plain object rather than typed against the `geojson`
    // package's ambient types, since that's not a declared dependency here
    // (maplibre-gl's own .d.ts pulls it in transitively, which isn't
    // reliable to depend on from our code without a real install to check).
    const geojson = {
      type: 'FeatureCollection',
      features: trees.map((t) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
        properties: t,
      })),
    }

    const source = map.getSource('trees') as maplibregl.GeoJSONSource | undefined
    if (source) {
      source.setData(geojson as any)
      return
    }

    map.addSource('trees', { type: 'geojson', data: geojson as any })
    map.addLayer({
      id: 'trees-circle',
      type: 'circle',
      source: 'trees',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3, 18, 6],
        'circle-color': '#3f6b46', // keep in sync with --green in styles.css
        'circle-stroke-width': 1,
        'circle-stroke-color': '#fbfaf5',
        'circle-opacity': 0.9,
      },
    })
    map.on('mouseenter', 'trees-circle', () => (map.getCanvas().style.cursor = 'pointer'))
    map.on('mouseleave', 'trees-circle', () => (map.getCanvas().style.cursor = ''))
    map.on('click', 'trees-circle', (e) => {
      const feature = e.features?.[0]
      if (!feature || feature.geometry.type !== 'Point') return
      const tree = feature.properties as Tree

      // setHTML() replaces the popup's innerHTML wholesale, which drops any
      // listener bound to a previous render - so the "Report this tree"
      // button has to be rewired after every setHTML() call, not just once.
      const wireReportButton = () => {
        popup
          .getElement()
          ?.querySelector('.tree-popup-report-btn')
          ?.addEventListener('click', () => onReportTree?.(tree.lat, tree.lon))
      }

      // Default maplibre popups cap out at 240px wide - too narrow for the
      // now-doubled .tree-popup-wide layout, so this one gets an explicit
      // wider cap.
      const popup = registerPopup(new maplibregl.Popup({ maxWidth: '480px' }))
        .setLngLat(feature.geometry.coordinates as [number, number])
        .setHTML(treePopupHtml(tree, null, !!tree.species_nl))
        .addTo(map)
      wireReportButton()

      // Show what we already have instantly, then fill in the English/Dutch
      // common names + Wikipedia links once the Wikidata lookup resolves -
      // no reason to make the click wait on a network round-trip.
      if (tree.species_nl) {
        lookupSpeciesInfo(tree.species_nl).then((info) => {
          if (!popup.isOpen()) return
          popup.setHTML(treePopupHtml(tree, info, false))
          wireReportButton()
        })
      }
    })
  }, [trees, mapLoaded])

  // toggle tree layer visibility
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapLoaded || !map.getLayer('trees-circle')) return
    map.setLayoutProperty('trees-circle', 'visibility', layers.trees ? 'visible' : 'none')
  }, [layers.trees, mapLoaded])

  // Permits + reports: low counts, small custom-dot DOM markers are fine.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    if (layers.permits) {
      permits.forEach((p) => {
        if (p.lat == null || p.lon == null) return // not geocoded yet - still in the moderation queue
        const marker = new maplibregl.Marker({ element: dotElement('#e2b93d') }) // keep in sync with --yellow
          .setLngLat([p.lon, p.lat])
          .setPopup(registerPopup(new maplibregl.Popup({ maxWidth: '480px' })).setHTML(permitPopupHtml(p)))
          .addTo(map)
        markersRef.current.push(marker)
      })
    }

    if (layers.reports) {
      reports.forEach((r) => {
        const marker = new maplibregl.Marker({ element: dotElement('#c33a26') }) // keep in sync with --red
          .setLngLat([r.lon, r.lat])
          .setPopup(registerPopup(new maplibregl.Popup({ maxWidth: '480px' })).setHTML(reportPopupHtml(r)))
          .addTo(map)
        markersRef.current.push(marker)
      })
    }
  }, [permits, reports, layers.permits, layers.reports])

  return <div ref={containerRef} className="map-container" />
}
