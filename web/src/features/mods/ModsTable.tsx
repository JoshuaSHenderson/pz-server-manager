// The installed-mods table.
//
// A Workshop item can ship several mod ids — variant packs do it routinely — and Mods= decides
// which of them the server actually loads. So each row lists every id with its own checkbox and
// its own load position, rather than offering only to delete the whole item.

import { useMemo, useState } from 'react'
import { api } from '../../api/client'
import type { ActiveDownload, Mod } from '../../api/types'
import { Card } from '../../components/Card'
import { Empty, SortHeader } from '../../components/ui'

type SortKey = 'title' | 'order' | 'modIds' | 'tags' | 'collection' | 'status'

// "Build 41"/"Build 42" ride along on almost every Workshop item, so they are noise for grouping by
// type. Kept out of the Type column and the dropdown; the filter box still matches them.
const BUILD_TAG = /^build\s*4[12]$/i
const displayTags = (m: Mod) => m.tags.filter(t => !BUILD_TAG.test(t))

const STATUS_ORDER: Record<string, number> = { missing: 0, collection: 1, ok: 2 }

function sortValue(m: Mod, key: SortKey): string {
  switch (key) {
    case 'title': return (m.title || '').toLowerCase()
    case 'modIds': return (m.modIds[0] || '').toLowerCase()
    // Zero-padded so the string comparator sorts it numerically; blank for mods that are not
    // loaded, which sinks them to the bottom like every other blank.
    case 'order': return m.minOrder ? String(m.minOrder).padStart(6, '0') : ''
    case 'tags': return displayTags(m).join(', ').toLowerCase()
    case 'collection': return m.collections.map(c => (c.title || c.id).toLowerCase()).sort().join(', ')
    case 'status': return String(STATUS_ORDER[m.status] ?? 9)
  }
}

export function ModsTable({ mods, active, loading, onChanged, onMessage, onReinstall }: {
  mods: Mod[]
  active: ActiveDownload[]
  loading: boolean
  onChanged: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
  onReinstall: (workshopId: string) => void
}) {
  const [filter, setFilter] = useState('')
  const [type, setType] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'title', dir: 1 })
  const [busyId, setBusyId] = useState<string | null>(null)

  const problems = mods.filter(m => m.status === 'missing')
  const byId = useMemo(() => new Map(active.map(a => [a.workshopId, a])), [active])

  // Rebuilt from whatever tags Steam actually returned for this mod set, so the dropdown never
  // offers a type nothing here has.
  const types = useMemo(() => {
    const seen = new Map<string, number>()
    for (const m of mods) for (const t of displayTags(m)) seen.set(t, (seen.get(t) ?? 0) + 1)
    return [...seen.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [mods])

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    let list = f
      ? mods.filter(m =>
        (m.title || '').toLowerCase().includes(f) ||
        m.workshopId.includes(f) ||
        m.modIds.join(' ').toLowerCase().includes(f) ||
        m.tags.join(' ').toLowerCase().includes(f) ||
        m.collections.some(c => (c.title || '').toLowerCase().includes(f) || c.id.includes(f)))
      : mods
    if (type) list = list.filter(m => displayTags(m).includes(type))

    return [...list].sort((a, b) => {
      const av = sortValue(a, sort.key)
      const bv = sortValue(b, sort.key)
      // Blanks always sink, whichever way the column is sorted.
      if (av === '' && bv !== '') return 1
      if (bv === '' && av !== '') return -1
      if (av < bv) return -sort.dir
      if (av > bv) return sort.dir
      return (a.title || '').toLowerCase().localeCompare((b.title || '').toLowerCase())
    })
  }, [mods, filter, type, sort])

  const onSort = (key: SortKey) =>
    setSort(s => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: 1 }))

  const toggle = async (modId: string, enabled: boolean) => {
    setBusyId(modId)
    try {
      await api.post('/api/mods/enabled', { modId, enabled })
      onChanged()
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    } finally { setBusyId(null) }
  }

  const retry = async (workshopId: string) => {
    await api.post('/api/mods/retry', { workshopId }).catch(() => {})
    onMessage('Re-queued ' + workshopId + '.', 'info')
    onChanged()
  }

  const remove = async (m: Mod) => {
    const label = m.title || m.workshopId
    if (!confirm('Remove "' + label + '"?\n\nIts mod folders are deleted and its ids are dropped from the load order. Players will need to restart their game.')) return
    try {
      await api.del('/api/mods/' + m.workshopId)
      onMessage('Removed ' + label + '.', 'success')
      onChanged()
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const repair = async () => {
    try {
      const r = await api.post<{ repaired: number; collections: number }>('/api/mods/repair')
      onMessage('Re-queued ' + r.repaired + ' mod(s)' + (r.collections ? ', expanded ' + r.collections + ' collection(s)' : '') + '.', 'success')
      onChanged()
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const okCount = mods.filter(m => m.status === 'ok').length
  const narrowed = !!(filter || type)

  return (
    <Card
      id="mods-installed"
      title="Installed Mods"
      aside={
        <span className="text-muted" style={{ fontSize: '.8rem', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
          {okCount} installed
          {problems.length ? ' · ' + problems.length + ' broken' : ''}
          {narrowed ? ' · ' + shown.length + ' shown' : ''}
        </span>
      }
    >
      {/* Filter controls live in the body, not the summary: a form control inside a <summary>
          toggles the panel when clicked. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '.7rem', flexWrap: 'wrap', margin: '.9rem 0' }}>
        <input
          type="text"
          placeholder="Filter by name, ID, tag, collection..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ width: 220, padding: '.35rem .55rem', fontSize: '.82rem' }}
        />
        <select
          className="server-select"
          style={{ width: 'auto', margin: 0, padding: '.35rem .5rem', fontSize: '.82rem' }}
          title="Filter by Workshop tag"
          value={type}
          onChange={e => setType(e.target.value)}
        >
          <option value="">All types</option>
          {types.map(([t, n]) => <option key={t} value={t}>{t} ({n})</option>)}
        </select>
      </div>

      {problems.length > 0 && (
        <div className="msg msg-error" style={{
          marginBottom: '1rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: '1rem', flexWrap: 'wrap',
        }}>
          <span>
            <strong>{problems.length} mod{problems.length > 1 ? 's are' : ' is'} registered but missing files.</strong>{' '}
            <span style={{ fontSize: '.8rem', opacity: .85 }}>
              The server can't load these. Repair re-downloads them and expands any that turn out to be collections.
            </span>
          </span>
          <button className="btn-primary btn-sm" onClick={repair}>Repair All</button>
        </div>
      )}

      {loading && !mods.length ? <Empty>Loading...</Empty>
        : !shown.length ? <Empty>{narrowed ? 'No mods match the current filter' : 'No mods installed'}</Empty>
          : (
            <table>
              <thead>
                <tr>
                  <SortHeader label="Mod" column="title" sort={sort} onSort={onSort} />
                  <SortHeader label="Load order" column="order" sort={sort} onSort={onSort} />
                  <SortHeader label="Mod IDs (tick = loaded)" column="modIds" sort={sort} onSort={onSort} />
                  <SortHeader label="Type" column="tags" sort={sort} onSort={onSort} />
                  <SortHeader label="Collection" column="collection" sort={sort} onSort={onSort} />
                  <SortHeader label="Status" column="status" sort={sort} onSort={onSort} />
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map(m => (
                  <ModRow
                    key={m.workshopId}
                    mod={m}
                    live={byId.get(m.workshopId)}
                    busyId={busyId}
                    onToggle={toggle}
                    onRetry={retry}
                    onRemove={remove}
                    onReinstall={onReinstall}
                    onPickType={setType}
                  />
                ))}
              </tbody>
            </table>
          )}
    </Card>
  )
}

function ModRow({ mod: m, live, busyId, onToggle, onRetry, onRemove, onReinstall, onPickType }: {
  mod: Mod
  live: ActiveDownload | undefined
  busyId: string | null
  onToggle: (id: string, enabled: boolean) => void
  onRetry: (id: string) => void
  onRemove: (m: Mod) => void
  onReinstall: (id: string) => void
  onPickType: (t: string) => void
}) {
  const workshopUrl = 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + m.workshopId
  const tags = displayTags(m)

  return (
    <tr>
      <td>
        <div>{m.title || <span className="text-muted">(unknown title)</span>}</div>
        <a href={workshopUrl} target="_blank" rel="noreferrer" className="mono" style={{ fontSize: '.72rem', opacity: .7 }}>
          {m.workshopId}
        </a>
      </td>

      <td style={{ whiteSpace: 'nowrap' }}>
        {m.orderPositions.length ? (
          <>
            <span className="mono" style={{ fontSize: '.78rem' }}>{m.orderPositions.join(', ')}</span>
            <div style={{ fontSize: '.65rem', color: 'var(--muted)' }}>of {m.loadOrderTotal}</div>
          </>
        ) : <span style={{ fontSize: '.72rem', color: 'var(--muted)' }}>—</span>}
      </td>

      <td>
        {m.modIds.length ? m.modIds.map(id => {
          const on = m.enabledIds.includes(id)
          const pos = on ? m.orderPositions[m.enabledIds.indexOf(id)] : undefined
          return (
            <label
              key={id}
              style={{ display: 'flex', alignItems: 'center', gap: '.4rem', fontSize: '.75rem', cursor: 'pointer', opacity: on ? 1 : .5 }}
              title={on ? 'Loaded by the server' + (pos ? ' at load position ' + pos : '') : 'Installed but not loaded'}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={busyId === id}
                onChange={e => onToggle(id, e.target.checked)}
              />
              <span className="mono">{id}</span>
              {pos ? <span className="mono" style={{ fontSize: '.65rem', color: 'var(--muted)' }}>#{pos}</span> : null}
            </label>
          )
        }) : <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>—</span>}
      </td>

      <td style={{ maxWidth: 200 }}>
        {tags.length ? tags.map(t => (
          <span
            key={t}
            onClick={() => onPickType(t)}
            title={'Show only ' + t}
            style={{
              display: 'inline-block', cursor: 'pointer', fontSize: '.68rem', padding: '.1rem .4rem',
              margin: '.1rem .2rem .1rem 0', borderRadius: 3, background: 'var(--bg)',
              border: '1px solid var(--border)', color: 'var(--muted)',
            }}
          >{t}</span>
        )) : <span style={{ fontSize: '.72rem', color: 'var(--muted)' }}>—</span>}
      </td>

      <td>
        {m.collections.length ? m.collections.map(c => (
          <div key={c.id}>
            <a
              href={'https://steamcommunity.com/sharedfiles/filedetails/?id=' + c.id}
              target="_blank" rel="noreferrer"
              style={{ fontSize: '.75rem', color: '#60a5fa', textDecoration: 'none' }}
            >{c.title || c.id}</a>
          </div>
        )) : <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>standalone</span>}
      </td>

      <td>
        {live ? (
          <span style={{ color: '#60a5fa' }}>
            {live.status === 'downloading' && live.total > 0 ? 'Downloading ' + live.pct + '%' : 'Queued'}
          </span>
        ) : m.status === 'missing' ? (
          <>
            <span style={{ color: '#e74c3c' }}>Missing files</span><br />
            <button className="btn-secondary btn-sm" style={{ marginTop: '.3rem' }} onClick={() => onRetry(m.workshopId)}>
              Re-download
            </button>
          </>
        ) : m.status === 'collection'
          ? <span style={{ color: '#60a5fa' }}>Collection</span>
          : <span style={{ color: '#2ecc71' }}>OK</span>}
      </td>

      <td style={{ whiteSpace: 'nowrap' }}>
        <button
          className="btn-secondary btn-sm"
          title="Delete this item and download it again from Steam"
          onClick={() => onReinstall(m.workshopId)}
        >Reinstall</button>{' '}
        <button className="btn-danger btn-sm" onClick={() => onRemove(m)}>Remove</button>
      </td>
    </tr>
  )
}
