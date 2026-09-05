import { useState } from 'react'

export default function UploadPanel({
  lat,
  lon,
  onCancel,
  onSubmitted,
}: {
  lat: number
  lon: number
  onCancel: () => void
  onSubmitted: () => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!file) {
      setError('Add a photo first.')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const form = new FormData()
      form.set('photo', file)
      form.set('lat', String(lat))
      form.set('lon', String(lon))
      form.set('note', note)
      const res = await fetch('/api/uploads', { method: 'POST', body: form })
      if (!res.ok) throw new Error(`upload failed (${res.status})`)
      onSubmitted()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="upload-panel">
      <h2>Report this location</h2>
      <p className="hint">
        {lat.toFixed(5)}, {lon.toFixed(5)}
      </p>
      <input type="file" accept="image/*" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      <textarea placeholder="What's happening here? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <div className="upload-actions">
        <button onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
        <button className="primary" onClick={submit} disabled={submitting}>
          {submitting ? 'Submitting…' : 'Submit report'}
        </button>
      </div>
      <p className="hint small">Reports are reviewed before they appear on the public map.</p>
    </div>
  )
}
