import { useState, useEffect } from 'react'
import TreeMap from './components/TreeMap'
import Sidebar from './components/Sidebar'
import ReportWizard, { emptyReportForm, type ReportFormState } from './components/ReportWizard'

type Layers = { trees: boolean; permits: boolean; inventory: boolean; reports: boolean }

// Trimmed shape of a community report for the sidebar's always-visible
// feed - redeclared per-file to match this codebase's existing convention
// (see Layers above) rather than importing a shared type.
type ReportSummary = {
  id: string
  photo_url: string
  status: 'marked_for_felling' | 'felled' | 'new_tree_planted'
  species_name?: string
  created_at?: string
}

// Combined tree + log-cross-section mark: a bold bullseye of concentric
// rings (reads as both a round tree crown and the growth rings of a cut
// log - "the wood and the inside") sitting on a thick trunk, so the
// overall silhouette reads unmistakably as a tree.
function TargetMark({ onClick }: { onClick?: () => void }) {
  return (
    <svg
      width="186"
      height="232"
      viewBox="0 0 64 80"
      fill="none"
      aria-hidden="true"
      onClick={onClick}
    >
      <circle cx="32" cy="28" r="23" stroke="#17130f" strokeWidth="6" />
      <circle cx="32" cy="28" r="13" stroke="#17130f" strokeWidth="6" />
      <circle cx="32" cy="28" r="4" fill="#17130f" />
      <rect x="29" y="54" width="6" height="22" fill="#17130f" />
    </svg>
  )
}

// A harvester machine felling the same rings-and-trunk mark used in the
// logo - the placeholder graphic for the About/Projects/Contact pages,
// none of which have real content yet. Solid-silhouette forestry harvester
// (cab, hooded engine deck, front + tandem rear wheels, two-bar articulated
// boom with a knuckle joint, a curled grapple) in the same shape language
// as a reference photo the user sent, redrawn from scratch and gripping
// our own tree mark instead of a generic pine.
function FellingMark() {
  const ink = '#17130f'
  const paper = '#fbfaf5'
  return (
    <svg width="720" height="360" viewBox="0 -130 900 450" fill="none" aria-hidden="true">
      {/* wheels - solid hub with a punched-out rim; front wheel isolated,
          the rear two riding close together like a tandem axle */}
      {[110, 225, 305].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy="270" r="40" fill={ink} />
          <circle cx={cx} cy="270" r="16" fill={paper} />
        </g>
      ))}

      {/* chassis */}
      <rect x="60" y="200" width="320" height="50" rx="10" fill={ink} />

      {/* hooded engine deck between the cab and the boom mount, with
          punched-out cooling louvers */}
      <rect x="205" y="155" width="140" height="45" fill={ink} />
      {[217, 230, 243, 256, 269].map((x) => (
        <rect key={x} x={x} y="160" width="7" height="35" fill={paper} />
      ))}

      {/* cab, with a punched-out, raked windshield */}
      <rect x="65" y="95" width="140" height="105" rx="14" fill={ink} />
      <polygon points="80,110 175,110 180,150 75,160" fill={paper} />

      {/* articulated two-bar boom + hydraulic rams, reaching up to the
          grapple - a knuckle joint marks the elbow */}
      <circle cx="345" cy="205" r="14" fill={ink} />
      <path d="M345 205 L480 95" stroke={ink} strokeWidth="32" strokeLinecap="round" />
      <path d="M355 215 L470 115" stroke={ink} strokeWidth="10" strokeLinecap="round" />
      <circle cx="480" cy="95" r="18" fill={ink} />
      <path d="M480 95 L560 175" stroke={ink} strokeWidth="26" strokeLinecap="round" />
      <path d="M460 130 L540 150" stroke={ink} strokeWidth="10" strokeLinecap="round" />

      {/* grapple head, curled hooks closing around the trunk */}
      <rect x="545" y="170" width="45" height="32" rx="8" fill={ink} />
      <path d="M550 172 C540 150 546 128 566 122" stroke={ink} strokeWidth="11" strokeLinecap="round" />
      <path d="M587 172 C598 150 592 128 572 122" stroke={ink} strokeWidth="11" strokeLinecap="round" />

      {/* the logo's own rings-and-trunk tree, gripped at the base - now
          twice the previous size and tilted 45 degrees, continuing the
          boom's own upward diagonal rather than standing straight up.
          Drawn with the trunk's gripped end at the local origin so the
          rotation pivots around the grapple, not the tree's center. */}
      <g transform="translate(567,170) rotate(45)">
        <rect x="-15" y="-136" width="30" height="136" fill={ink} />
        <circle cx="0" cy="-238" r="102" stroke={ink} strokeWidth="24" />
        <circle cx="0" cy="-238" r="58" stroke={ink} strokeWidth="24" />
        <circle cx="0" cy="-238" r="18" fill={ink} />
      </g>
    </svg>
  )
}

function WipPage() {
  return (
    <div className="wip-page">
      <FellingMark />
      <p className="wip-text">Work in progress</p>
    </div>
  )
}

type Page = 'map' | 'about' | 'projects' | 'contact'

const PAGE_PATH: Record<Page, string> = {
  map: '/',
  about: '/about',
  projects: '/projects',
  contact: '/contact',
}

function pageFromPath(pathname: string): Page {
  switch (pathname.replace(/\/+$/, '') || '/') {
    case '/about':
      return 'about'
    case '/projects':
      return 'projects'
    case '/contact':
      return 'contact'
    default:
      return 'map'
  }
}

export default function App() {
  const [page, setPage] = useState<Page>(() => pageFromPath(window.location.pathname))
  const [layers, setLayers] = useState<Layers>({ trees: true, permits: true, inventory: true, reports: true })
  // Mobile only: the sidebar's own Layers section is hidden under 780px
  // (see .layers-section in styles.css) in favor of this compact toggle
  // living on the map itself, right below the zoom control.
  const [layersOpen, setLayersOpen] = useState(false)

  // wizard state: 0 = closed, 1/2/3 = Capture/Location/Details
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0)
  const [form, setForm] = useState<ReportFormState>(emptyReportForm)
  const [lat, setLat] = useState<number | null>(null)
  const [lon, setLon] = useState<number | null>(null)

  const [refreshKey, setRefreshKey] = useState(0)
  const [thanks, setThanks] = useState(false)
  const [counts, setCounts] = useState({ trees: 0, permits: 0, inventory: 0, reports: 0, permitTreeTotal: 0, inventoryTreeTotal: 0 })
  const [communityReports, setCommunityReports] = useState<ReportSummary[]>([])

  // Client-side routing for About/Projects/Contact - no router dependency,
  // same spirit as main.tsx's plain pathname check for /admin. The map
  // itself lives at "/"; the other three pages keep the header (logo,
  // wordmark, nav) and the "Report a tree" section, but drop Layers and
  // Community reports, and swap the map for a work-in-progress panel.
  useEffect(() => {
    function onPopState() {
      setPage(pageFromPath(window.location.pathname))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  function navigate(next: Page) {
    const path = PAGE_PATH[next]
    if (window.location.pathname.replace(/\/+$/, '') !== path.replace(/\/+$/, '')) {
      window.history.pushState(null, '', path)
    }
    setPage(next)
  }

  function toggleLayer(key: keyof Layers) {
    setLayers((l) => ({ ...l, [key]: !l[key] }))
  }

  function startReport() {
    setForm(emptyReportForm)
    setLat(null)
    setLon(null)
    setStep(1)
  }

  // Jumping in from an existing tree's popup ("Report this tree") - same as
  // startReport, but the location is already known, so it's pre-filled
  // rather than left for the Location step to collect. The Location step
  // still shows it and still lets the person override it (use current
  // location, or click elsewhere on the map) if the pin was slightly off.
  function reportThisTree(treeLat: number, treeLon: number) {
    setForm(emptyReportForm)
    setLat(treeLat)
    setLon(treeLon)
    setStep(1)
  }

  function handleMapPick(pickedLat: number, pickedLon: number) {
    if (step !== 2) return
    setLat(pickedLat)
    setLon(pickedLon)
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude)
        setLon(pos.coords.longitude)
      },
      () => {
        /* silently ignore - user can still click the map */
      }
    )
  }

  async function submitReport() {
    if (!form.photo || lat == null || lon == null) throw new Error('Missing photo or location.')
    const body = new FormData()
    body.set('photo', form.photo)
    body.set('lat', String(lat))
    body.set('lon', String(lon))
    body.set('status', form.status)
    body.set('quantity', form.quantity)
    body.set('species_known', form.speciesKnown ? '1' : '0')
    body.set('species_name', form.speciesName)
    body.set('request_community_id', form.requestCommunityId ? '1' : '0')
    body.set('trunk_measure_type', form.trunkMeasureType)
    body.set('trunk_measure_cm', form.trunkMeasureCm)
    body.set('felling_reason', form.fellingReason)
    body.set('felling_reason_other', form.fellingReasonOther)
    body.set('felling_date', form.fellingDate)
    body.set('felling_period', form.fellingPeriod)
    body.set('looking_for_arborist', form.lookingForArborist ? '1' : '0')
    body.set('arborist_contact', form.arboristContact)
    body.set('felled_date', form.felledDate)
    body.set('felled_period', form.felledPeriod)
    body.set('notes', form.notes)

    const res = await fetch('/api/reports', { method: 'POST', body })
    if (!res.ok) throw new Error(`Submit failed (${res.status})`)

    setStep(0)
    setRefreshKey((k) => k + 1)
    setThanks(true)
    setTimeout(() => setThanks(false), 4000)
  }

  return (
    <div className="layout">
      <header className="brand-header">
        <TargetMark onClick={() => navigate('map')} />
        <h1 className="brand-title" onClick={() => navigate('map')}>
          Urban
          <br />
          Wood
          <br />
          Club
        </h1>
        <nav className="brand-nav">
          <span onClick={() => navigate('about')}>About</span>
          <span onClick={() => navigate('projects')}>Projects</span>
          <span onClick={() => navigate('contact')}>Contact</span>
        </nav>
      </header>
      <Sidebar
        layers={layers}
        counts={counts}
        reports={communityReports}
        onToggle={toggleLayer}
        reporting={step > 0}
        onStartReport={startReport}
        showMapPanels={page === 'map'}
      />
      <main className="map-area">
        {page === 'map' && (
          <TreeMap
            layers={layers}
            pickMode={step === 2}
            onPick={handleMapPick}
            refreshKey={refreshKey}
            onCounts={setCounts}
            onReportTree={reportThisTree}
            onReportsChange={setCommunityReports}
          />
        )}
        {page !== 'map' && <WipPage />}
        {/* Mobile-only: a compact Layers toggle living on the map itself,
            below the zoom control (see .map-layers-control in styles.css -
            hidden entirely above the 780px breakpoint, where the sidebar's
            own Layers section already covers this). */}
        {page === 'map' && (
          <div className="map-layers-control">
            <button
              className="map-layers-toggle"
              onClick={() => setLayersOpen((o) => !o)}
              aria-expanded={layersOpen}
            >
              Layers
            </button>
            {layersOpen && (
              <div className="map-layers-panel">
                <label className="layer-row">
                  <input type="checkbox" checked={layers.trees} onChange={() => toggleLayer('trees')} />
                  <span className="swatch swatch-tree" /> Existing trees
                  <span className="layer-count">{counts.trees.toLocaleString()}</span>
                </label>
                <label className="layer-row">
                  <input type="checkbox" checked={layers.permits} onChange={() => toggleLayer('permits')} />
                  <span className="swatch swatch-permit" /> Felling permits
                  <span className="layer-count">
                    {counts.permits.toLocaleString()} ({counts.permitTreeTotal.toLocaleString()} trees)
                  </span>
                </label>
                <label className="layer-row">
                  <input type="checkbox" checked={layers.inventory} onChange={() => toggleLayer('inventory')} />
                  <span className="swatch swatch-inventory" /> Felling inventory
                  <span className="layer-count">
                    {counts.inventory.toLocaleString()} ({counts.inventoryTreeTotal.toLocaleString()} trees)
                  </span>
                </label>
                <label className="layer-row">
                  <input type="checkbox" checked={layers.reports} onChange={() => toggleLayer('reports')} />
                  <span className="swatch swatch-report" /> Community reports
                  <span className="layer-count">{counts.reports.toLocaleString()}</span>
                </label>
              </div>
            )}
          </div>
        )}
        {page === 'map' && step === 2 && (
          <div className="banner">Click anywhere on the map to mark the tree's location.</div>
        )}
        {page === 'map' && thanks && <div className="banner success">Thanks — your report is pending review.</div>}
        {step > 0 && (
          <ReportWizard
            step={step}
            form={form}
            setForm={setForm}
            lat={lat}
            lon={lon}
            onUseCurrentLocation={useCurrentLocation}
            onBack={() => setStep((s) => (s > 1 ? ((s - 1) as 1 | 2 | 3) : s))}
            onNext={() => setStep((s) => (s < 3 ? ((s + 1) as 1 | 2 | 3) : s))}
            onCancel={() => setStep(0)}
            onSubmit={submitReport}
          />
        )}
      </main>
    </div>
  )
}
