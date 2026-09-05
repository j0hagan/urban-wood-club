import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const DELFT_CENTER: [number, number] = [4.3571, 52.0116]

type Tree = { id: string; lat: number; lon: number; species_nl?: string; is_monumental?: number }
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

  // (re)draw markers whenever data or layer visibility changes
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    if (layers.trees) {
      trees.forEach((t) => {
        const marker = new maplibregl.Marker({ color: '#3f6b46' }) // trees - keep in sync with --green in styles.css
          .setLngLat([t.lon, t.lat])
          .setPopup(new maplibregl.Popup().setText(t.species_nl ?? 'Tree'))
          .addTo(map)
        markersRef.current.push(marker)
      })
    }

    if (layers.permits) {
      permits.forEach((p) => {
        const marker = new maplibregl.Marker({ color: '#e2b93d' }) // planned felling - keep in sync with --yellow in styles.css
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
        label.innerHTML = `<strong>${STATUS_LABEL[r.status]}</strong>${r.species_name ? ` — ${r.species_name}` : ''}`
        popupNode.appendChild(label)
        if (r.notes) {
          const note = document.createElement('p')
          note.textContent = r.notes
          popupNode.appendChild(note)
        }
        const marker = new maplibregl.Marker({ color: '#c33a26' }) // community reports - keep in sync with --red in styles.css
          .setLngLat([r.lon, r.lat])
          .setPopup(new maplibregl.Popup().setDOMContent(popupNode))
          .addTo(map)
        markersRef.current.push(marker)
      })
    }
  }, [trees, permits, reports, layers])

  return <div ref={containerRef} className="map-container" />
}
