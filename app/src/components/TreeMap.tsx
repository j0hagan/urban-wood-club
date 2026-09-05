import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// Delft's rough center - good enough for the initial view.
const DELFT_CENTER: [number, number] = [4.3571, 52.0116]

type Tree = { id: string; lat: number; lon: number; species_nl?: string; is_monumental?: number }
type Permit = { id: string; lat: number; lon: number; title: string; status: string }

export default function TreeMap() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const [trees, setTrees] = useState<Tree[]>([])
  const [permits, setPermits] = useState<Permit[]>([])

  useEffect(() => {
    if (!containerRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      // swap for your preferred style/tile provider
      style: 'https://demotiles.maplibre.org/style.json',
      center: DELFT_CENTER,
      zoom: 13,
    })
    mapRef.current = map
    return () => map.remove()
  }, [])

  useEffect(() => {
    fetch('/api/trees').then((r) => r.json()).then(setTrees).catch(() => {})
    fetch('/api/permits').then((r) => r.json()).then(setPermits).catch(() => {})
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    trees.forEach((t) => {
      new maplibregl.Marker({ color: '#2f7a3f' })
        .setLngLat([t.lon, t.lat])
        .setPopup(new maplibregl.Popup().setText(t.species_nl ?? 'Tree'))
        .addTo(map)
    })
    permits.forEach((p) => {
      new maplibregl.Marker({ color: '#c0392b' })
        .setLngLat([p.lon, p.lat])
        .setPopup(new maplibregl.Popup().setText(`${p.title} (${p.status})`))
        .addTo(map)
    })
  }, [trees, permits])

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
}
