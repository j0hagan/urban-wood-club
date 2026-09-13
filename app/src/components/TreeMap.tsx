import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const DELFT_CENTER: [number, number] = [4.3571, 52.0116]

// Basemap toggle: the default vector style (free, keyless CARTO Positron -
// see the map-init effect below) vs. free, keyless Esri World Imagery
// satellite tiles. A raster style has to be a full style object of its
// own (one source, one layer) rather than a URL, since there's no free
// keyless "satellite style.json" the way there is for the vector one.
const STYLE_LIGHT = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const STYLE_SATELLITE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    'esri-satellite': {
      type: 'raster',
      tiles: [
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      ],
      tileSize: 256,
      attribution: 'Imagery &copy; Esri',
    },
  },
  layers: [{ id: 'esri-satellite-layer', type: 'raster', source: 'esri-satellite', minzoom: 0, maxzoom: 19 }],
}

// A plain custom MapLibre control (maplibregl's own .maplibregl-ctrl /
// -ctrl-group classes give it the same white pill + shadow as the zoom
// buttons for free) - added to the map before NavigationControl below so
// it stacks above the zoom buttons, per your request. setStyle() replaces
// the whole style, which wipes any source/layer not declared in the new
// style (our 'trees' GeoJSON layer included) - the trees-layer effect
// further down listens for the map's own 'style.load' event and re-adds
// it after every swap, satellite or back to the normal map.
class BasemapToggleControl implements maplibregl.IControl {
  private container?: HTMLDivElement
  private button?: HTMLButtonElement
  private map?: maplibregl.Map
  private satellite = false

  onAdd(map: maplibregl.Map) {
    this.map = map
    this.container = document.createElement('div')
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group basemap-toggle-ctrl'
    this.button = document.createElement('button')
    this.button.type = 'button'
    this.button.className = 'basemap-toggle-btn'
    this.button.title = 'Toggle satellite view'
    this.button.textContent = 'Sat'
    this.button.addEventListener('click', () => this.toggle())
    this.container.appendChild(this.button)
    return this.container
  }

  onRemove() {
    this.container?.remove()
    this.map = undefined
  }

  private toggle() {
    if (!this.map || !this.button) return
    this.satellite = !this.satellite
    this.button.textContent = this.satellite ? 'Map' : 'Sat'
    this.button.classList.toggle('active', this.satellite)
    // { diff: false } forces a full style reload instead of MapLibre's
    // default diff-based update. That default diffing is exactly why the
    // tree dots (and any other manually-added layer) were vanishing on
    // toggle and never coming back: a diffed setStyle() patches the
    // existing style in place and only fires 'styledata', never
    // 'style.load' - confirmed live (toggling logged three 'styledata'
    // events and zero 'style.load' events). The trees-layer effect below
    // only listens for 'style.load' (via styleVersion) to know when it's
    // safe to re-add the 'trees' source/layer the new style wiped, so
    // with diffing it never got a chance to re-run - 'trees' was gone for
    // good after the first toggle in either direction. A full reload is a
    // little heavier per click but is the documented way to get a
    // consistent 'style.load' every time.
    this.map.setStyle(this.satellite ? STYLE_SATELLITE : STYLE_LIGHT, { diff: false })
  }
}

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
  tier?: string | null
  // Populated only for a GRIB tree-by-tree inventory row (see
  // api/src/index.ts's POST /api/admin/inventory/import) - null/undefined
  // for Tier 2/3 and a plain one-off "+ Add by hand" record.
  requires_permit?: number | null
  already_felled?: number | null
  species_nl?: string | null
  species_lat?: string | null
  species_en?: string | null
  neighborhood?: string | null
  reason_en?: string | null
  photo_url?: string | null
  // GRIB field-survey detail (see migrate_2026_09_13_inventory_details.sql) -
  // null for anything not from the GRIB bulk import.
  planted_year?: number | null
  age_years?: number | null
  trunk_diameter_class?: string | null
  height_class?: string | null
  tree_size_class?: string | null
  condition_nl?: string | null
  condition_en?: string | null
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
  // All photos in order, photo_url itself first - see the multi-photo
  // upload support in ReportWizard.tsx/api/src/index.ts. Optional so a
  // stale cached response from before this field existed still degrades
  // to the single-photo behavior reportPopupHtml falls back to.
  photo_urls?: string[]
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

type Layers = { trees: boolean; permits: boolean; inventory: boolean; reports: boolean }

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
// Same zoom -> radius breakpoints as the trees-circle layer's own
// circle-radius paint property below, so the DOM-element permit/inventory/
// report dots end up the same visual size as the green circle-layer trees
// at every zoom level instead of sitting fixed-size and looking oversized
// whenever you zoom out.
const DOT_RADIUS_STOPS: [number, number][] = [
  [10, 2],
  [14, 3.2],
  [18, 5.5],
]

function dotRadiusForZoom(zoom: number): number {
  if (zoom <= DOT_RADIUS_STOPS[0][0]) return DOT_RADIUS_STOPS[0][1]
  const last = DOT_RADIUS_STOPS[DOT_RADIUS_STOPS.length - 1]
  if (zoom >= last[0]) return last[1]
  for (let i = 0; i < DOT_RADIUS_STOPS.length - 1; i++) {
    const [z0, r0] = DOT_RADIUS_STOPS[i]
    const [z1, r1] = DOT_RADIUS_STOPS[i + 1]
    if (zoom >= z0 && zoom <= z1) return r0 + ((zoom - z0) / (z1 - z0)) * (r1 - r0)
  }
  return last[1]
}

function dotElement(color: string, isSatellite: boolean, zoom: number): HTMLDivElement {
  const el = document.createElement('div')
  const diameter = dotRadiusForZoom(zoom) * 2
  el.style.width = `${diameter}px`
  el.style.height = `${diameter}px`
  el.style.borderRadius = '50%'
  el.style.background = color
  // A white ring reads fine against the flat CARTO map style but disappears
  // (or looks washed-out) against real aerial photography - switch to a
  // dark ink ring over satellite imagery instead, same idea as the
  // trees-circle layer's own satellite-aware stroke below. 1px to match
  // that layer's circle-stroke-width, now that the dots are sized to match
  // it too.
  el.style.border = isSatellite ? '1px solid #17130f' : '1px solid #fbfaf5'
  el.style.boxShadow = '0 1px 3px rgba(23,19,15,0.45)'
  // These dot markers sit visually on top of the map canvas, but a DOM
  // click event still bubbles up through the map container after it fires
  // here - and MapLibre's own click handler on the 'trees-circle' layer
  // (registered on the map/canvas, not on this element) then runs a
  // separate hit-test at the same pixel. Wherever an inventory/permit/report
  // dot sits at (or very near) a community tree point, that meant BOTH
  // popups opened - the marker's own popup, then the tree popup right after
  // it, which (per registerPopup's "only one open at a time" rule) instantly
  // closed the marker's popup again, so clicking the orange/yellow/red dot
  // always seemed to show the green tree underneath instead. Stopping
  // propagation here keeps the click from ever reaching that layer's
  // handler, without affecting the marker's own built-in popup-toggle
  // listener (also bound to this same element, so it still fires normally).
  el.addEventListener('click', (e) => e.stopPropagation())
  return el
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

// --- Photo lightbox --------------------------------------------------------
//
// One overlay shared by every popup that has a photo (report and inventory
// popups today - trees have none), appended straight to <body> rather than
// built per-popup, since a popup's own DOM gets thrown away on every
// setHTML() call. Ready for more than one photo per report (see
// reportPopupHtml's photo_urls) - prev/next + a counter, not just an
// enlarge.
let lightboxEl: HTMLDivElement | null = null
let lightboxImgEl: HTMLImageElement | null = null
let lightboxCounterEl: HTMLDivElement | null = null
let lightboxPhotos: string[] = []
let lightboxIndex = 0

function renderLightbox() {
  if (!lightboxImgEl || !lightboxCounterEl) return
  lightboxImgEl.src = lightboxPhotos[lightboxIndex] ?? ''
  const multi = lightboxPhotos.length > 1
  lightboxCounterEl.textContent = multi ? `${lightboxIndex + 1} / ${lightboxPhotos.length}` : ''
  lightboxCounterEl.style.display = multi ? '' : 'none'
}

function closeLightbox() {
  if (lightboxEl) lightboxEl.style.display = 'none'
}

function showLightboxDelta(delta: number) {
  if (!lightboxPhotos.length) return
  lightboxIndex = (lightboxIndex + delta + lightboxPhotos.length) % lightboxPhotos.length
  renderLightbox()
}

function ensureLightbox(): void {
  if (lightboxEl) return
  const el = document.createElement('div')
  el.className = 'photo-lightbox'
  el.style.display = 'none'
  el.innerHTML = `
    <button type="button" class="photo-lightbox-close" aria-label="Close">&times;</button>
    <button type="button" class="photo-lightbox-prev" aria-label="Previous photo">&#8249;</button>
    <img class="photo-lightbox-img" alt="" />
    <button type="button" class="photo-lightbox-next" aria-label="Next photo">&#8250;</button>
    <div class="photo-lightbox-counter"></div>
  `
  // Clicking the dark backdrop (the lightbox element itself, not one of
  // its children) closes it - the image and nav buttons have their own
  // listeners below, each stopping propagation so a click on them doesn't
  // also trigger this one.
  el.addEventListener('click', (e) => {
    if (e.target === el) closeLightbox()
  })
  el.querySelector('.photo-lightbox-close')!.addEventListener('click', closeLightbox)
  el.querySelector('.photo-lightbox-prev')!.addEventListener('click', (e) => {
    e.stopPropagation()
    showLightboxDelta(-1)
  })
  el.querySelector('.photo-lightbox-next')!.addEventListener('click', (e) => {
    e.stopPropagation()
    showLightboxDelta(1)
  })
  document.body.appendChild(el)
  lightboxEl = el
  lightboxImgEl = el.querySelector('.photo-lightbox-img')
  lightboxCounterEl = el.querySelector('.photo-lightbox-counter')

  document.addEventListener('keydown', (e) => {
    if (!lightboxEl || lightboxEl.style.display === 'none') return
    if (e.key === 'Escape') closeLightbox()
    else if (e.key === 'ArrowLeft') showLightboxDelta(-1)
    else if (e.key === 'ArrowRight') showLightboxDelta(1)
  })
}

function openLightbox(photos: string[], startIndex: number) {
  if (!photos.length) return
  ensureLightbox()
  lightboxPhotos = photos
  lightboxIndex = ((startIndex % photos.length) + photos.length) % photos.length
  renderLightbox()
  if (lightboxEl) lightboxEl.style.display = 'flex'
}

// Wires every `.lightbox-trigger` photo inside a just-opened popup - each
// one carries the same `data-photos` (a JSON array shared by the whole
// group) and its own `data-index` into that array. Has to be called again
// after any setHTML() on the same popup (species lookup resolving, etc.),
// same as every other popup-button wiring in this file - setHTML() replaces
// the DOM wholesale and drops previously attached listeners with it.
function wireLightboxTriggers(container: Element | null | undefined) {
  container?.querySelectorAll<HTMLElement>('.lightbox-trigger').forEach((el) => {
    el.addEventListener('click', () => {
      const photos = JSON.parse(el.dataset.photos ?? '[]') as string[]
      const index = Number(el.dataset.index ?? '0')
      openLightbox(photos, index)
    })
  })
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

// Rough local distance in meters (equirectangular approximation - fine at
// Delft's scale, no need for a full haversine). Used to link a "felled"
// community report back to whatever Tier 1 tree record used to stand
// there: the municipal dataset has no reliable felled/removed flag (see
// api/src/ingest/delft-trees.ts's own header comment), so a felled tree's
// row often just sits in `trees` unchanged - close enough to the report's
// own coordinates to look up rather than treat as gone.
function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000
  const avgLatRad = ((lat1 + lat2) / 2) * (Math.PI / 180)
  const dx = (lon2 - lon1) * (Math.PI / 180) * Math.cos(avgLatRad)
  const dy = (lat2 - lat1) * (Math.PI / 180)
  return Math.sqrt(dx * dx + dy * dy) * R
}

// 20m is generous enough to survive GPS/geocoding slop between a phone
// report and the municipal survey point, tight enough not to match some
// unrelated tree a couple of doors down in a dense row.
const NEAREST_TREE_MAX_METERS = 20

function findNearestTree(lat: number, lon: number, trees: Tree[]): Tree | null {
  let best: Tree | null = null
  let bestDist = Infinity
  for (const t of trees) {
    const d = distanceMeters(lat, lon, t.lat, t.lon)
    if (d < bestDist) {
      bestDist = d
      best = t
    }
  }
  return best && bestDist <= NEAREST_TREE_MAX_METERS ? best : null
}

// --- Chain navigation (prev/next across related records on one tree) ------
//
// Everything within NEAREST_TREE_MAX_METERS of a given point - the Tier 1
// standing tree, any felling permit/inventory record, and any community
// report - is one "chain": clicking through it answers a request like "this
// community report says a tree marked for felling is now felled, show me
// the felling permit and the original tree too" without piecing it together
// across separate one-hop links. Order is tree first, then permits/
// inventory, then community reports (each of the latter two groups oldest-
// first when a created_at exists) - not always strictly chronological (the
// auto-scraped permit feed has no created_at), but a stable, sensible read
// order regardless. Superflous "see the original tree"/"see the nearest
// standing tree" single-hop buttons this replaces are gone from
// inventoryPopupHtml/reportPopupHtml's own params below - the chain nav
// covers that same ground and more.
type ChainItem =
  | { kind: 'tree'; tree: Tree }
  | { kind: 'permit'; permit: Permit }
  | { kind: 'report'; report: Report }

function chainItemLatLon(item: ChainItem): [number, number] {
  if (item.kind === 'tree') return [item.tree.lon, item.tree.lat]
  if (item.kind === 'permit') return [item.permit.lon as number, item.permit.lat as number]
  return [item.report.lon, item.report.lat]
}

function buildChain(lat: number, lon: number, trees: Tree[], permits: Permit[], reports: Report[]): ChainItem[] {
  const items: ChainItem[] = []
  const tree = findNearestTree(lat, lon, trees)
  if (tree) items.push({ kind: 'tree', tree })
  const nearbyPermits = permits.filter(
    (p) => p.lat != null && p.lon != null && distanceMeters(lat, lon, p.lat, p.lon) <= NEAREST_TREE_MAX_METERS
  )
  for (const permit of nearbyPermits) items.push({ kind: 'permit', permit })
  const nearbyReports = reports
    .filter((r) => distanceMeters(lat, lon, r.lat, r.lon) <= NEAREST_TREE_MAX_METERS)
    .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
  for (const report of nearbyReports) items.push({ kind: 'report', report })
  return items
}

// Small footer appended to a popup's content whenever its chain has more
// than one member - prev/next like a photo gallery, plus a 2/3-style
// counter (see .tree-popup-chain-nav in styles.css; wireChainNav below
// wires the two buttons after every render, same "setHTML() drops
// listeners" reason as wireLightboxTriggers).
function chainNavHtml(index: number, total: number): string {
  if (total <= 1) return ''
  return `
    <div class="tree-popup-chain-nav">
      <button type="button" class="tree-popup-chain-prev" aria-label="Previous record on this tree">&#8249;</button>
      <span class="tree-popup-chain-counter">${index + 1} / ${total} on this tree</span>
      <button type="button" class="tree-popup-chain-next" aria-label="Next record on this tree">&#8250;</button>
    </div>`
}

// Renders one chain item using its own existing popup-HTML builder -
// nearestTree/nearestStandingTree are always passed null now that the
// chain nav footer above covers that same "see the related record" ground
// (see the ChainItem comment). isGribInventory mirrors the exact same
// check the permit marker loop below uses to choose inventoryPopupHtml
// over permitPopupHtml for a manual felling-inventory record.
function popupHtmlForChainItem(item: ChainItem, info?: SpeciesInfo | null, loadingInfo?: boolean): string {
  if (item.kind === 'tree') return treePopupHtml(item.tree, info, loadingInfo)
  if (item.kind === 'permit') {
    const isGribInventory = item.permit.tier === 'manual' && !!item.permit.species_nl
    return isGribInventory ? inventoryPopupHtml(item.permit, info, loadingInfo, null) : permitPopupHtml(item.permit)
  }
  return reportPopupHtml(item.report, null)
}

// The Wikidata lookup key for a chain item, mirroring each popup type's
// own existing species check (treePopupHtml keys off species_nl,
// inventoryPopupHtml off species_lat) - null means no lookup applies
// (a plain permit with no GRIB species data, and every community report).
function chainItemSpeciesKey(item: ChainItem): string | null {
  if (item.kind === 'tree') return item.tree.species_nl ?? null
  if (item.kind === 'permit') {
    return item.permit.tier === 'manual' && item.permit.species_nl ? (item.permit.species_lat ?? null) : null
  }
  return null
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
  const isManual = p.tier === 'manual'
  // A manual entry's source_url is either a real link the admin pasted in
  // (checked against http(s)://) or the endpoint's own placeholder text
  // ("Added by hand in /admin") when they left it blank - only render an
  // actual <a> when it looks like a URL, otherwise show it as plain text
  // rather than a dead/misleading link.
  const sourceHtml = p.source_url && /^https?:\/\//.test(p.source_url)
    ? `<a href="${escapeHtml(p.source_url)}" target="_blank" rel="noopener noreferrer">${isManual ? 'Source' : 'Officiële bekendmakingen'}</a>`
    : p.source_url
      ? escapeHtml(p.source_url)
      : '—'

  const heading = p.title_en
    ? `<h3>${escapeHtml(p.title_en)}</h3>
       <div class="tree-popup-original">${escapeHtml(p.title)}</div>`
    : `<h3>${escapeHtml(p.title)}</h3>`
  // Same reasoning as the orange map dot: flag a manually-added record
  // right in the popup too, not just on the map/admin queue, since
  // "Officiële bekendmakingen" wouldn't be true for one of these.
  const manualNote = isManual ? `<div class="tree-popup-original">Added by hand, not from the automated permit feed</div>` : ''

  return `
    <div class="tree-popup tree-popup-wide">
      ${heading}
      ${manualNote}
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

// One tree from the GRIB/Bomenwacht tree-by-tree felling inventory (see
// api/src/index.ts's POST /api/admin/inventory/import) - distinct from
// permitPopupHtml above because this dataset is structured per-tree rather
// than one scraped announcement sentence: a real photo (rotated to
// portrait at import time so the whole tree fits the frame - see that
// import step's own notes), species in three languages, and a permit-
// required flag that's independent of the felling reason. Same fixed-row,
// em-dash-for-missing spec-sheet convention as the other two popups.
// info/loadingInfo mirror treePopupHtml's own Wikidata lookup pattern - see
// lookupSpeciesInfo above - so a species reads identically (same common
// names, same Wikipedia links) whether it's a green municipal tree or a
// GRIB inventory tree, rather than trusting this import's own hand-typed
// translation dictionary as the final word. That dictionary's species_en/
// species_nl are kept as the instant fallback while the lookup resolves,
// and as the permanent fallback for anything Wikidata has no entry for.
// nearestStandingTree - only ever passed for an already-felled/stump entry
// (see the marker-creation effect below) - mirrors reportPopupHtml's own
// "See the original tree record" cross-link for a felled community report:
// same idea, same 20m findNearestTree() helper, just the other direction
// (from the felling record TO whatever Tier 1 record still stands nearby).
function inventoryPopupHtml(
  p: Permit,
  info?: SpeciesInfo | null,
  loadingInfo?: boolean,
  nearestStandingTree?: Tree | null
): string {
  const row = (label: string, value: string | number | null | undefined) =>
    `<div class="tree-popup-row"><span>${label}</span><strong>${value != null && value !== '' ? escapeHtml(String(value)) : '—'}</strong></div>`
  const rawRow = (label: string, html: string) => `<div class="tree-popup-row"><span>${label}</span><strong>${html}</strong></div>`

  const englishValue = loadingInfo ? '…' : (info?.en ?? p.species_en ?? null)
  const dutchValue = loadingInfo ? '…' : (info?.nl ?? p.species_nl ?? null)
  const heading = (loadingInfo ? p.species_en ?? p.species_nl : englishValue ?? dutchValue) ?? 'Unspecified species'

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

  const photoHtml = p.photo_url
    ? `<img class="inventory-popup-photo lightbox-trigger" src="${p.photo_url}" alt="${escapeHtml(String(heading))}" data-photos='${escapeHtml(JSON.stringify([p.photo_url]))}' data-index="0" />`
    : ''

  const permitValue = p.requires_permit ? 'Yes — permit required' : 'No — no permit needed'
  const statusValue = p.already_felled ? 'Already felled (recorded as gone or stump-only)' : 'Standing'
  const reasonHtml = p.reason_en
    ? `<div class="tree-popup-row"><span>Reason for felling</span><strong>${escapeHtml(p.reason_en)}</strong></div>
       <div class="tree-popup-original">${escapeHtml(p.reason ?? '')}</div>`
    : row('Reason for felling', p.reason)

  const nearestTreeHtml =
    p.already_felled && nearestStandingTree
      ? `
      <div class="tree-popup-report">
        <p>This one's recorded as already felled or stump-only - here's the nearest still-standing municipal tree record nearby, in case it's the same tree.</p>
        <button type="button" class="tree-popup-original-btn">See nearby standing tree record</button>
      </div>`
      : ''

  return `
    <div class="tree-popup tree-popup-wide">
      ${photoHtml}
      <h3>${escapeHtml(String(heading))}</h3>
      ${row('Dutch name', dutchValue)}
      ${row('Scientific name', p.species_lat)}
      ${rawRow('More info on species', wikiHtml)}
      ${row('Permit required', permitValue)}
      ${row('Status', statusValue)}
      ${reasonHtml}
      ${row('Trunk diameter', p.trunk_diameter_class)}
      ${row('Height', p.height_class)}
      ${row('Tree size class', p.tree_size_class)}
      ${row('Condition', p.condition_en ?? p.condition_nl)}
      ${row('Planted', p.planted_year)}
      ${row('Age (as surveyed)', p.age_years != null ? `${p.age_years} years` : null)}
      ${row('Address', p.address)}
      ${row('Neighborhood', p.neighborhood)}
      ${row('Source', 'Gemeente Delft tree register (GRIB)')}
      ${nearestTreeHtml}
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
function reportPopupHtml(r: Report, nearestTree?: Tree | null): string {
  // photo_urls (multi-photo upload support) always includes the primary
  // photo - r.photo_url itself - first; falls back to a single-item array
  // for anything fetched before that field existed. First photo renders at
  // the existing full-width size, any rest as a row of small thumbnails
  // below it - all of them open the same lightbox, just at a different
  // starting index.
  const photos = r.photo_urls && r.photo_urls.length ? r.photo_urls : [r.photo_url]
  const photosJson = escapeHtml(JSON.stringify(photos))
  const photoHtml =
    `<img class="tree-popup-photo lightbox-trigger" src="${photos[0]}" alt="Submitted photo" data-photos='${photosJson}' data-index="0" />` +
    (photos.length > 1
      ? `<div class="tree-popup-photo-strip">${photos
          .slice(1)
          .map(
            (url, i) =>
              `<img class="tree-popup-photo-thumb lightbox-trigger" src="${url}" alt="Submitted photo ${i + 2}" data-photos='${photosJson}' data-index="${i + 1}" />`
          )
          .join('')}</div>`
      : '')

  const row = (label: string, value: string | number | null | undefined) =>
    `<div class="tree-popup-row"><span>${label}</span><strong>${value != null && value !== '' ? escapeHtml(String(value)) : '—'}</strong></div>`

  const reasonValue =
    r.felling_reason === 'other' ? r.felling_reason_other : r.felling_reason ? (FELLING_REASON_LABEL[r.felling_reason] ?? r.felling_reason) : null
  const expectedValue = r.felling_date || r.felling_period || null
  const felledValue = r.felled_date || r.felled_period || null
  const trunkValue = r.trunk_measure_cm ? `${r.trunk_measure_cm} cm (${r.trunk_measure_type ?? '?'})` : null
  const speciesValue = r.species_known ? r.species_name : null

  // A felled report still has a nearby Tier 1 record most of the time -
  // the municipal dataset doesn't reliably mark a tree as removed (see
  // findNearestTree's own comment above) - so offer a click-through to
  // what stood here rather than leaving the gap unexplained.
  const originalTreeHtml =
    r.status === 'felled' && nearestTree
      ? `
      <div class="tree-popup-report">
        <p>The municipal record for this spot hasn't caught up yet - here's what it still shows as standing here.</p>
        <button type="button" class="tree-popup-original-btn">See the original tree record</button>
      </div>`
      : ''

  return `
    <div class="tree-popup tree-popup-wide">
      ${photoHtml}
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
      ${originalTreeHtml}
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
  focusReportId,
  onFocusReportHandled,
}: {
  layers: Layers
  pickMode: boolean
  onPick: (lat: number, lon: number) => void
  refreshKey: number
  onCounts?: (counts: {
    trees: number
    permits: number
    inventory: number
    reports: number
    permitTreeTotal: number
    inventoryTreeTotal: number
    inventoryRequiresPermit: number
    inventoryNoPermit: number
    inventoryAlreadyFelled: number
  }) => void
  onReportTree?: (lat: number, lon: number) => void
  onReportsChange?: (reports: ReportSummary[]) => void
  // Sidebar's community-report feed -> map: which report id (if any) to
  // fly to and open the popup for, and how to tell App.tsx it's been
  // handled so the same click can be repeated later.
  focusReportId?: string | null
  onFocusReportHandled?: () => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  // Keyed by report id, so the sidebar's "click a report to open its
  // popup" feature (focusReportId above) can find the right marker
  // without scanning markersRef (which also holds permit/inventory dots).
  const reportMarkersRef = useRef<Record<string, maplibregl.Marker>>({})
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

  // Renders one chain item (see ChainItem/buildChain above) into an
  // already-created, already-registered popup - repositioning it
  // (setLngLat) and swapping its content (setHTML) to match, rather than
  // opening a new floating popup per hop, so the marker's own click-to-
  // toggle keeps working against one stable Popup instance throughout.
  // Wires every interactive bit inside the new content the same way every
  // other popup in this file already has to after any setHTML() call
  // (lightbox triggers, the tree popup's "Report this tree" button, and
  // here also the chain's own prev/next), and kicks off that item's
  // Wikidata lookup if it has one (chainItemSpeciesKey). `generation` is a
  // per-popup counter bumped on every render so a slow lookup for a chain
  // item the user has since navigated away from can't clobber whatever's
  // now showing.
  function renderChainPopup(popup: maplibregl.Popup, chain: ChainItem[], index: number, generation: { current: number }) {
    const i = ((index % chain.length) + chain.length) % chain.length
    const item = chain[i]
    const [lon, lat] = chainItemLatLon(item)
    const speciesKey = chainItemSpeciesKey(item)
    popup.setLngLat([lon, lat]).setHTML(popupHtmlForChainItem(item, null, !!speciesKey) + chainNavHtml(i, chain.length))

    const wire = () => {
      wireLightboxTriggers(popup.getElement())
      if (item.kind === 'tree') {
        const tree = item.tree
        popup
          .getElement()
          ?.querySelector('.tree-popup-report-btn')
          ?.addEventListener('click', () => onReportTree?.(tree.lat, tree.lon))
      }
      popup
        .getElement()
        ?.querySelector('.tree-popup-chain-prev')
        ?.addEventListener('click', () => renderChainPopup(popup, chain, i - 1, generation))
      popup
        .getElement()
        ?.querySelector('.tree-popup-chain-next')
        ?.addEventListener('click', () => renderChainPopup(popup, chain, i + 1, generation))
    }
    wire()

    if (speciesKey) {
      const myGen = ++generation.current
      lookupSpeciesInfo(speciesKey).then((info) => {
        if (!popup.isOpen() || generation.current !== myGen) return
        popup.setHTML(popupHtmlForChainItem(item, info, false) + chainNavHtml(i, chain.length))
        wire()
      })
    }
  }
  const [mapLoaded, setMapLoaded] = useState(false)
  const [trees, setTrees] = useState<Tree[]>([])
  const [permits, setPermits] = useState<Permit[]>([])
  const [reports, setReports] = useState<Report[]>([])
  // Bumped on every 'style.load' (initial load AND every later setStyle
  // from the satellite toggle) so the trees-layer effect below knows to
  // re-check whether it needs to re-add its source/layer.
  const [styleVersion, setStyleVersion] = useState(0)
  // Guards the trees-circle hover/click handlers so they're only ever
  // registered once for the map's lifetime - see that effect's own
  // comment for why re-registering them after every style swap would
  // stack up duplicate handlers instead of just resuming for free.
  const treeHandlersBoundRef = useRef(false)
  // trees-circle's click handler (below) is registered once ever, guarded
  // by treeHandlersBoundRef above - so its closure can't just read
  // `permits`/`reports` from component scope, that would freeze them at
  // whatever those were on the very first bind and never see a later
  // report/permit added after a refetch. These refs give it (and the
  // permit/report marker loops, for the same "always read current data"
  // reason when building a chain) a live view instead.
  const treesRef = useRef<Tree[]>([])
  const permitsRef = useRef<Permit[]>([])
  const reportsRef = useRef<Report[]>([])

  // map init (once)
  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_LIGHT, // free, keyless CARTO basemap
      center: DELFT_CENTER,
      zoom: 13,
    })
    mapRef.current = map
    // Satellite toggle above the zoom buttons, per your request - added
    // first so it stacks above NavigationControl in the same corner.
    map.addControl(new BasemapToggleControl(), 'top-right')
    // "Find me" / live location - a built-in MapLibre control rather than
    // hand-rolled, per your request to see your own position while
    // walking around (most useful on a phone browser). trackUserLocation
    // keeps recentering and updating the dot as you move, not just a
    // one-off fix (this MapLibre version's GeolocateControl has no
    // heading-arrow option to go with it). Uses the browser's own
    // Geolocation permission prompt - nothing here works until the person
    // taps the button and allows it.
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
      }),
      'top-right'
    )
    // Zoom in/out buttons, per your request - compass/rotate control left
    // off since this map never rotates.
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), 'top-right')
    map.on('load', () => setMapLoaded(true))
    map.on('style.load', () => setStyleVersion((v) => v + 1))
    // Keeps every DOM-element dot marker (permit/inventory/report) in sync
    // with the trees-circle layer's own zoom-based circle-radius as the
    // user zooms, rather than only sizing them once at creation time -
    // dotRadiusForZoom() above uses the exact same breakpoints as that
    // layer's paint property.
    map.on('zoom', () => {
      const diameter = dotRadiusForZoom(map.getZoom()) * 2
      for (const marker of markersRef.current) {
        const el = marker.getElement()
        el.style.width = `${diameter}px`
        el.style.height = `${diameter}px`
      }
    })
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

  // Keep treesRef/permitsRef/reportsRef (see their declaration above) in
  // sync with the state they mirror, so the once-ever trees-circle click
  // handler and the chain-building in the permit/report marker loop below
  // always read current data.
  useEffect(() => {
    treesRef.current = trees
  }, [trees])
  useEffect(() => {
    permitsRef.current = permits
  }, [permits])
  useEffect(() => {
    reportsRef.current = reports
  }, [reports])

  // surface item counts to the parent, so the sidebar can show a count
  // beside each layer's toggle. permitTreeTotal sums each permit's own
  // tree_count (how many trees that felling notice covers) - a different,
  // usually larger number than permits.length (how many permit markers are
  // plotted), since one permit can cover several trees. Permits with an
  // unknown tree_count (null/undefined - the count couldn't be parsed from
  // the notice title) are skipped rather than counted as 0.
  useEffect(() => {
    // Felling permits (auto-scraped from the government permit feed,
    // tier2/tier3) and Felling inventory (added by hand from a separate
    // source such as the GRIB/Bomenwacht tree viewer, tier === 'manual')
    // are two distinct layers now, each with its own toggle and count -
    // split the raw `permits` list by tier rather than lumping every
    // felling record into one number.
    const officialPermits = permits.filter((p) => p.tier !== 'manual')
    const manualPermits = permits.filter((p) => p.tier === 'manual')
    const sumTrees = (list: Permit[]) =>
      list.reduce((sum, p) => (typeof p.tree_count === 'number' ? sum + p.tree_count : sum), 0)
    // Sub-breakdown within Felling inventory - see the marker-color comment
    // above for what each bucket means. Only ever non-zero for the GRIB
    // import (a plain "+ Add by hand" record has requires_permit/
    // already_felled left null, so it falls out of all three here - same
    // as it not counting toward inventoryTreeTotal above).
    const stillStanding = manualPermits.filter((p) => !p.already_felled)
    onCounts?.({
      trees: trees.length,
      permits: officialPermits.length,
      inventory: manualPermits.length,
      reports: reports.length,
      permitTreeTotal: sumTrees(officialPermits),
      inventoryTreeTotal: sumTrees(manualPermits),
      inventoryRequiresPermit: stillStanding.filter((p) => p.requires_permit).length,
      inventoryNoPermit: stillStanding.filter((p) => !p.requires_permit).length,
      inventoryAlreadyFelled: manualPermits.filter((p) => p.already_felled).length,
    })
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

    // Dialed back a notch from the previous 2.5/4/7 pass (that pass fixed
    // the dots reading as "gone" over the sparse default view, but a bit
    // too big once you're looking at a dense block). The white stroke ring
    // is dropped entirely over satellite imagery, per your request - it
    // reads fine against the flat CARTO basemap but looks odd/artificial
    // against real aerial photography. 'esri-satellite' is the source id
    // STYLE_SATELLITE declares above, so its presence in whatever style
    // just (re)loaded is a reliable way to tell which basemap is active -
    // this whole block reruns on every style swap (see the styleVersion
    // comment below), so a toggle always gets the right stroke for the
    // basemap it's landing on.
    const isSatellite = !!map.getSource('esri-satellite')
    map.addSource('trees', { type: 'geojson', data: geojson as any })
    map.addLayer({
      id: 'trees-circle',
      type: 'circle',
      source: 'trees',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 3.2, 18, 5.5],
        'circle-color': '#3f6b46', // keep in sync with --green in styles.css
        'circle-stroke-width': 1,
        // Same reasoning as dotElement()'s ring below: a plain white stroke
        // looked artificial over aerial photography, but dropping it
        // entirely (the previous fix) left the dots looking like flat
        // green smudges - a dark ink ring reads better on satellite while
        // white still reads best on the flat CARTO basemap.
        'circle-stroke-color': isSatellite ? '#17130f' : '#fbfaf5',
        'circle-opacity': 0.9,
      },
    })

    // Registered once ever, not once per style swap: MapLibre's layer-
    // scoped listeners are keyed by layer id against whatever's in the
    // CURRENT style, not tied to this particular layer instance - once a
    // 'trees-circle' layer exists again after setStyle(), these resume
    // firing on their own. Re-registering here on every swap would just
    // stack up duplicate handlers (and duplicate popups per click) instead.
    if (!treeHandlersBoundRef.current) {
      treeHandlersBoundRef.current = true
      map.on('mouseenter', 'trees-circle', () => (map.getCanvas().style.cursor = 'pointer'))
      map.on('mouseleave', 'trees-circle', () => (map.getCanvas().style.cursor = ''))
      map.on('click', 'trees-circle', (e) => {
        const feature = e.features?.[0]
        if (!feature || feature.geometry.type !== 'Point') return
        const tree = feature.properties as Tree

        // Chain nav (see ChainItem/buildChain/renderChainPopup above) is
        // built from the refs, not the trees/permits/reports state
        // directly - this handler is bound once ever (treeHandlersBoundRef
        // below) so its own closure would otherwise freeze those at
        // whatever they were on the very first bind.
        const chain = buildChain(tree.lat, tree.lon, treesRef.current, permitsRef.current, reportsRef.current)
        const chainIndex = Math.max(
          chain.findIndex((item) => item.kind === 'tree' && item.tree.id === tree.id),
          0
        )

        // Default maplibre popups cap out at 240px wide - too narrow for the
        // now-doubled .tree-popup-wide layout, so this one gets an explicit
        // wider cap.
        const popup = registerPopup(new maplibregl.Popup({ maxWidth: '480px' })).addTo(map)
        renderChainPopup(popup, chain, chainIndex, { current: 0 })
      })
    }
    // styleVersion: re-run after every setStyle() (the satellite toggle),
    // since that wipes any source/layer not declared in the new style -
    // this re-adds 'trees' from scratch each time, same as a fresh load.
  }, [trees, mapLoaded, styleVersion])

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
    reportMarkersRef.current = {}
    const isSatellite = !!map.getSource('esri-satellite')

    // Felling permits (yellow, tier2/tier3) and Felling inventory (orange
    // family, tier === 'manual') are independently toggleable layers - each
    // permit is gated by its own layer's flag rather than one shared
    // 'permits' toggle, so hiding one doesn't hide the other. Within Felling
    // inventory, a tree already recorded as gone (already_felled - GRIB's
    // own survey found it not present or stump-only) gets the same red used
    // for a community "already felled" report rather than either orange
    // shade, since visually it's the same fact as a felled report. Of the
    // ones still standing, permit-required gets the darker orange and
    // no-permit-needed gets the lighter one - both still just one
    // "Felling inventory" toggle. Keep colors in sync with
    // --yellow/--orange/--orange-light/--red in styles.css.
    permits.forEach((p) => {
      if (p.lat == null || p.lon == null) return // not geocoded yet - still in the moderation queue
      const isManual = p.tier === 'manual'
      if (isManual ? !layers.inventory : !layers.permits) return
      let color = '#e2b93d' // yellow: Tier 2/3 auto-scraped permit
      if (isManual) {
        color = p.already_felled ? '#c33a26' : p.requires_permit ? '#d9772b' : '#f0b072'
      }
      // Chain nav (see ChainItem/buildChain/renderChainPopup above) covers
      // every permit/inventory record's own popup rendering, species lookup
      // and lightbox wiring - it only actually renders once the popup is
      // opened, and resets back to this record (not wherever chain nav last
      // left it) on every reopen, since chainIndex is fixed per marker.
      const chain = buildChain(p.lat, p.lon, trees, permits, reports)
      const chainIndex = Math.max(
        chain.findIndex((item) => item.kind === 'permit' && item.permit === p),
        0
      )
      const generation = { current: 0 }
      const popup = registerPopup(new maplibregl.Popup({ maxWidth: '480px' }))
      popup.on('open', () => renderChainPopup(popup, chain, chainIndex, generation))
      const marker = new maplibregl.Marker({ element: dotElement(color, isSatellite, map.getZoom()) })
        .setLngLat([p.lon, p.lat])
        .setPopup(popup)
        .addTo(map)
      markersRef.current.push(marker)
    })

    if (layers.reports) {
      reports.forEach((r) => {
        // Chain nav (see ChainItem/buildChain/renderChainPopup above) covers
        // this report's own popup rendering and lightbox wiring - resets
        // back to this record (not wherever chain nav last left it) on
        // every reopen, since chainIndex is fixed per marker.
        const chain = buildChain(r.lat, r.lon, trees, permits, reports)
        const chainIndex = Math.max(
          chain.findIndex((item) => item.kind === 'report' && item.report === r),
          0
        )
        const generation = { current: 0 }
        const reportPopup = registerPopup(new maplibregl.Popup({ maxWidth: '480px' }))
        reportPopup.on('open', () => renderChainPopup(reportPopup, chain, chainIndex, generation))
        const marker = new maplibregl.Marker({ element: dotElement('#c33a26', isSatellite, map.getZoom()) }) // keep in sync with --red
          .setLngLat([r.lon, r.lat])
          .setPopup(reportPopup)
          .addTo(map)
        markersRef.current.push(marker)
        reportMarkersRef.current[r.id] = marker
      })
    }
    // styleVersion: re-run after every setStyle() (the satellite toggle) so
    // these markers get rebuilt with the right ring color for whichever
    // basemap is now showing - see dotElement()'s isSatellite param above.
  }, [trees, permits, reports, layers.permits, layers.inventory, layers.reports, styleVersion])

  // Sidebar -> map: clicking a report in the always-visible community-report
  // feed (Sidebar.tsx) flies to its marker and opens its popup, the same
  // popup a direct map click would show - App.tsx also force-enables the
  // reports layer before setting focusReportId, so the marker is guaranteed
  // to exist by the time this runs.
  useEffect(() => {
    if (!focusReportId) return
    const marker = reportMarkersRef.current[focusReportId]
    const map = mapRef.current
    if (!marker || !map) return
    map.flyTo({ center: marker.getLngLat(), zoom: Math.max(map.getZoom(), 16) })
    marker.togglePopup()
    onFocusReportHandled?.()
  }, [focusReportId, reports])

  return <div ref={containerRef} className="map-container" />
}
