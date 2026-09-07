import { useEffect, useState } from 'react'

type PendingReport = {
  id: string
  lat: number
  lon: number
  photo_url: string
  status: string
  quantity: string
  species_known: number
  species_name: string | null
  request_community_id: number
  trunk_measure_type: string | null
  trunk_measure_cm: number | null
  felling_reason: string | null
  felling_reason_other: string | null
  felling_date: string | null
  felling_period: string | null
  looking_for_arborist: number
  arborist_contact: string | null
  felled_date: string | null
  felled_period: string | null
  notes: string | null
  created_at: string
}

type PendingPermit = {
  id: string
  publication_id: string
  title: string
  address: string | null
  lat: number | null
  lon: number | null
  tree_count: number | null
  species: string | null
  reason: string | null
  status: string
  tier: string
  source_url: string
  published_at: string
}

type Tab = 'reports' | 'permits'

const STATUS_LABEL: Record<string, string> = {
  marked_for_felling: 'Marked for felling',
  felled: 'Felled',
  new_tree_planted: 'New tree planted',
}

function fmt(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

export default function AdminReview() {
  const [token, setToken] = useState(() => localStorage.getItem('uwc_admin_token') ?? '')
  const [tab, setTab] = useState<Tab>('reports')
  // Community reports has two views: the moderation queue (approve/reject)
  // and what's already live on the map (delete only - it's already been
  // through the queue once).
  const [reportsView, setReportsView] = useState<'pending' | 'approved'>('pending')
  const [reports, setReports] = useState<PendingReport[] | null>(null)
  const [permits, setPermits] = useState<PendingPermit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem('uwc_admin_token', token)
  }, [token])

  async function load(which: Tab) {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const path =
        which === 'reports'
          ? reportsView === 'pending'
            ? '/api/admin/reports/pending'
            : '/api/admin/reports/approved'
          : '/api/admin/permits/pending'
      const res = await fetch(path, { headers: { authorization: `Bearer ${token}` } })
      if (res.status === 401) {
        setError('That admin token was rejected — check it and try again.')
        if (which === 'reports') setReports(null)
        else setPermits(null)
        return
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      const data = await res.json()
      if (which === 'reports') setReports(data)
      else setPermits(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong loading the queue.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(tab)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, token, reportsView])

  async function review(which: Tab, id: string, status: 'approved' | 'rejected') {
    setBusyId(id)
    setError(null)
    try {
      const path = which === 'reports' ? `/api/admin/reports/${id}/review` : `/api/admin/permits/${id}/review`
      const res = await fetch(path, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      })
      if (res.status === 401) {
        setError('That admin token was rejected — check it and try again.')
        return
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      if (which === 'reports') setReports((rs) => (rs ?? []).filter((r) => r.id !== id))
      else setPermits((ps) => (ps ?? []).filter((p) => p.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong submitting that decision.')
    } finally {
      setBusyId(null)
    }
  }

  // Permanent takedown of an already-live community report (the "Live"
  // view above) - distinct from reject, which only applies to the pending
  // queue and just marks a report as never having gone live.
  async function deleteReport(id: string) {
    if (!window.confirm('Permanently delete this community report? This cannot be undone.')) return
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/admin/reports/${id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        setError('That admin token was rejected — check it and try again.')
        return
      }
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      setReports((rs) => (rs ?? []).filter((r) => r.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong deleting that report.')
    } finally {
      setBusyId(null)
    }
  }

  const reportCount = reports?.length ?? 0
  const permitCount = permits?.length ?? 0

  return (
    <div className="admin-page">
      <header className="admin-header">
        <h1>Urban Wood Club — Review queue</h1>
        <p className="hint">
          Nothing a member submits, or that gets pulled in automatically, goes live on the map until it's approved
          here.
        </p>
        <label className="admin-token-row">
          Admin token
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste the ADMIN_TOKEN value"
            autoComplete="off"
          />
        </label>
      </header>

      {!token && <p className="hint">Paste the admin token above to load the review queue.</p>}

      {token && (
        <>
          <nav className="admin-tabs">
            <button className={tab === 'reports' ? 'active' : ''} onClick={() => setTab('reports')}>
              Community reports{reports ? ` (${reportCount})` : ''}
            </button>
            <button className={tab === 'permits' ? 'active' : ''} onClick={() => setTab('permits')}>
              Felling permits{permits ? ` (${permitCount})` : ''}
            </button>
            <button className="admin-refresh" onClick={() => load(tab)} disabled={loading}>
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </nav>

          {error && <p className="admin-error">{error}</p>}

          {tab === 'reports' && (
            <div className="admin-subtabs">
              <button
                className={reportsView === 'pending' ? 'active' : ''}
                onClick={() => setReportsView('pending')}
              >
                Pending
              </button>
              <button
                className={reportsView === 'approved' ? 'active' : ''}
                onClick={() => setReportsView('approved')}
              >
                Live on the map
              </button>
            </div>
          )}

          {tab === 'reports' && (
            <ul className="admin-list">
              {reports && reports.length === 0 && !loading && (
                <li className="hint">{reportsView === 'pending' ? 'Nothing pending review.' : 'Nothing live right now.'}</li>
              )}
              {reports?.map((r) => (
                <li key={r.id} className="admin-card">
                  <img className="admin-photo" src={r.photo_url} alt="Submitted photo" loading="lazy" />
                  <div className="admin-card-body">
                    <div className="admin-card-title">
                      {STATUS_LABEL[r.status] ?? r.status} · {r.quantity}
                    </div>
                    <dl className="admin-fields">
                      <dt>Species</dt>
                      <dd>{r.species_known ? fmt(r.species_name) : 'Not known'}</dd>
                      <dt>Trunk</dt>
                      <dd>
                        {r.trunk_measure_cm ? `${r.trunk_measure_cm} cm (${fmt(r.trunk_measure_type)})` : '—'}
                      </dd>
                      {r.status === 'marked_for_felling' && (
                        <>
                          <dt>Reason</dt>
                          <dd>{r.felling_reason === 'other' ? fmt(r.felling_reason_other) : fmt(r.felling_reason)}</dd>
                          <dt>Expected</dt>
                          <dd>{fmt(r.felling_date) !== '—' ? fmt(r.felling_date) : fmt(r.felling_period)}</dd>
                        </>
                      )}
                      {r.status === 'felled' && (
                        <>
                          <dt>Felled</dt>
                          <dd>{fmt(r.felled_date) !== '—' ? fmt(r.felled_date) : fmt(r.felled_period)}</dd>
                        </>
                      )}
                      {!!r.looking_for_arborist && (
                        <>
                          <dt>Looking for arborist</dt>
                          <dd>{fmt(r.arborist_contact)}</dd>
                        </>
                      )}
                      {!!r.request_community_id && (
                        <>
                          <dt>Wants community ID</dt>
                          <dd>Yes</dd>
                        </>
                      )}
                      <dt>Notes</dt>
                      <dd>{fmt(r.notes)}</dd>
                      <dt>Location</dt>
                      <dd>
                        {r.lat.toFixed(5)}, {r.lon.toFixed(5)}
                      </dd>
                      <dt>Submitted</dt>
                      <dd>{r.created_at.slice(0, 10)}</dd>
                    </dl>
                    <div className="admin-actions">
                      {reportsView === 'pending' ? (
                        <>
                          <button
                            className="approve"
                            disabled={busyId === r.id}
                            onClick={() => review('reports', r.id, 'approved')}
                          >
                            Approve
                          </button>
                          <button
                            className="reject"
                            disabled={busyId === r.id}
                            onClick={() => review('reports', r.id, 'rejected')}
                          >
                            Reject
                          </button>
                        </>
                      ) : (
                        <button className="reject" disabled={busyId === r.id} onClick={() => deleteReport(r.id)}>
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {tab === 'permits' && (
            <ul className="admin-list">
              {permits && permits.length === 0 && !loading && <li className="hint">Nothing pending review.</li>}
              {permits?.map((p) => (
                <li key={p.id} className="admin-card">
                  <div className="admin-card-body">
                    <div className="admin-card-title">
                      {p.title}
                      {p.tier === 'tier3' && <span className="tier3-badge">Tier 3 · attachment scan</span>}
                    </div>
                    <dl className="admin-fields">
                      <dt>Status</dt>
                      <dd>{p.status}</dd>
                      <dt>Trees</dt>
                      <dd>{fmt(p.tree_count)}</dd>
                      <dt>Species</dt>
                      <dd>{fmt(p.species)}</dd>
                      <dt>Reason</dt>
                      <dd>{fmt(p.reason)}</dd>
                      <dt>Address</dt>
                      <dd>{fmt(p.address)}</dd>
                      <dt>Published</dt>
                      <dd>{p.published_at.slice(0, 10)}</dd>
                      <dt>Source</dt>
                      <dd>
                        <a href={p.source_url} target="_blank" rel="noreferrer">
                          {p.publication_id}
                        </a>
                      </dd>
                    </dl>
                    <div className="admin-actions">
                      <button
                        className="approve"
                        disabled={busyId === p.id}
                        onClick={() => review('permits', p.id, 'approved')}
                      >
                        Approve
                      </button>
                      <button
                        className="reject"
                        disabled={busyId === p.id}
                        onClick={() => review('permits', p.id, 'rejected')}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
