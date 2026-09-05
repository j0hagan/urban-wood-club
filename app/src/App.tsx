import { useState } from 'react'
import TreeMap from './components/TreeMap'
import Sidebar from './components/Sidebar'
import UploadPanel from './components/UploadPanel'

type Layers = { trees: boolean; permits: boolean; uploads: boolean }
type Picked = { lat: number; lon: number } | null

export default function App() {
  const [layers, setLayers] = useState<Layers>({ trees: true, permits: true, uploads: true })
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<Picked>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [thanks, setThanks] = useState(false)

  function toggleLayer(key: keyof Layers) {
    setLayers((l) => ({ ...l, [key]: !l[key] }))
  }

  function handlePick(lat: number, lon: number) {
    setPicked({ lat, lon })
    setPicking(false)
  }

  function handleSubmitted() {
    setPicked(null)
    setRefreshKey((k) => k + 1)
    setThanks(true)
    setTimeout(() => setThanks(false), 4000)
  }

  return (
    <div className="layout">
      <Sidebar
        layers={layers}
        onToggle={toggleLayer}
        reporting={picking}
        onStartReport={() => {
          setPicked(null)
          setPicking(true)
        }}
      />
      <main className="map-area">
        <TreeMap layers={layers} pickMode={picking} onPick={handlePick} refreshKey={refreshKey} />
        {picking && <div className="banner">Click anywhere on the map to mark the tree's location.</div>}
        {thanks && <div className="banner success">Thanks — your report is pending review.</div>}
        {picked && (
          <UploadPanel
            lat={picked.lat}
            lon={picked.lon}
            onCancel={() => setPicked(null)}
            onSubmitted={handleSubmitted}
          />
        )}
      </main>
    </div>
  )
}
