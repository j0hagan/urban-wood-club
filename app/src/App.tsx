import { useState } from 'react'
import TreeMap from './components/TreeMap'
import Sidebar from './components/Sidebar'
import ReportWizard, { emptyReportForm, type ReportFormState } from './components/ReportWizard'

type Layers = { trees: boolean; permits: boolean; reports: boolean }

export default function App() {
  const [layers, setLayers] = useState<Layers>({ trees: true, permits: true, reports: true })

  // wizard state: 0 = closed, 1/2/3 = Capture/Location/Details
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0)
  const [form, setForm] = useState<ReportFormState>(emptyReportForm)
  const [lat, setLat] = useState<number | null>(null)
  const [lon, setLon] = useState<number | null>(null)

  const [refreshKey, setRefreshKey] = useState(0)
  const [thanks, setThanks] = useState(false)

  function toggleLayer(key: keyof Layers) {
    setLayers((l) => ({ ...l, [key]: !l[key] }))
  }

  function startReport() {
    setForm(emptyReportForm)
    setLat(null)
    setLon(null)
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
      <Sidebar layers={layers} onToggle={toggleLayer} reporting={step > 0} onStartReport={startReport} />
      <main className="map-area">
        <TreeMap layers={layers} pickMode={step === 2} onPick={handleMapPick} refreshKey={refreshKey} />
        {step === 2 && <div className="banner">Click anywhere on the map to mark the tree's location.</div>}
        {thanks && <div className="banner success">Thanks — your report is pending review.</div>}
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
