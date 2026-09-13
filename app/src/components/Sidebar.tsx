type Layers = { trees: boolean; permits: boolean; inventory: boolean; reports: boolean }

type ReportSummary = {
  id: string
  photo_url: string
  status: 'marked_for_felling' | 'felled' | 'new_tree_planted'
  species_name?: string
  created_at?: string
}

const REPORT_STATUS_LABEL: Record<ReportSummary['status'], string> = {
  marked_for_felling: 'Marked for felling',
  felled: 'Already felled',
  new_tree_planted: 'New tree planted',
}

type Counts = {
  trees: number
  permits: number
  inventory: number
  reports: number
  permitTreeTotal: number
  inventoryTreeTotal: number
  inventoryRequiresPermit: number
  inventoryNoPermit: number
  inventoryAlreadyFelled: number
}

// The brand mark/wordmark/nav lives at the page level (App.tsx renders it
// as a <header> overlapping both this sidebar and the map) - everything
// else stays here: layer toggles with counts, the always-visible community
// report feed (scrollable - see .report-feed in styles.css), and the
// "Report a tree" trigger at the bottom, left side, as it was originally.
export default function Sidebar({
  layers,
  counts,
  reports,
  onToggle,
  onStartReport,
  reporting,
  showMapPanels,
  onSelectReport,
}: {
  layers: Layers
  counts: Counts
  reports: ReportSummary[]
  onToggle: (key: keyof Layers) => void
  onStartReport: () => void
  reporting: boolean
  // false on the About/Projects/Contact pages - Layers and Community
  // reports are map-specific, so they drop out there; "Report a tree"
  // stays either way.
  showMapPanels: boolean
  // Clicking a report in the feed below flies to it on the map and opens
  // its popup there (see TreeMap.tsx's focusReportId).
  onSelectReport?: (id: string) => void
}) {
  return (
    <aside className="sidebar">
      {showMapPanels && (
        <section className="layers-section">
          <h2>Layers</h2>
          <label className="layer-row">
            <input type="checkbox" checked={layers.trees} onChange={() => onToggle('trees')} />
            <span className="swatch swatch-tree" /> Existing trees
            <span className="layer-count">{counts.trees.toLocaleString()}</span>
          </label>
          <label className="layer-row">
            <input type="checkbox" checked={layers.permits} onChange={() => onToggle('permits')} />
            <span className="swatch swatch-permit" /> Felling permits
            <span className="layer-count">
              {counts.permits.toLocaleString()} ({counts.permitTreeTotal.toLocaleString()} trees)
            </span>
          </label>
          <label className="layer-row">
            <input type="checkbox" checked={layers.inventory} onChange={() => onToggle('inventory')} />
            <span className="swatch swatch-inventory" /> Felling inventory
            <span className="layer-count">{counts.inventory.toLocaleString()}</span>
          </label>
          {/* The GRIB tree-by-tree import - see TreeMap.tsx's marker-color
              comment - splits Felling inventory into three colors within
              that one toggle: this line is the legend for the three, not a
              separate control. Stays empty (all three zero) until that
              import has actually run. */}
          {(counts.inventoryRequiresPermit > 0 || counts.inventoryNoPermit > 0 || counts.inventoryAlreadyFelled > 0) && (
            <div className="layer-subrow">
              <span className="swatch swatch-inventory" /> {counts.inventoryRequiresPermit.toLocaleString()} need a permit
              <span className="swatch swatch-inventory-light" /> {counts.inventoryNoPermit.toLocaleString()} don&apos;t
              <span className="swatch swatch-report" /> {counts.inventoryAlreadyFelled.toLocaleString()} already felled
            </div>
          )}
          <label className="layer-row">
            <input type="checkbox" checked={layers.reports} onChange={() => onToggle('reports')} />
            <span className="swatch swatch-report" /> Community reports
            <span className="layer-count">{counts.reports.toLocaleString()}</span>
          </label>
        </section>
      )}

      {showMapPanels && (
        <section className="community-reports-section">
          <h2>Community reports</h2>
          {reports.length === 0 ? (
            <p className="hint small">No community reports yet — be the first to add one below.</p>
          ) : (
            <ul className="report-feed">
              {reports.map((r) => (
                <li
                  key={r.id}
                  className="report-feed-item"
                  onClick={() => onSelectReport?.(r.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onSelectReport?.(r.id)
                  }}
                >
                  <img className="report-feed-thumb" src={r.photo_url} alt="" loading="lazy" />
                  <div className="report-feed-text">
                    <strong>{REPORT_STATUS_LABEL[r.status]}</strong>
                    {r.species_name && <span> — {r.species_name}</span>}
                    {r.created_at && <span className="report-feed-date">{r.created_at.slice(0, 10)}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="report-section">
        <h2>Report a tree</h2>
        <p className="hint">Seen a tree marked for felling, or a new one planted? Add a photo report.</p>
        <button className="report-btn" onClick={onStartReport} disabled={reporting}>
          {reporting ? 'Click the map to mark it…' : 'Start a report'}
        </button>
      </section>
    </aside>
  )
}
