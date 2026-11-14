// servertest.ini: the curated fields, plus every other key the file actually contains.
//
// The advanced grid is generated from the response rather than from a hardcoded list of PZ keys,
// so a key this manager has never heard of still round-trips instead of being silently dropped on
// the next save.

import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useAction, useApi } from '../../api/hooks'
import type { IniConfig } from '../../api/types'
import { Card } from '../../components/Card'
import { MessageSlot } from '../../components/ui'

const BOOLS = ['PVP', 'SafetySystem', 'Open', 'Public', 'PauseEmpty', 'GlobalChat', 'VoiceEnable'] as const

const BOOL_LABELS: Record<(typeof BOOLS)[number], string> = {
  PVP: 'PvP enabled',
  SafetySystem: 'Safety system',
  Open: 'Open (no whitelist)',
  Public: 'Public server browser',
  PauseEmpty: 'Pause when empty',
  GlobalChat: 'Global chat',
  VoiceEnable: 'Voice chat',
}

const TEXT_FIELDS: { key: string; label: string; type?: string; min?: number; max?: number }[] = [
  { key: 'PublicName', label: 'Server Name' },
  { key: 'Password', label: 'Password (blank = none)' },
  { key: 'MaxPlayers', label: 'Max Players', type: 'number', min: 1, max: 100 },
  { key: 'HoursForLootRespawn', label: 'Loot Respawn (hours, 0=off)', type: 'number', min: 0 },
  { key: 'SaveWorldEveryMinutes', label: 'Autosave Every (minutes)', type: 'number', min: 0 },
]

const CURATED = new Set<string>([...TEXT_FIELDS.map(f => f.key), ...BOOLS])

const fieldLabel: React.CSSProperties = {
  display: 'block', fontSize: '.72rem', color: 'var(--muted)', marginBottom: '.35rem',
  fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.1em',
}

export function ServerSettings() {
  const { data, reload } = useApi<IniConfig>('/api/config')
  const action = useAction()
  const [draft, setDraft] = useState<IniConfig | null>(null)

  useEffect(() => { if (data) setDraft({ ...data }) }, [data])
  if (!draft) return null

  const advancedKeys = Object.keys(draft).filter(k => !CURATED.has(k)).sort()
  const set = (key: string, value: string) => setDraft({ ...draft, [key]: value })

  const save = async () => {
    const ok = await action.run(() => api.put('/api/config', draft), 'Saved. Restart server to apply.')
    if (ok) reload()
  }

  return (
    <Card id="config-server" title="Server Settings">
      <p style={{ fontSize: '.85rem', color: 'var(--muted)', margin: '0 0 1.25rem' }}>
        Changes require a server restart to take effect.
      </p>

      <MessageSlot message={action.message} onClear={() => action.setMessage(null)} />

      <div className="form-grid">
        {TEXT_FIELDS.map(f => (
          <div key={f.key}>
            <label style={fieldLabel}>{f.label}</label>
            <input
              type={f.type ?? 'text'}
              min={f.min}
              max={f.max}
              style={{ width: '100%' }}
              value={draft[f.key] ?? ''}
              onChange={e => set(f.key, e.target.value)}
            />
          </div>
        ))}
      </div>

      <div className="card-title" style={{ marginBottom: '.85rem' }}>Gameplay Flags</div>
      <div className="form-grid form-grid-tight">
        {BOOLS.map(k => (
          <label key={k} style={{ display: 'flex', alignItems: 'center', gap: '.6rem', cursor: 'pointer', fontSize: '.875rem' }}>
            <input
              type="checkbox"
              checked={(draft[k] ?? '').toLowerCase() === 'true'}
              onChange={e => set(k, e.target.checked ? 'true' : 'false')}
            /> {BOOL_LABELS[k]}
          </label>
        ))}
      </div>

      <button className="btn-primary" onClick={save} disabled={action.busy}>Save</button>

      <details style={{ marginTop: '1.5rem' }}>
        <summary style={{ cursor: 'pointer', fontSize: '.9rem', color: 'var(--muted)' }}>
          Advanced Options (all remaining servertest.ini keys)
        </summary>
        <div className="form-grid form-grid-tight" style={{ margin: '1rem 0 0' }}>
          {advancedKeys.map(k => (
            <div key={k}>
              <label style={{
                display: 'block', fontSize: '.68rem', color: 'var(--muted)', marginBottom: '.3rem',
                fontFamily: 'var(--font-mono)',
              }}>{k}</label>
              <input
                type="text"
                style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: '.8rem' }}
                value={draft[k] ?? ''}
                onChange={e => set(k, e.target.value)}
              />
            </div>
          ))}
        </div>
      </details>
    </Card>
  )
}
