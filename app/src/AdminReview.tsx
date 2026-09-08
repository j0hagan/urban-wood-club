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

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (body && typeof body.error === 'string') return body.error
  } catch {
    // response wasn't JSON - fall through to the generic message
  }
  return `Request failed (${res.status})`
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
  // Felling permits: same pending/live split as reports, so a permit that's
  // already live can be found and (rarely) deleted, not just reviewed.
  const [permitsView, setPermitsView] = useState<'pending' | 'approved'>('pending')
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
          : permitsView === 'pending'
            ? '/api/admin/permits/pending'
            : '/api/admin/permits/approved'
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
  }, [tab, token, reportsView, permitsView])

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
      if (!res.ok) throw new Error(await readError(res))
      if (which === 'reports') setReports((rs) => (rs ?? []).filter((r) => r.id !== id))
      else setPermits((ps) => (ps ?? []).filter((p) => p.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong submitting that decision.')
    } finally {
      setBusyId(null)
    }
  }

  // Permanent takedown of an already-live record (the "Live" view above,
  // on either tab) - distinct from reject, which only applies to the
  // pending queue and just marks something as never having gone live.
  async function remove(which: Tab, id: string) {
    const label = which === 'reports' ? 'community report' : 'felling permit'
    if (!window.confirm(`Permanently delete this ${label}? This cannot be undone.`)) return
    setBusyId(id)
    setError(null)
    try {
      const path = which === 'reports' ? `/api/admin/reports/${id}` : `/api/admin/permits/${id}`
      const res = await fetch(path, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      })
      if (res.status === 401) {
        setError('That admin token was rejected — check it and try again.')
        return
      }
      if (!res.ok) throw new Error(await readError(res))
      if (which === 'reports') setReports((rs) => (rs ?? []).filter((r) => r.id !== id))
      else setPermits((ps) => (ps ?? []).filter((p) => p.id !== id))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong deleting that record.')
    } finally {
      setBusyId(null)
    }
  }

  // Inline editing - a card in edit mode swaps its <dl> for a small form;
  // Save PATCHes only the fields that changed, Cancel just drops the draft.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Record<string, unknown>>({})

  function startEdit(record: Record<string, unknown>) {
    setEditingId(record.id as string)
    setDraft({ ...record })
    setError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setDraft({})
  }

  async function saveEdit(which: Tab, id: string) {
    setBusyId(id)
    setError(null)
    try {
      const path = which === 'reports' ? `/api/admin/reports/${id}` : `/api/admin/permits/${id}`
      // species_known is normalized here, unconditionally, rather than only
      // inside the species input's own onChange - draft starts as a raw
      // copy of the existing record (startEdit), so if that record already
      // had an inconsistent species_name/species_known pair (as some rows
      // did from before that onChange existed) and the person saves without
      // happening to touch the species field this time, the stale flag
      // would otherwise ride along unchanged and the public popup would
      // keep hiding a species name that's sitting right there in the data.
      // Deriving it fresh on every save closes that gap for good, and
      // self-heals any row like that the next time it's edited at all.
      const body: Record<string, unknown> = { ...draft }
      if (which === 'reports') {
        body.species_known = String(body.species_name ?? '').trim() ? 1 : 0
      }
      const res = await fetch(path, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.status === 401) {
        setError('That admin token was rejected — check it and try again.')
        return
      }
      if (!res.ok) throw new Error(await readError(res))
      if (which === 'reports') {
        setReports((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, ...body } as PendingReport : r)))
      } else {
        setPermits((ps) => (ps ?? []).map((p) => (p.id === id ? { ...p, ...body } as PendingPermit : p)))
      }
      setEditingId(null)
      setDraft({})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong saving those changes.')
    } finally {
      setBusyId(null)
    }
  }

  function draftField(key: string, value: unknown) {
    setDraft((d) => ({ ...d, [key]: value }))
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
                    {editingId === r.id ? (
                      <div className="admin-edit-form">
                        <label>
                          Species
                          <input
                            value={(draft.species_name as string) ?? ''}
                            onChange={(e) => {
                              // A typed name is meaningless while species_known
                              // stays 0 - every view (this page and the public
                              // map) hides species_name whenever that flag is
                              // unset, so the edit would silently look like it
                              // never saved. Derive the flag from the text
                              // instead of adding a second control to keep in
                              // sync with it.
                              draftField('species_name', e.target.value)
                              draftField('species_known', e.target.value.trim() ? 1 : 0)
                            }}
                          />
                        </label>
                        <label>
                          Trunk (cm)
                          <input
                            type="number"
                            value={(draft.trunk_measure_cm as number) ?? ''}
                            onChange={(e) => draftField('trunk_measure_cm', e.target.value === '' ? null : Number(e.target.value))}
                          />
                        </label>
                        <label>
                          Reason
                          <input
                            value={(draft.felling_reason as string) ?? ''}
                            onChange={(e) => draftField('felling_reason', e.target.value)}
                          />
                        </label>
                        <label>
                          Notes
                          <textarea
                            value={(draft.notes as string) ?? ''}
                            onChange={(e) => draftField('notes', e.target.value)}
                          />
                        </label>
                        <label>
                          Latitude
                          <input
                            type="number"
                            step="any"
                            value={(draft.lat as number) ?? ''}
                            onChange={(e) => draftField('lat', Number(e.target.value))}
                          />
                        </label>
                        <label>
                          Longitude
                          <input
                            type="number"
                            step="any"
                            value={(draft.lon as number) ?? ''}
                            onChange={(e) => draftField('lon', Number(e.target.value))}
                          />
                        </label>
                        <div className="admin-actions">
                          <button className="approve" disabled={busyId === r.id} onClick={() => saveEdit('reports', r.id)}>
                            Save
                          </button>
                          <button className="reject" disabled={busyId === r.id} onClick={cancelEdit}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
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
                            <button className="reject" disabled={busyId === r.id} onClick={() => remove('reports', r.id)}>
                              Delete
                            </button>
                          )}
                          <button className="edit" disabled={busyId === r.id} onClick={() => startEdit(r)}>
                            Edit
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {tab === 'permits' && (
            <div className="admin-subtabs">
              <button className={permitsView === 'pending' ? 'active' : ''} onClick={() => setPermitsView('pending')}>
                Pending
              </button>
              <button className={permitsView === 'approved' ? 'active' : ''} onClick={() => setPermitsView('approved')}>
                Live on the map
              </button>
            </div>
          )}

          {tab === 'permits' && (
            <ul className="admin-list">
              {permits && permits.length === 0 && !loading && (
                <li className="hint">{permitsView === 'pending' ? 'Nothing pending review.' : 'Nothing live right now.'}</li>
              )}
              {permits?.map((p) => (
                <li key={p.id} className="admin-card">
                  <div className="admin-card-body">
                    <div className="admin-card-title">
                      {p.title}
                      {p.tier === 'tier3' && <span className="tier3-badge">Tier 3 · attachment scan</span>}
                    </div>
                    {editingId === p.id ? (
                      <div className="admin-edit-form">
                        <label>
                          Title
                          <input
                            value={(draft.title as string) ?? ''}
                            onChange={(e) => draftField('title', e.target.value)}
                          />
                        </label>
                        <label>
                          Trees
                          <input
                            type="number"
                            value={(draft.tree_count as number) ?? ''}
                            onChange={(e) => draftField('tree_count', e.target.value === '' ? null : Number(e.target.value))}
                          />
                        </label>
                        <label>
                          Species
                          <input
                            value={(draft.species as string) ?? ''}
                            onChange={(e) => draftField('species', e.target.value)}
                          />
                        </label>
                        <label>
                          Reason
                          <input
                            value={(draft.reason as string) ?? ''}
                            onChange={(e) => draftField('reason', e.target.value)}
                          />
                        </label>
                        <label>
                          Address
                          <input
                            value={(draft.address as string) ?? ''}
                            onChange={(e) => draftField('address', e.target.value)}
                          />
                        </label>
                        <div className="admin-actions">
                          <button className="approve" disabled={busyId === p.id} onClick={() => saveEdit('permits', p.id)}>
                            Save
                          </button>
                          <button className="reject" disabled={busyId === p.id} onClick={cancelEdit}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
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
                          {permitsView === 'pending' ? (
                            <>
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
                            </>
                          ) : (
                            <button className="reject" disabled={busyId === p.id} onClick={() => remove('permits', p.id)}>
                              Delete
                            </button>
                          )}
                          <button className="edit" disabled={busyId === p.id} onClick={() => startEdit(p)}>
                            Edit
                          </button>
                        </div>
                      </>
                    )}
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
