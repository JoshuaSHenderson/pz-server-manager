// The manager's own automation: the restart schedule and mod auto-update.
//
// Deliberately first on the Config tab and deliberately not styled like the rest of it. Everything
// else on that tab writes servertest.ini and needs a server restart to take effect; these two are
// the manager's own settings and apply the moment they are saved. The accent border is what stops
// them reading as PZ settings.

import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useAction, useApi } from '../../api/hooks'
import type { AutoUpdateConfig, Schedule, ServerTime } from '../../api/types'
import { MessageSlot } from '../../components/ui'

const INTERVALS = [2, 6, 12, 24]

export function Automation() {
  return (
    <div className="card mgr-card">
      <details open>
        <summary>
          <span className="card-title" style={{ marginBottom: 0 }}>
            Restarts &amp; Updates <span className="pill">manager · applies instantly</span>
          </span>
        </summary>
        <p className="mgr-note">
          Run by the manager, not by the game server. Nothing here is written to
          <span className="mono"> servertest.ini</span>, so saving takes effect straight away.
        </p>
        <ScheduleSection />
        <AutoUpdateSection />
      </details>
    </div>
  )
}

function ScheduleSection() {
  const { data, reload } = useApi<Schedule>('/api/schedule')
  // The schedule runs on the container's clock, so the operator needs to see which clock that is.
  const time = useApi<ServerTime>('/api/servertime', { pollMs: 60_000 })
  const action = useAction()
  const [draft, setDraft] = useState<Schedule | null>(null)

  useEffect(() => { if (data) setDraft(data) }, [data])
  if (!draft) return null

  const interval = draft.mode === 'interval'

  const save = async () => {
    const ok = await action.run(() => api.put('/api/schedule', draft))
    if (!ok) return
    const h = String(draft.hour).padStart(2, '0')
    const m = String(draft.minute).padStart(2, '0')
    action.setMessage({
      kind: 'success',
      text: !draft.enabled
        ? 'Auto-restart disabled.'
        : interval
          ? 'Restart every ' + draft.intervalHours + 'h (anchored at ' + h + ':' + m + ').'
          : 'Daily restart set for ' + h + ':' + m + '.',
    })
    reload()
  }

  return (
    <div className="mgr-section">
      <div className="mgr-head">Scheduled restart</div>
      <MessageSlot message={action.message} onClear={() => action.setMessage(null)} />

      <div className="mgr-row">
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={e => setDraft({ ...draft, enabled: e.target.checked })}
          />
          Restart on a schedule
        </label>
        <span className="mono" style={{ fontSize: '.78rem', color: 'var(--muted)' }}>
          {time.data ? 'Server time: ' + time.data.display : ''}
        </span>
      </div>

      <div className="mgr-row">
        <select
          className="server-select"
          style={{ width: 'auto', margin: 0 }}
          value={draft.mode}
          onChange={e => setDraft({ ...draft, mode: e.target.value as Schedule['mode'] })}
        >
          <option value="daily">Once daily</option>
          <option value="interval">Every N hours</option>
        </select>

        {interval && (
          <select
            className="server-select"
            style={{ width: 'auto', margin: 0 }}
            value={String(draft.intervalHours)}
            onChange={e => setDraft({ ...draft, intervalHours: parseInt(e.target.value, 10) })}
          >
            {INTERVALS.map(h => <option key={h} value={h}>every {h} hours</option>)}
          </select>
        )}

        <span style={{ fontSize: '.85rem', color: 'var(--muted)' }}>
          {interval ? 'starting from' : 'Restart at'}
        </span>

        <div className="time-picker">
          <input
            type="number" min={0} max={23}
            value={draft.hour}
            onChange={e => setDraft({ ...draft, hour: parseInt(e.target.value, 10) || 0 })}
          />
          <span>:</span>
          <input
            type="number" min={0} max={59} style={{ width: 64 }}
            value={draft.minute}
            onChange={e => setDraft({ ...draft, minute: parseInt(e.target.value, 10) || 0 })}
          />
        </div>

        <span style={{ fontSize: '.78rem', color: 'var(--muted)' }}>(server local time)</span>
      </div>

      <p className="mgr-hint">In-game warnings sent at T-10, T-5 and T-1 minutes via RCON.</p>
      <button className="btn-primary" onClick={save} disabled={action.busy}>Save Schedule</button>
    </div>
  )
}

function AutoUpdateSection() {
  const { data, reload } = useApi<AutoUpdateConfig>('/api/mods/autoupdate')
  const action = useAction()

  const save = async (enabled: boolean, restartWhenEmpty: boolean) => {
    const ok = await action.run(() => api.put('/api/mods/autoupdate', { enabled, restartWhenEmpty }))
    if (!ok) return
    action.setMessage({
      kind: 'success',
      text: enabled
        ? 'Mod auto-update on — checking hourly.' +
          (restartWhenEmpty ? ' Will restart when empty.' : ' Restarts are off; updates download only.')
        : 'Mod auto-update off.',
    })
    reload()
  }

  const setEnabled = (enabled: boolean) => save(enabled, !!data?.restartWhenEmpty)

  const setRestart = (restartWhenEmpty: boolean) => {
    // Enabling never triggers an immediate mass update — the first check only records a baseline —
    // but it does mean the manager may take the server down on its own, so it asks once.
    if (restartWhenEmpty && data?.enabled && !confirm(
      'Enable automatic restarts?\n\nWhen a mod update is found the server will be restarted to apply it — only once downloads finish and no players are connected. Anyone who joins in the meantime delays it.',
    )) return
    void save(!!data?.enabled, restartWhenEmpty)
  }

  const checkNow = async () => {
    const res = await api.post<{ message?: string }>('/api/mods/autoupdate/check').catch(e => {
      action.setMessage({ text: 'Check failed: ' + (e instanceof Error ? e.message : String(e)), kind: 'error' })
      return null
    })
    if (!res) return
    action.setMessage({ text: res.message || 'Check started.', kind: 'info' })
    setTimeout(reload, 6000)
  }

  const bits: string[] = []
  if (data?.lastCheck) bits.push('Last check: ' + new Date(data.lastCheck).toLocaleString())
  if (data?.tracked) bits.push(data.tracked + ' mod(s) tracked')
  if (data?.lastRestart) bits.push('Last auto-restart: ' + new Date(data.lastRestart).toLocaleString())

  return (
    <div className="mgr-section">
      <div className="mgr-head">Restart for mod updates</div>
      <p className="mgr-hint" style={{ marginTop: 0 }}>
        Checks Steam hourly for updates to installed Workshop items. Updated mods are downloaded, and once
        the downloads finish the server restarts to apply them — but only while nobody is connected. The
        player count comes from the server itself over RCON, so an empty server is recognised even when it
        has just restarted and written no player log yet.
      </p>

      <MessageSlot message={action.message} onClear={() => action.setMessage(null)} />

      <div style={{ display: 'grid', gap: '.7rem', marginBottom: '1rem' }}>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={!!data?.enabled}
            disabled={action.busy}
            onChange={e => setEnabled(e.target.checked)}
          /> Check hourly for mod updates
        </label>
        <label className="toggle-label">
          <input
            type="checkbox"
            checked={!!data?.restartWhenEmpty}
            disabled={action.busy}
            onChange={e => setRestart(e.target.checked)}
          /> Restart once downloads finish and the server is empty
        </label>
      </div>

      <div style={{ fontSize: '.78rem', color: 'var(--muted)', marginBottom: '.8rem' }}>
        {data?.lastResult && <div style={{ marginBottom: '.3rem' }}>{data.lastResult}</div>}
        {data && data.pending.length > 0 && (
          <div style={{ color: '#f5a623', fontWeight: 600, marginBottom: '.3rem' }}>
            {data.pending.length} update(s) pending a restart
          </div>
        )}
        {bits.length
          ? bits.join(' · ')
          : data?.enabled ? 'Enabled — first check runs within a few minutes.' : 'Disabled.'}
      </div>

      <button className="btn-secondary btn-sm" onClick={checkNow} disabled={action.busy}>Check now</button>
    </div>
  )
}
