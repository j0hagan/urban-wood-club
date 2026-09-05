type Layers = { trees: boolean; permits: boolean; uploads: boolean }

export default function Sidebar({
  layers,
  onToggle,
  onStartReport,
  reporting,
}: {
  layers: Layers
  onToggle: (key: keyof Layers) => void
  onStartReport: () => void
  reporting: boolean
}) {
  return (
    <aside className="sidebar">
      <h1>Urban Wood Club</h1>
      <p className="subtitle">Delft — tree tracker (trial)</p>

      <section>
        <h2>Layers</h2>
        <label className="layer-row">
          <input type="checkbox" checked={layers.trees} onChange={() => onToggle('trees')} />
          <span className="swatch swatch-tree" /> Existing trees
        </label>
        <label className="layer-row">
          <input type="checkbox" checked={layers.permits} onChange={() => onToggle('permits')} />
          <span className="swatch swatch-permit" /> Planned felling
        </label>
        <label className="layer-row">
          <input type="checkbox" checked={layers.uploads} onChange={() => onToggle('uploads')} />
          <span className="swatch swatch-report" /> Community reports
        </label>
      </section>

      <section>
        <h2>Report a tree</h2>
        <p className="hint">Seen a tree marked for felling, or a new one planted? Add a photo report.</p>
        <button className="report-btn" onClick={onStartReport} disabled={reporting}>
          {reporting ? 'Click the map to mark it…' : 'Start a report'}
        </button>
      </section>

      <footer className="sidebar-footer">
        Data: gemeente Delft (managed trees), OpenStreetMap, and Officiële
        Bekendmakingen (felling permits). Community reports are shown once
        reviewed.
      </footer>
    </aside>
  )
}
