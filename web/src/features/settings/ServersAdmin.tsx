// The managed-server list: rename, set the default, hide, and forget.
//
// Three groups in one table because they are three states of the same thing, and which group a row
// is in decides what you can do with it. "Stale" means the container is gone — those are the only
// rows that can be forgotten for good.

import { api, currentServer, setCurrentServer } from '../../api/client'
import type { ServerRow, ServersResponse, StaleServerRow } from '../../api/types'
import { Card } from '../../components/Card'

type RowKind = 'active' | 'hidden' | 'stale'

function StateBadge({ state }: { state: string }) {
  const cls = state === 'running' ? 'badge-gm' : state === 'missing' ? 'badge-banned' : 'badge-none'
  return <span className={'badge ' + cls} style={{ fontSize: '.7rem' }}>{state}</span>
}

export function ServersAdmin({ servers, onChanged }: {
  servers: ServersResponse | null
  onChanged: () => void
}) {
  const active = servers?.servers ?? []
  const hidden = servers?.hidden ?? []
  const stale = servers?.stale ?? []
  const defaultId = servers?.default ?? ''

  const all: (ServerRow | StaleServerRow)[] = [...active, ...hidden, ...stale]
  const find = (id: string) => all.find(s => s.id === id)

  const put = async (id: string, body: Record<string, unknown>) => {
    try {
      await api.put('/api/servers/' + encodeURIComponent(id), body)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed')
      return false
    }
    // The selection may have just been renamed out from under us.
    if (typeof body.id === 'string' && currentServer() === id) {
      setCurrentServer(body.id)
      return true
    }
    onChanged()
    return true
  }

  const edit = async (id: string) => {
    const s = find(id)
    if (!s) return
    const name = prompt('Display name for "' + s.container + '":', s.name)
    if (name === null) return
    const connect = prompt('Connect address (host:port), blank for none:', ('connect' in s ? s.connect : '') || '')
    if (connect === null) return
    await put(id, { name, connect })
  }

  const setHidden = async (id: string, hide: boolean) => {
    if (hide && !confirm('Hide this server from the picker? Nothing is deleted — unhide it here any time.')) return
    const ok = await put(id, { hidden: hide })
    // Hiding the server currently being viewed leaves the picker pointing at nothing.
    if (ok && hide && currentServer() === id) location.reload()
  }

  const forget = async (id: string) => {
    const s = find(id)
    if (!s) return
    if (!confirm('Forget "' + s.name + '"?\n\nThis only removes it from this manager\'s list. No container, world save or file is touched.')) return
    try {
      await api.del('/api/servers/' + encodeURIComponent(id))
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed')
      return
    }
    if (currentServer() === id) {
      try { localStorage.removeItem('pz-mgr-server') } catch { /* private mode */ }
      location.reload()
      return
    }
    onChanged()
  }

  const row = (s: ServerRow | StaleServerRow, kind: RowKind) => {
    const notes: string[] = []
    if (kind === 'active' && s.id === defaultId) notes.push('default')
    if ('discovered' in s && s.discovered) notes.push('auto-detected')
    if (kind === 'active' && 'managed' in s && !s.managed) notes.push('data not mounted — control only')
    if (kind === 'stale') notes.push('container no longer exists')

    return (
      <tr key={kind + s.id}>
        <td>
          {s.name}
          {notes.length > 0 && (
            <div style={{ fontSize: '.7rem', color: 'var(--muted)' }}>{notes.join(' · ')}</div>
          )}
        </td>
        <td style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem' }}>{s.container}</td>
        <td style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem' }}>{s.id}</td>
        <td style={{ fontFamily: 'var(--font-mono)', fontSize: '.78rem' }}>
          {('connect' in s ? s.connect : '') || '—'}
        </td>
        <td><StateBadge state={'state' in s ? s.state : 'missing'} /></td>
        <td style={{ whiteSpace: 'nowrap' }}>
          {kind === 'active' && (
            <>
              <button className="btn-secondary btn-sm" onClick={() => edit(s.id)}>Edit</button>{' '}
              {s.id !== defaultId && (
                <>
                  <button className="btn-secondary btn-sm" onClick={() => put(s.id, { makeDefault: true })}>
                    Make default
                  </button>{' '}
                </>
              )}
              {active.length > 1 && (
                <button className="btn-secondary btn-sm" onClick={() => setHidden(s.id, true)}>Hide</button>
              )}
            </>
          )}
          {kind === 'hidden' && (
            <button className="btn-secondary btn-sm" onClick={() => setHidden(s.id, false)}>Unhide</button>
          )}
          {kind === 'stale' && (
            <button className="btn-danger btn-sm" onClick={() => forget(s.id)}>Forget</button>
          )}
        </td>
      </tr>
    )
  }

  const rescan = async () => {
    try { await api.post('/api/servers/refresh') } catch { /* keep whatever is listed */ }
    onChanged()
  }

  return (
    <Card
      id="settings-servers"
      title="Managed Servers"
      aside={<button className="btn-secondary btn-sm" onClick={e => { e.preventDefault(); void rescan() }}>Re-scan</button>}
    >
      <p style={{ fontSize: '.78rem', color: 'var(--muted)', margin: '.8rem 0 .9rem' }}>
        PZ containers are detected automatically. Rename them, pick the default, hide the ones you
        don't manage here, and forget leftovers from servers that no longer exist.
      </p>

      <table>
        <thead>
          <tr><th>Name</th><th>Container</th><th>ID</th><th>Connect</th><th>State</th><th /></tr>
        </thead>
        <tbody>
          {active.length + hidden.length + stale.length === 0
            ? <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>No PZ containers found.</td></tr>
            : (
              <>
                {active.map(s => row(s, 'active'))}
                {hidden.map(s => row(s, 'hidden'))}
                {stale.map(s => row(s, 'stale'))}
              </>
            )}
        </tbody>
      </table>

      {stale.length > 0 && (
        <p style={{ fontSize: '.78rem', color: 'var(--muted)', marginTop: '.6rem' }}>
          Entries marked <em>container no longer exists</em> are leftovers from a removed server.
          Forget them to clear the list.
        </p>
      )}
    </Card>
  )
}
