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
type Permit = { id: string; lat: number; lon: number; title: string; status: string }
type Report = {
  id: string
  lat: number
  lon: number
  status: 'marked_for_felling' | 'felled' | 'new_tree_planted'
  species_name?: string
  notes?: string
  photo_url: string
}

type Layers = { trees: boolean; permits: boolean; reports: boolean }

const STATUS_LABEL: Record<Report['status'], string> = {
  marked_for_felling: 'Marked for felling',
  felled: 'Already felled',
  new_tree_planted: 'New tree planted',
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

function treePopupHtml(t: Tree): string {
  const row = (label: string, value: string | number | null | undefined) =>
    `<div class="tree-popup-row"><span>${label}</span><strong>${value != null && value !== '' ? escapeHtml(String(value)) : '—'}</strong></div>`

  return `
    <div class="tree-popup">
      <h3>${t.species_nl ? escapeHtml(t.species_nl) : 'Unspecified species'}${t.is_monumental ? ' <em>(monumental)</em>' : ''}</h3>
      ${row('Planted', t.planted_year)}
      ${row('Height', t.height_class)}
      ${row('Diameter', t.diameter_cm != null ? `${t.diameter_cm} cm` : null)}
      ${row('Neighborhood', t.neighborhood)}
      ${row('Site', t.site_type)}
      ${row('Managed as', t.management_group)}
      ${t.notes ? `<p class="tree-popup-notes">${escapeHtml(t.notes)}</p>` : ''}
    </div>
  `
}

export default function TreeMap({
  layers,
  pickMode,
  onPick,
  refreshKey,
}: {
  layers: Layers
  pickMode: boolean
  onPick: (lat: number, lon: number) => void
  refreshKey: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
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
      new maplibregl.Popup()
        .setLngLat(feature.geometry.coordinates as [number, number])
        .setHTML(treePopupHtml(feature.properties as Tree))
        .addTo(map)
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
        const marker = new maplibregl.Marker({ element: dotElement('#e2b93d') }) // keep in sync with --yellow
          .setLngLat([p.lon, p.lat])
          .setPopup(new maplibregl.Popup().setText(`${p.title} (${p.status})`))
          .addTo(map)
        markersRef.current.push(marker)
      })
    }

    if (layers.reports) {
      reports.forEach((r) => {
        const popupNode = document.createElement('div')
        const img = document.createElement('img')
        img.src = r.photo_url
        img.style.maxWidth = '200px'
        img.style.display = 'block'
        popupNode.appendChild(img)
        const label = document.createElement('p')
        label.innerHTML = `<strong>${STATUS_LABEL[r.status]}</strong>${r.species_name ? ` — ${escapeHtml(r.species_name)}` : ''}`
        popupNode.appendChild(label)
        if (r.notes) {
          const note = document.createElement('p')
          note.textContent = r.notes
          popupNode.appendChild(note)
        }
        const marker = new maplibregl.Marker({ element: dotElement('#c33a26') }) // keep in sync with --red
          .setLngLat([r.lon, r.lat])
          .setPopup(new maplibregl.Popup().setDOMContent(popupNode))
          .addTo(map)
        markersRef.current.push(marker)
      })
    }
  }, [permits, reports, layers.permits, layers.reports])

  return <div ref={containerRef} className="map-container" />
}
