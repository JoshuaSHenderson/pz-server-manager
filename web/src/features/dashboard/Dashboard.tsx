// Status, the manual controls, who is on, and how to connect.
//
// Every *manual* server action lives here. The two warned restarts used to sit inside the restart
// schedule card, which mixed a thing you do with a thing you configure.

import { useState } from 'react'
import { api } from '../../api/client'
import { useAction, useApi } from '../../api/hooks'
import type { ModsResponse, OnlinePlayersResponse, PlayersResponse, StatusResponse, SysInfo } from '../../api/types'
import { Card } from '../../components/Card'
import { MessageSlot, PaneHead, Stat, StatGrid } from '../../components/ui'
import type { TabId } from '../../App'
import { Alerts } from './Alerts'

export function Dashboard({ connect, onGoToTab }: { connect: string; onGoToTab: (t: TabId) => void }) {
  const action = useAction()
  const status = useApi<StatusResponse>('/api/status', { pollMs: 15_000 })
  const sysinfo = useApi<SysInfo>('/api/sysinfo', { pollMs: 30_000 })
  const players = useApi<PlayersResponse>('/api/players')
  const mods = useApi<ModsResponse>('/api/mods')

  const running = status.data?.status === 'running'

  const control = async (verb: 'start' | 'stop' | 'restart') => {
    const confirmMsg: Partial<Record<typeof verb, string>> = {
      stop: 'Stop the server? Players will be disconnected.',
      restart: 'Restart? Players will be disconnected.',
    }
    const ask = confirmMsg[verb]
    if (ask && !confirm(ask)) return

    const ok = await action.run(() => api.post('/api/server/' + verb), 'Server ' + verb + ' OK.')
    // The container takes a moment to report its new state, so re-read rather than assume.
    if (ok) setTimeout(status.reload, 2000)
  }

  return (
    <div className="tab-pane active">
      <PaneHead title="Dashboard" subtitle="Server status, live players, and manual control" />
      <MessageSlot message={action.message} onClear={() => action.setMessage(null)} />

      <Alerts onGoToTab={onGoToTab} />

      <Card id="dash-control" title="Server Control">
        <StatGrid>
          <Stat value={status.data?.status ?? '—'} label="Status" />
          <Stat
            style={{ fontSize: '1rem' }}
            value={running && status.data?.startedAt ? new Date(status.data.startedAt).toLocaleString() : '—'}
            label="Started"
          />
          <Stat value={players.data?.players.length ?? '—'} label="Accounts" />
          <Stat value={mods.data?.mods.length ?? '—'} label="Mods" />
          <Stat style={{ fontSize: '1.1rem' }} value={sysinfo.data?.cpu ?? '—'} label="CPU" />
          <Stat style={{ fontSize: '1.1rem' }} value={sysinfo.data?.mem?.split(' /')[0] ?? '—'} label="Memory" />
          <Stat
            style={{ fontSize: '1.1rem' }}
            value={sysinfo.data && sysinfo.data.disk.avail !== '—'
              ? sysinfo.data.disk.avail + ' free (' + sysinfo.data.disk.pct + ' used)'
              : '—'}
            label="Disk Used"
          />
        </StatGrid>

        <div className="control-row">
          <button className="btn-success" disabled={action.busy} onClick={() => control('start')}>Start</button>
          <button className="btn-danger" disabled={action.busy} onClick={() => control('stop')}>Stop</button>
          <button className="btn-warn" disabled={action.busy} onClick={() => control('restart')}>Restart</button>
          <WarnedRestart action={action} />
        </div>
      </Card>

      <LivePlayers />

      <Card id="dash-connection" title="Connection Info">
        <table>
          <tbody>
            <tr><td className="text-muted" style={{ width: 140 }}>LAN</td><td className="mono">{connect || '—'}</td></tr>
            <tr><td className="text-muted">Game Port</td><td className="mono">UDP 16261 / 16262</td></tr>
            <tr><td className="text-muted">Steam Query</td><td className="mono">TCP 27015</td></tr>
            <tr><td className="text-muted">Server Name</td><td className="mono">servertest</td></tr>
            <tr><td className="text-muted">Image</td><td className="mono">danixu86/project-zomboid-dedicated-server:latest</td></tr>
          </tbody>
        </table>
      </Card>
    </div>
  )
}

/**
 * The two warned restarts.
 *
 * Both go through the same endpoint; the only difference is where the delay comes from. The custom
 * one asks twice — once for the number, once to confirm — because the first prompt is a value and
 * the second is the decision to disconnect everyone.
 */
function WarnedRestart({ action }: { action: ReturnType<typeof useAction> }) {
  const send = async (delayMinutes: number) => {
    const res = await api.post<{ message?: string }>('/api/server/warned-restart', { delayMinutes })
      .catch(e => { throw e })
    action.setMessage({ text: res?.message || 'Restart scheduled.', kind: 'info' })
  }

  const inTen = async () => {
    if (!confirm('Warn players then restart in 10 minutes?')) return
    await action.run(() => send(10))
  }

  const custom = async () => {
    const raw = prompt('Restart in how many minutes? (1-60)', '15')
    const delay = parseInt(raw ?? '', 10)
    if (!delay || delay < 1 || delay > 60) return
    if (!confirm('Restart in ' + delay + ' minutes? Players will be warned.')) return
    await action.run(() => send(delay))
  }

  return (
    <>
      <button className="btn-warn" disabled={action.busy} onClick={inTen}>Warn &amp; Restart in 10 min</button>
      <button className="btn-secondary" disabled={action.busy} onClick={custom}>Custom delay...</button>
    </>
  )
}

function LivePlayers() {
  const { data, error, reload } = useApi<OnlinePlayersResponse>('/api/players/online', { pollMs: 30_000 })
  const [updated, setUpdated] = useState('')

  // Stamped on render rather than inside the fetch, which is close enough and avoids threading a
  // second piece of state through the hook.
  const refresh = () => { reload(); setUpdated(new Date().toLocaleTimeString()) }

  return (
    <Card id="dash-players" title="Live Players">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
        <div className="stat" style={{ flex: '0 0 110px' }}>
          <div
            className="stat-value"
            style={{ color: 'var(--accent2)', textShadow: '0 0 18px rgba(94,234,212,.45)' }}
          >{error ? '—' : data?.online ?? '—'}</div>
          <div className="stat-label">Online Now</div>
        </div>
        <div style={{ flex: 1, fontSize: '.85rem', color: 'var(--muted)' }}>
          {!data
            ? <span style={{ fontStyle: 'italic' }}>Loading...</span>
            : data.online === 0
              ? <span style={{ fontStyle: 'italic' }}>No players online</span>
              : data.players.map(p => (
                <span key={p} style={{
                  display: 'inline-block', padding: '.22rem .6rem', margin: '.15rem', borderRadius: 7,
                  background: 'rgba(94,234,212,.08)', border: '1px solid rgba(94,234,212,.25)',
                  fontFamily: 'var(--font-mono)', fontSize: '.78rem', color: 'var(--accent2)',
                }}>{p}</span>
              ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem' }}>
        <button className="btn-secondary btn-sm" onClick={refresh}>Refresh</button>
        <span style={{ fontSize: '.7rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
          {error ? 'Error fetching' : updated && 'Updated ' + updated}
        </span>
      </div>
    </Card>
  )
}
