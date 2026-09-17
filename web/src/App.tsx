// The shell: the sidebar, the server picker, and which tab is showing.
//
// Two things it owns that the old UI spread across module scope:
//
//   - The selected server. If the saved selection no longer exists (a removed container, a renamed
//     id, a server that has been hidden), it falls back to the default rather than leaving every
//     request pointed at an id that will never resolve.
//   - Which tab is mounted. Only the active tab's components exist, so a tab's polling starts when
//     it is opened and stops when it is left. The old UI kept every pane in the DOM and started
//     four polls at page load regardless — including one that reads every mod.info on disk and
//     calls Steam.

import { useCallback, useEffect, useState } from 'react'
import { api, currentServer, isAuthenticated, setCurrentServer, setUnauthenticatedHandler } from './api/client'
import type { ServersResponse } from './api/types'
import { Login } from './components/Login'
import {
  BackupsIcon, ConfigIcon, DashboardIcon, LogsIcon, ModsIcon, PlayersIcon, SettingsIcon,
} from './components/Icons'
import { Dashboard } from './features/dashboard/Dashboard'
import { Mods } from './features/mods/Mods'
import { Players } from './features/players/Players'
import { Logs } from './features/logs/Logs'
import { Config } from './features/config/Config'
import { Backups } from './features/backups/Backups'
import { Settings } from './features/settings/Settings'

export const TABS = [
  { id: 'dashboard', label: 'Dashboard', Icon: DashboardIcon },
  { id: 'mods', label: 'Mods', Icon: ModsIcon },
  { id: 'players', label: 'Players', Icon: PlayersIcon },
  { id: 'logs', label: 'Logs', Icon: LogsIcon },
  { id: 'config', label: 'Config', Icon: ConfigIcon },
  { id: 'backups', label: 'Backups', Icon: BackupsIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon },
] as const

export type TabId = (typeof TABS)[number]['id']

function tabFromHash(): TabId {
  const id = location.hash.slice(1)
  return TABS.some(t => t.id === id) ? id as TabId : 'dashboard'
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const [tab, setTab] = useState<TabId>(tabFromHash)
  const [servers, setServers] = useState<ServersResponse | null>(null)
  const [detecting, setDetecting] = useState(false)

  // A 401 from anywhere drops straight back to the login form.
  useEffect(() => setUnauthenticatedHandler(() => setAuthed(false)), [])

  useEffect(() => { void isAuthenticated().then(setAuthed) }, [])

  const loadServers = useCallback(async () => {
    try {
      const data = await api.get<ServersResponse>('/api/servers')
      setServers(data)
      // The saved selection no longer exists: fall back to the default rather than leaving every
      // request pointed at an id the API will keep rejecting.
      const selected = currentServer()
      if (selected && !data.servers.some(s => s.id === selected)) {
        if (data.default) setCurrentServer(data.default)
        else { try { localStorage.removeItem('pz-mgr-server') } catch { /* private mode */ } }
      }
    } catch { /* the shell still renders; the panes report their own failures */ }
  }, [])

  useEffect(() => { if (authed) void loadServers() }, [authed, loadServers])

  // A tab is linkable, which is how the phone screenshots get taken, and it survives a refresh.
  useEffect(() => {
    if (location.hash !== '#' + tab) history.replaceState(null, '', '#' + tab)
  }, [tab])

  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    addEventListener('hashchange', onHash)
    return () => removeEventListener('hashchange', onHash)
  }, [])

  const detect = async () => {
    setDetecting(true)
    try {
      await api.post('/api/servers/refresh')
      await loadServers()
    } catch { /* the picker keeps whatever it already had */ } finally { setDetecting(false) }
  }

  if (authed === null) return null            // one frame, rather than a flash of the login form
  if (!authed) return <Login onSignedIn={() => setAuthed(true)} />

  const selected = currentServer()
  const active = servers?.servers.find(s => s.id === selected) ?? servers?.servers[0]

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><img src="/server-icon.png" alt="Server icon" /></div>
          <div className="logo">PZ Server<small>Manager // Ops</small></div>
        </div>

        <StatusBadge />

        <div style={{ display: 'flex', gap: '.4rem', alignItems: 'center' }}>
          <select
            className="server-select"
            style={{ flex: 1 }}
            title="Managed server"
            value={selected || active?.id || ''}
            onChange={e => setCurrentServer(e.target.value)}
          >
            {servers?.servers.length
              ? servers.servers.map(s => (
                <option key={s.id} value={s.id}>{(s.state === 'running' ? '' : '○ ') + s.name}</option>
              ))
              : <option value="">no servers detected</option>}
          </select>
          <button
            className="btn-secondary btn-sm"
            onClick={detect}
            disabled={detecting}
            title="Detect new servers"
            style={{ padding: '.4rem .55rem' }}
          >{detecting ? '...' : '⟳'}</button>
        </div>

        <nav>
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={'tab-btn' + (tab === id ? ' active' : '')}
              onClick={() => setTab(id)}
            >
              <Icon />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          LAN <span className="mono-val">{active?.connect || '—'}</span><br />
          World <span className="mono-val">servertest</span>
        </div>
      </aside>

      <main>
        {/* Only the open tab is mounted, so only its polling runs. */}
        {tab === 'dashboard' && <Dashboard connect={active?.connect || ''} onGoToTab={setTab} />}
        {tab === 'mods' && <Mods />}
        {tab === 'players' && <Players />}
        {tab === 'logs' && <Logs />}
        {tab === 'config' && <Config />}
        {tab === 'backups' && <Backups />}
        {tab === 'settings' && <Settings servers={servers} onServersChanged={loadServers} />}
      </main>
    </div>
  )
}

/**
 * The container state, in the sidebar.
 *
 * Polled from here rather than from the dashboard because it is visible on every tab. Fifteen
 * seconds is what the original used, and it is fast enough to catch a restart.
 */
function StatusBadge() {
  const [status, setStatus] = useState('checking...')

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const d = await api.get<{ status: string }>('/api/status')
        if (!cancelled) setStatus(d.status || 'unknown')
      } catch { if (!cancelled) setStatus('unknown') }
    }
    void tick()
    const timer = setInterval(tick, 15000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  return <span id="status-badge" className={'badge-' + status}>{status}</span>
}
