import { useState } from 'react'

// Mirrors the "Witness a Tree" wizard on urbanwood.club: Capture (photo) ->
// Location -> Details (status, quantity, species, measurement, and
// status-specific felling/stump detail, plus notes).

type Status = 'marked_for_felling' | 'felled' | 'new_tree_planted'
type Quantity = 'single' | 'few' | 'several' | 'street_row'
type TrunkMeasureType = 'diameter' | 'circumference'
type FellingReason = 'diseased' | 'storm_damaged' | 'infrastructure' | 'building_development' | 'light_improvement' | 'other'

export interface ReportFormState {
  photo: File | null
  status: Status
  quantity: Quantity
  speciesKnown: boolean
  speciesName: string
  requestCommunityId: boolean
  trunkMeasureType: TrunkMeasureType
  trunkMeasureCm: string
  fellingReason: FellingReason
  fellingReasonOther: string
  fellingDate: string
  fellingPeriod: string
  lookingForArborist: boolean
  arboristContact: string
  felledDate: string
  felledPeriod: string
  notes: string
}

export const emptyReportForm: ReportFormState = {
  photo: null,
  status: 'marked_for_felling',
  quantity: 'single',
  speciesKnown: false,
  speciesName: '',
  requestCommunityId: true,
  trunkMeasureType: 'diameter',
  trunkMeasureCm: '',
  fellingReason: 'diseased',
  fellingReasonOther: '',
  fellingDate: '',
  fellingPeriod: '',
  lookingForArborist: false,
  arboristContact: '',
  felledDate: '',
  felledPeriod: '',
  notes: '',
}

const STEPS = ['Capture', 'Location', 'Details'] as const

const STATUS_OPTIONS: { value: Status; label: string; hint: string }[] = [
  { value: 'marked_for_felling', label: 'Marked for Felling', hint: 'Scheduled or planned removal' },
  { value: 'felled', label: 'Already Felled', hint: 'Tree has been removed (stump remains)' },
  { value: 'new_tree_planted', label: 'New Tree Planted', hint: 'Replacement tree planted' },
]

const QUANTITY_OPTIONS: { value: Quantity; label: string }[] = [
  { value: 'single', label: 'Single Tree' },
  { value: 'few', label: 'A Few (2-5)' },
  { value: 'several', label: 'Several (6-20)' },
  { value: 'street_row', label: 'Street Row / Many' },
]

const FELLING_REASONS: { value: FellingReason; label: string }[] = [
  { value: 'diseased', label: 'Diseased / Dying' },
  { value: 'storm_damaged', label: 'Storm Damaged' },
  { value: 'infrastructure', label: 'Infrastructure Threat' },
  { value: 'building_development', label: 'Building Development' },
  { value: 'light_improvement', label: 'Light Improvement' },
  { value: 'other', label: 'Other Reason' },
]

export default function ReportWizard({
  step,
  form,
  setForm,
  lat,
  lon,
  onUseCurrentLocation,
  onBack,
  onNext,
  onCancel,
  onSubmit,
}: {
  step: 1 | 2 | 3
  form: ReportFormState
  setForm: (f: ReportFormState) => void
  lat: number | null
  lon: number | null
  onUseCurrentLocation: () => void
  onBack: () => void
  onNext: () => void
  onCancel: () => void
  onSubmit: () => void
}) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function patch(fields: Partial<ReportFormState>) {
    setForm({ ...form, ...fields })
  }

  const canGoNext =
    (step === 1 && !!form.photo) || (step === 2 && lat != null && lon != null) || step === 3

  async function handleSubmit() {
    setError(null)
    setSubmitting(true)
    try {
      await onSubmit()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="wizard">
      <div className="wizard-header">
        <div className="wizard-steps">
          {STEPS.map((label, i) => (
            <span key={label} className={i + 1 === step ? 'wizard-step active' : 'wizard-step'}>
              {label}
            </span>
          ))}
        </div>
        <button className="wizard-close" onClick={onCancel} aria-label="Cancel report">
          ✕
        </button>
      </div>

      <div className="wizard-body">
        {step === 1 && (
          <>
            <h2>Primary Photo</h2>
            <div className="capture-row">
              <label className="capture-btn">
                Use Camera
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={(e) => patch({ photo: e.target.files?.[0] ?? null })}
                />
              </label>
              <label className="capture-btn">
                Upload File
                <input type="file" accept="image/*" onChange={(e) => patch({ photo: e.target.files?.[0] ?? null })} />
              </label>
            </div>
            {form.photo && (
              <img className="photo-preview" src={URL.createObjectURL(form.photo)} alt="Preview of the reported tree" />
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h2>Tree Location</h2>
            <button className="capture-btn" onClick={onUseCurrentLocation} type="button">
              Use My Current Location
            </button>
            <p className="hint">…or click the spot on the map.</p>
            <p className="hint small">{lat != null && lon != null ? `${lat.toFixed(5)}, ${lon.toFixed(5)}` : 'No location set yet.'}</p>
          </>
        )}

        {step === 3 && (
          <>
            <h2>Tree Status</h2>
            <div className="option-cards">
              {STATUS_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={form.status === o.value ? 'option-card active' : 'option-card'}
                  onClick={() => patch({ status: o.value })}
                >
                  <strong>{o.label}</strong>
                  <span>{o.hint}</span>
                </button>
              ))}
            </div>

            <h2>Number of Trees</h2>
            <div className="button-group">
              {QUANTITY_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={form.quantity === o.value ? 'chip active' : 'chip'}
                  onClick={() => patch({ quantity: o.value })}
                >
                  {o.label}
                </button>
              ))}
            </div>

            <h2>Species</h2>
            <label className="check-row">
              <input type="checkbox" checked={form.speciesKnown} onChange={(e) => patch({ speciesKnown: e.target.checked })} />
              Species known?
            </label>
            {form.speciesKnown && (
              <input
                className="text-input"
                placeholder="e.g. London Plane, Oak..."
                value={form.speciesName}
                onChange={(e) => patch({ speciesName: e.target.value })}
              />
            )}
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.requestCommunityId}
                onChange={(e) => patch({ requestCommunityId: e.target.checked })}
              />
              Request community identification
            </label>

            <h2>Trunk Measurement (optional)</h2>
            <div className="button-group">
              <button
                type="button"
                className={form.trunkMeasureType === 'diameter' ? 'chip active' : 'chip'}
                onClick={() => patch({ trunkMeasureType: 'diameter' })}
              >
                Diameter
              </button>
              <button
                type="button"
                className={form.trunkMeasureType === 'circumference' ? 'chip active' : 'chip'}
                onClick={() => patch({ trunkMeasureType: 'circumference' })}
              >
                Circumference
              </button>
              <input
                className="text-input small"
                type="number"
                placeholder="cm"
                value={form.trunkMeasureCm}
                onChange={(e) => patch({ trunkMeasureCm: e.target.value })}
              />
            </div>

            {form.status === 'marked_for_felling' && (
              <>
                <h2>Felling Detail</h2>
                <label className="field-label">Felling reason</label>
                <select
                  className="text-input"
                  value={form.fellingReason}
                  onChange={(e) => patch({ fellingReason: e.target.value as FellingReason })}
                >
                  {FELLING_REASONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                {form.fellingReason === 'other' && (
                  <input
                    className="text-input"
                    placeholder="Explain reason..."
                    value={form.fellingReasonOther}
                    onChange={(e) => patch({ fellingReasonOther: e.target.value })}
                  />
                )}
                <label className="field-label">Felling date</label>
                <input
                  className="text-input"
                  type="date"
                  value={form.fellingDate}
                  onChange={(e) => patch({ fellingDate: e.target.value })}
                />
                <label className="field-label">Or felling period (e.g. Winter 2026)</label>
                <input
                  className="text-input"
                  placeholder="e.g. Winter 2026"
                  value={form.fellingPeriod}
                  onChange={(e) => patch({ fellingPeriod: e.target.value })}
                />
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={form.lookingForArborist}
                    onChange={(e) => patch({ lookingForArborist: e.target.checked })}
                  />
                  Looking for an arborist?
                </label>
                {form.lookingForArborist && (
                  <input
                    className="text-input"
                    placeholder="Email or phone number"
                    value={form.arboristContact}
                    onChange={(e) => patch({ arboristContact: e.target.value })}
                  />
                )}
              </>
            )}

            {form.status === 'felled' && (
              <>
                <h2>Stump Detail</h2>
                <label className="field-label">Felled date</label>
                <input
                  className="text-input"
                  type="date"
                  value={form.felledDate}
                  onChange={(e) => patch({ felledDate: e.target.value })}
                />
                <label className="field-label">Or felled period (e.g. Spring 2026)</label>
                <input
                  className="text-input"
                  placeholder="e.g. Spring 2026"
                  value={form.felledPeriod}
                  onChange={(e) => patch({ felledPeriod: e.target.value })}
                />
              </>
            )}

            <h2>Notes &amp; Comments</h2>
            <textarea
              placeholder="Describe the tree context, landmarks, or details..."
              value={form.notes}
              onChange={(e) => patch({ notes: e.target.value })}
            />
          </>
        )}

        {error && <p className="error">{error}</p>}
      </div>

      <div className="wizard-actions">
        <button onClick={step === 1 ? onCancel : onBack} disabled={submitting}>
          {step === 1 ? 'Cancel' : 'Back'}
        </button>
        {step < 3 ? (
          <button className="primary" onClick={onNext} disabled={!canGoNext}>
            Next
          </button>
        ) : (
          <button className="primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit Report'}
          </button>
        )}
      </div>
      {step === 3 && <p className="hint small submit-note">Reports are reviewed before they appear on the public map.</p>}
    </div>
  )
}
