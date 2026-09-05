import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const DELFT_CENTER: [number, number] = [4.3571, 52.0116]

type Tree = { id: string; lat: number; lon: number; species_nl?: string; is_monumental?: number }
type Permit = { id: string; lat: number; lon: number; title: string; status: string }
type Upload = { id: string; lat: number; lon: number; note?: string; photo_url: string }

type Layers = { trees: boolean; permits: boolean; uploads: boolean }

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
  const [uploads, setUploads] = useState<Upload[]>([])

  // map init (once)
  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://demotiles.maplibre.org/style.json', // swap for a proper basemap style later
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
    fetch('/api/uploads').then((r) => r.json()).then(setUploads).catch(() => setUploads([]))
  }, [refreshKey])

  // (re)draw markers whenever data or layer visibility changes
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    if (layers.trees) {
      trees.forEach((t) => {
        const marker = new maplibregl.Marker({ color: '#2f7a3f' })
          .setLngLat([t.lon, t.lat])
          .setPopup(new maplibregl.Popup().setText(t.species_nl ?? 'Tree'))
          .addTo(map)
        markersRef.current.push(marker)
      })
    }

    if (layers.permits) {
      permits.forEach((p) => {
        const marker = new maplibregl.Marker({ color: '#c0392b' })
          .setLngLat([p.lon, p.lat])
          .setPopup(new maplibregl.Popup().setText(`${p.title} (${p.status})`))
          .addTo(map)
        markersRef.current.push(marker)
      })
    }

    if (layers.uploads) {
      uploads.forEach((u) => {
        const popupNode = document.createElement('div')
        const img = document.createElement('img')
        img.src = u.photo_url
        img.style.maxWidth = '200px'
        img.style.display = 'block'
        popupNode.appendChild(img)
        if (u.note) {
          const p = document.createElement('p')
          p.textContent = u.note
          popupNode.appendChild(p)
        }
        const marker = new maplibregl.Marker({ color: '#2980b9' })
          .setLngLat([u.lon, u.lat])
          .setPopup(new maplibregl.Popup().setDOMContent(popupNode))
          .addTo(map)
        markersRef.current.push(marker)
      })
    }
  }, [trees, permits, uploads, layers])

  return <div ref={containerRef} className="map-container" />
}
