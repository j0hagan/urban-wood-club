type Layers = { trees: boolean; permits: boolean; reports: boolean }

// A small ink-line twig mark - nods to the hand-drawn tree illustration in
// the project's research poster without reusing that actual artwork.
function TwigMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">
      <path
        d="M13 24V6M13 6C9 6 7 3 7 1M13 6C17 6 19 3 19 1M9 12C6.5 12 5 10.5 5 9M17 12C19.5 12 21 10.5 21 9"
        stroke="#17130f"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

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
      <div className="brand">
        <TwigMark />
        <h1>Urban Wood Club</h1>
      </div>
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
          <input type="checkbox" checked={layers.reports} onChange={() => onToggle('reports')} />
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
