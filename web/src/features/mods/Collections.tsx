// Tracked Workshop collections, and the mods a curator has dropped from one.
//
// Syncing is additive and needs no confirmation: it installs what is new and reports what the
// curator dropped, but never deletes. Pulling a mod out from under a running server desyncs every
// connected client, and a mod vanishing as a side effect of "check for updates" is
// indistinguishable from the server eating someone's save.

import { useMemo, useState } from 'react'
import { api } from '../../api/client'
import { useApi } from '../../api/hooks'
import type { AutoSync, Collection, CollectionsResponse, DroppedMod } from '../../api/types'
import { Card } from '../../components/Card'
import { Empty, SortHeader } from '../../components/ui'

type SortKey = 'title' | 'missing' | 'synced'

const INTERVALS: [number, string][] = [[6, '6h'], [12, '12h'], [24, '24h'], [48, '48h'], [168, '7d']]

export function Collections({ onChanged, onMessage }: {
  onChanged: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
}) {
  const { data, reload } = useApi<CollectionsResponse>('/api/collections')
  const autosync = useApi<AutoSync>('/api/collections/autosync')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'title', dir: 1 })
  const [busy, setBusy] = useState(false)

  const colls = data?.collections ?? []

  const sorted = useMemo(() => [...colls].sort((a, b) => {
    const av = sort.key === 'missing' ? a.missingCount
      : sort.key === 'synced' ? (a.lastSynced ?? '')
        : (a.title || a.id).toLowerCase()
    const bv = sort.key === 'missing' ? b.missingCount
      : sort.key === 'synced' ? (b.lastSynced ?? '')
        : (b.title || b.id).toLowerCase()
    if (av < bv) return -sort.dir
    if (av > bv) return sort.dir
    return 0
  }), [colls, sort])

  const onSort = (key: SortKey) =>
    setSort(s => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))

  const sync = async (id: string) => {
    onMessage('Syncing collection ' + id + '...', 'info')
    setBusy(true)
    try {
      const r = await api.post<{ queued: number; dropped: number; total: number }>('/api/collections/' + id + '/sync')
      const bits: string[] = []
      if (r.queued) bits.push('queued ' + r.queued + ' new/missing mod(s)')
      if (r.dropped) bits.push(r.dropped + ' mod(s) dropped by the curator and still installed — remove them above')
      onMessage(
        bits.length
          ? 'Sync: ' + bits.join('; ') + '. Restart to apply.'
          : 'Already up to date — all ' + r.total + ' mod(s) present.',
        'success',
      )
      reload()
      onChanged()
    } catch (e) {
      onMessage('Sync failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setBusy(false) }
  }

  const syncAll = async () => {
    if (!colls.length) return onMessage('No collections to sync.', 'info')
    onMessage('Syncing ' + colls.length + ' collection(s)...', 'info')
    setBusy(true)
    let queued = 0
    let dropped = 0
    // Sequential rather than parallel: each sync resolves nested collections against Steam, and
    // firing ten at once is how you get rate-limited into a half-synced state.
    for (const c of colls) {
      try {
        const r = await api.post<{ queued?: number; dropped?: number }>('/api/collections/' + c.id + '/sync')
        queued += r.queued ?? 0
        dropped += r.dropped ?? 0
      } catch { /* one failure must not abandon the rest */ }
    }
    const bits: string[] = []
    if (queued) bits.push('queued ' + queued + ' new/missing mod(s)')
    if (dropped) bits.push(dropped + ' dropped mod(s) awaiting removal')
    onMessage(
      bits.length ? 'Sync complete — ' + bits.join(', ') + '. Restart to apply.' : 'All collections already up to date.',
      'success',
    )
    setBusy(false)
    reload()
    onChanged()
  }

  const remove = async (c: Collection) => {
    const removeMods = confirm(
      'Stop tracking this collection.\n\n' +
      'OK = also delete its mods (ones no other tracked collection uses)\n' +
      'Cancel = keep the mods installed',
    )
    try {
      const r = await api.del<{ removedMods?: number }>('/api/collections/' + c.id + '?removeMods=' + removeMods)
      onMessage('Collection removed' + (r.removedMods ? ' along with ' + r.removedMods + ' mod(s)' : '') + '.', 'success')
      reload()
      onChanged()
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const saveAutoSync = async (enabled: boolean, intervalHours: number) => {
    try {
      await api.put('/api/collections/autosync', { enabled, intervalHours })
      // Auto-sync only ever installs and reports, so there is no destructive caveat to add here.
      onMessage(enabled ? 'Auto-sync on — checking every ' + intervalHours + 'h.' : 'Auto-sync off.', 'success')
      autosync.reload()
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const autoCfg = autosync.data

  return (
    <Card id="mods-collections" title="Collections">
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        margin: '.9rem 0', gap: '1rem', flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '.45rem', cursor: 'pointer', fontSize: '.8rem', color: 'var(--muted)' }}>
            <input
              type="checkbox"
              checked={!!autoCfg?.enabled}
              onChange={e => saveAutoSync(e.target.checked, autoCfg?.intervalHours ?? 24)}
            /> Auto-sync every
          </label>
          <select
            className="server-select"
            style={{ width: 'auto', margin: 0, padding: '.3rem .5rem', fontSize: '.8rem' }}
            value={String(autoCfg?.intervalHours ?? 24)}
            onChange={e => saveAutoSync(!!autoCfg?.enabled, parseInt(e.target.value, 10))}
          >
            {INTERVALS.map(([h, label]) => <option key={h} value={h}>{label}</option>)}
          </select>
          <button className="btn-secondary btn-sm" onClick={syncAll} disabled={busy}>Sync All Now</button>
        </div>
      </div>

      {!colls.length ? (
        <Empty>No collections tracked. Add one above to install and keep it in sync.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <SortHeader label="Collection" column="title" sort={sort} onSort={onSort} />
              <SortHeader label="Mods" column="missing" sort={sort} onSort={onSort} />
              <SortHeader label="Last Synced" column="synced" sort={sort} onSort={onSort} />
              <th title="Mods the curator dropped that are still installed here. Syncing reports them; it never deletes them.">
                Dropped
              </th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map(c => (
              <tr key={c.id}>
                <td>
                  <div>{c.title || <span className="text-muted">(unknown)</span>}</div>
                  <a
                    href={'https://steamcommunity.com/sharedfiles/filedetails/?id=' + c.id}
                    target="_blank" rel="noreferrer" className="mono" style={{ fontSize: '.72rem', opacity: .7 }}
                  >{c.id}</a>
                </td>
                <td>
                  <span style={{ color: c.missingCount > 0 ? '#e74c3c' : '#2ecc71' }}>
                    {c.installedCount}/{c.itemCount}
                  </span>
                  <br />
                  <span style={{ fontSize: '.72rem', color: 'var(--muted)' }}>installed</span>
                </td>
                <td className="text-muted" style={{ fontSize: '.76rem' }}>
                  {c.lastSynced ? new Date(c.lastSynced).toLocaleString() : '—'}
                </td>
                <td>
                  {c.droppedItems?.length
                    ? <span style={{ color: '#f5a623', fontSize: '.78rem' }}>{c.droppedItems.length} awaiting removal</span>
                    : <span className="text-muted" style={{ fontSize: '.78rem' }}>—</span>}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn-secondary btn-sm" disabled={busy} onClick={() => sync(c.id)}>Sync</button>{' '}
                  <button className="btn-danger btn-sm" disabled={busy} onClick={() => remove(c)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  )
}

/**
 * Mods the curator removed from the collection that installed them.
 *
 * Sits above everything else on the Mods tab, because it is the one thing on that page the server
 * is actively wrong about: these are still loaded. Renders nothing at all when there is nothing
 * outstanding — no empty-state card taking up the top of the page.
 */
export function DroppedMods({ onChanged, onMessage, onRestart }: {
  onChanged: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
  onRestart: () => void
}) {
  const { data, reload } = useApi<{ dropped: DroppedMod[] }>('/api/collections/dropped')
  const dropped = data?.dropped ?? []
  if (!dropped.length) return null

  const remove = async (id: string) => {
    if (!confirm('Remove Workshop item ' + id + '?\n\nThe files go now. The server keeps loading it until you restart.')) return
    try {
      await api.del('/api/mods/' + id)
      onMessage('Removed ' + id + '. Restart to apply.', 'success')
      reload()
      onChanged()
    } catch (e) {
      onMessage('Could not remove ' + id + ': ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  // Keeping only clears the report. The files are untouched — this is the "the curator dropped it
  // but I still want it" case, which would otherwise be re-reported on every sync.
  const keep = async (id: string) => {
    await api.post('/api/collections/dropped/' + id + '/keep').catch(() => {})
    reload()
  }

  return (
    <div className="card" style={{ marginBottom: '1.4rem', borderLeft: '3px solid #f5a623' }}>
      <div className="card-title" style={{ marginBottom: '.5rem' }}>
        {dropped.length} mod(s) dropped from their collection
      </div>
      <p style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: '.9rem' }}>
        The curator removed these from the collection that installed them. Nothing was deleted here — they are
        still on disk and the server is <strong>still loading them</strong>. Remove the ones you do not want, then
        restart to apply. <em>Keep</em> leaves a mod installed and stops it being reported.
      </p>

      <table>
        <thead><tr><th>Workshop ID</th><th>Dropped by</th><th /></tr></thead>
        <tbody>
          {dropped.map(m => (
            <tr key={m.id}>
              <td>
                <a
                  href={'https://steamcommunity.com/sharedfiles/filedetails/?id=' + m.id}
                  target="_blank" rel="noreferrer" className="mono" style={{ fontSize: '.78rem' }}
                >{m.id}</a>
              </td>
              <td className="text-muted" style={{ fontSize: '.78rem' }}>{m.collectionTitle || m.collectionId}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button className="btn-danger btn-sm" onClick={() => remove(m.id)}>Remove</button>{' '}
                <button className="btn-secondary btn-sm" onClick={() => keep(m.id)}>Keep</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '.9rem' }}>
        <button className="btn-warn btn-sm" onClick={onRestart}>Restart Server</button>
      </div>
    </div>
  )
}
