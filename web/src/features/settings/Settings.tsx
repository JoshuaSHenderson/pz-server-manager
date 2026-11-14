// Notifications and integrations.
//
// One difference from the old UI, and it is deliberate: the Pushover token, user key and Discord
// webhook are never sent to the browser. The server reports whether each is set, the fields show
// that as placeholder text, and leaving one blank on save keeps what is stored. Previously
// GET /api/notifications returned live credentials to anything that asked.

import { useEffect, useState } from 'react'
import { api, logout } from '../../api/client'
import { useAction, useApi } from '../../api/hooks'
import type { DiscordDetected, NotificationConfig, NotificationEvents, ServersResponse } from '../../api/types'
import { Card } from '../../components/Card'
import { MessageSlot, PaneHead } from '../../components/ui'
import { ServersAdmin } from './ServersAdmin'

const SERVER_EVENTS: { key: keyof NotificationEvents; label: string }[] = [
  { key: 'serverStart', label: 'Server started / restarted' },
  { key: 'serverReady', label: 'Server finished loading (accepting players)' },
  { key: 'serverStop', label: 'Server stopped (manual)' },
  { key: 'serverCrash', label: 'Server crashed' },
  { key: 'downloadComplete', label: 'Workshop downloads complete' },
]

const PLAYER_EVENTS: { key: keyof NotificationEvents; label: string }[] = [
  { key: 'playerJoin', label: 'Player joined' },
  { key: 'playerLeave', label: 'Player left' },
  { key: 'playerSpawned', label: 'Player spawned / respawned into the world' },
  { key: 'playerDied', label: 'Player died' },
  { key: 'playerKicked', label: 'Player kicked' },
]

interface Draft {
  enabled: boolean
  token: string
  userKey: string
  events: Partial<NotificationEvents>
  lowDiskThresholdGB: number
  discord: {
    enabled: boolean
    webhookUrl: string
    messageId: string
    richCard: boolean
    iconUrl: string
    template: string
  }
}

function toDraft(cfg: NotificationConfig): Draft {
  return {
    enabled: cfg.enabled,
    // Blank means "leave whatever is stored alone" — the server never sends the real value.
    token: '',
    userKey: '',
    events: { ...cfg.events },
    lowDiskThresholdGB: cfg.lowDiskThresholdGB || 5,
    discord: {
      enabled: cfg.discord.enabled,
      webhookUrl: '',
      messageId: cfg.discord.messageId || '',
      richCard: cfg.discord.richCard,
      iconUrl: cfg.discord.iconUrl || '',
      template: cfg.discord.template || '',
    },
  }
}

export function Settings({ servers, onServersChanged }: {
  servers: ServersResponse | null
  onServersChanged: () => void
}) {
  const { data, reload } = useApi<NotificationConfig>('/api/notifications')
  const action = useAction()
  const [draft, setDraft] = useState<Draft | null>(null)

  useEffect(() => { if (data) setDraft(toDraft(data)) }, [data])

  if (!draft || !data) {
    return (
      <div className="tab-pane active">
        <PaneHead title="Settings" subtitle="Notifications and integrations" />
        <ServersAdmin servers={servers} onChanged={onServersChanged} />
      </div>
    )
  }

  const setEvent = (key: keyof NotificationEvents, value: boolean) =>
    setDraft({ ...draft, events: { ...draft.events, [key]: value } })

  const save = async () => {
    const ok = await action.run(() => api.put('/api/notifications', draft), 'Settings saved.')
    if (ok) reload()
    return ok
  }

  const saveAndUpdateDiscord = async () => {
    if (!await save()) return
    action.setMessage({ text: 'Settings saved. Updating Discord...', kind: 'info' })
    await action.run(() => api.post('/api/discord/update'), 'Discord status updated.')
    reload()
  }

  const test = async () => {
    action.setMessage({ text: 'Sending test notification...', kind: 'info' })
    await action.run(() => api.post('/api/notifications/test'), 'Test sent! Check your device.')
  }

  const clearMessageId = async () => {
    setDraft({ ...draft, discord: { ...draft.discord, messageId: '' } })
    await action.run(
      () => api.put('/api/notifications', { ...draft, discord: { ...draft.discord, messageId: '' } }),
      'Pinned message cleared — the next update posts a fresh card.',
    )
    reload()
  }

  const labelStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '.6rem', cursor: 'pointer', fontSize: '.875rem',
  }
  const fieldLabel: React.CSSProperties = {
    display: 'block', fontSize: '.72rem', color: 'var(--muted)', marginBottom: '.35rem',
    fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.1em',
  }

  return (
    <div className="tab-pane active">
      <PaneHead title="Settings" subtitle="Notifications and integrations" />
      <MessageSlot message={action.message} onClear={() => action.setMessage(null)} />

      <ServersAdmin servers={servers} onChanged={onServersChanged} />

      <Card id="settings-pushover" title="Pushover Notifications">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
          <label style={{ ...labelStyle, fontSize: '.9rem' }}>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={e => setDraft({ ...draft, enabled: e.target.checked })}
            /> Enable notifications
          </label>
          <span className={'badge ' + (data.enabled ? 'badge-gm' : 'badge-none')} style={{ fontSize: '.75rem' }}>
            {data.enabled ? 'active' : 'disabled'}
          </span>
        </div>

        <div style={{ display: 'grid', gap: '.75rem', marginBottom: '1.25rem' }}>
          <div>
            <label style={fieldLabel}>API Token</label>
            <input
              type="password"
              autoComplete="off"
              value={draft.token}
              onChange={e => setDraft({ ...draft, token: e.target.value })}
              style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
              placeholder={data.tokenSet ? 'configured — leave blank to keep' : 'Pushover app token'}
            />
          </div>
          <div>
            <label style={fieldLabel}>User Key</label>
            <input
              type="password"
              autoComplete="off"
              value={draft.userKey}
              onChange={e => setDraft({ ...draft, userKey: e.target.value })}
              style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
              placeholder={data.userKeySet ? 'configured — leave blank to keep' : 'Pushover user key'}
            />
          </div>
        </div>

        <div className="card-title" style={{ marginBottom: '.85rem' }}>Notify On</div>
        <div style={{ display: 'grid', gap: '.7rem', marginBottom: '1.25rem' }}>
          {SERVER_EVENTS.map(({ key, label }) => (
            <label key={key} style={labelStyle}>
              <input
                type="checkbox"
                checked={!!draft.events[key]}
                onChange={e => setEvent(key, e.target.checked)}
              /> {label}
            </label>
          ))}
          <label style={labelStyle}>
            <input
              type="checkbox"
              checked={!!draft.events.lowDisk}
              onChange={e => setEvent('lowDisk', e.target.checked)}
            /> Low disk — alert below
            <input
              type="number" min={1} max={50}
              value={draft.lowDiskThresholdGB}
              onChange={e => setDraft({ ...draft, lowDiskThresholdGB: parseInt(e.target.value, 10) || 5 })}
              // The spinner arrows come back from `input[type=number] { appearance: auto }` in
              // controls.css, so nothing needs to override them inline any more.
              style={{ width: 60, padding: '.25rem .4rem' }}
            /> GB
          </label>
        </div>

        <div className="card-title" style={{ marginBottom: '.85rem' }}>Player Events</div>
        <div style={{ display: 'grid', gap: '.7rem', marginBottom: '1.25rem' }}>
          {PLAYER_EVENTS.map(({ key, label }) => (
            <label key={key} style={labelStyle}>
              <input
                type="checkbox"
                checked={!!draft.events[key]}
                onChange={e => setEvent(key, e.target.checked)}
              /> {label}
            </label>
          ))}
        </div>

        <div style={{ display: 'flex', gap: '.6rem' }}>
          <button className="btn-primary" onClick={save} disabled={action.busy}>Save</button>
          <button className="btn-secondary" onClick={test} disabled={action.busy}>Send Test</button>
        </div>
      </Card>

      <Discord
        draft={draft}
        setDraft={setDraft}
        webhookSet={data.discord.webhookUrlSet}
        busy={action.busy}
        onSave={saveAndUpdateDiscord}
        onClearMessageId={clearMessageId}
        fieldLabel={fieldLabel}
        labelStyle={labelStyle}
      />

      <Card id="settings-session" title="Session">
        <p style={{ fontSize: '.85rem', color: 'var(--muted)', margin: '0 0 1rem' }}>
          Signs out of this browser. The manager token itself is unchanged — set
          <span className="mono"> MANAGER_TOKEN</span> to rotate it.
        </p>
        <button className="btn-secondary" onClick={logout}>Sign out</button>
      </Card>
    </div>
  )
}

function Discord({ draft, setDraft, webhookSet, busy, onSave, onClearMessageId, fieldLabel, labelStyle }: {
  draft: Draft
  setDraft: (d: Draft) => void
  webhookSet: boolean
  busy: boolean
  onSave: () => void
  onClearMessageId: () => void
  fieldLabel: React.CSSProperties
  labelStyle: React.CSSProperties
}) {
  const detected = useApi<DiscordDetected>('/api/discord/detected', { enabled: draft.discord.richCard })
  const d = draft.discord
  const set = (patch: Partial<Draft['discord']>) => setDraft({ ...draft, discord: { ...d, ...patch } })

  const detectedText = !detected.data
    ? 'detecting...'
    : [
      detected.data.externalIp && detected.data.port
        ? detected.data.externalIp + ':' + detected.data.port
        : detected.data.externalIp
          ? detected.data.externalIp + ' (port not set)'
          : '(detecting external IP...)',
      detected.data.version ? 'v' + detected.data.version : '',
    ].filter(Boolean).join(' · ')

  return (
    <div style={{ marginTop: '1.4rem' }}>
      <Card id="settings-discord" title="Discord Status Message">
        <p style={{ fontSize: '.85rem', color: 'var(--muted)', margin: '0 0 1rem' }}>
          Posts live server status to a Discord channel via webhook.
        </p>

        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.25rem' }}>
          <label style={{ ...labelStyle, fontSize: '.9rem' }}>
            <input type="checkbox" checked={d.enabled} onChange={e => set({ enabled: e.target.checked })} />
            {' '}Enable Discord status
          </label>
        </div>

        <div style={{ display: 'grid', gap: '.75rem', marginBottom: '1.25rem' }}>
          <div>
            <label style={fieldLabel}>Webhook URL</label>
            <input
              type="password"
              autoComplete="off"
              value={d.webhookUrl}
              onChange={e => set({ webhookUrl: e.target.value })}
              style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
              placeholder={webhookSet ? 'configured — leave blank to keep' : 'https://discord.com/api/webhooks/...'}
            />
          </div>

          <div>
            <label style={fieldLabel}>Server icon URL (optional)</label>
            <input
              type="text"
              value={d.iconUrl}
              onChange={e => set({ iconUrl: e.target.value })}
              style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
              placeholder="https://cdn.discordapp.com/attachments/..."
            />
            <p style={{ fontSize: '.75rem', color: 'var(--muted)', margin: '.35rem 0 0' }}>
              Shown as the card thumbnail and the webhook avatar. Discord fetches this itself, so it
              must be reachable from the internet — this manager's own <span className="mono">/server-icon.png</span> is
              only on your LAN. Easiest source: drop the image in any Discord channel, right-click it and Copy Link.
            </p>
          </div>

          <div>
            <label style={{ ...labelStyle, marginBottom: '.75rem' }}>
              <input type="checkbox" checked={d.richCard} onChange={e => set({ richCard: e.target.checked })} />
              {' '}Use rich card embed
            </label>

            {d.richCard ? (
              <div style={{ marginBottom: '.5rem' }}>
                <label style={fieldLabel}>Connect &amp; Version (auto-detected)</label>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '.85rem', color: 'var(--muted)' }}>
                  {detected.error ? '(unavailable)' : detectedText}
                </div>
              </div>
            ) : (
              <div>
                <label style={fieldLabel}>Message Template</label>
                <textarea
                  rows={3}
                  value={d.template}
                  onChange={e => set({ template: e.target.value })}
                  style={{ width: '100%', fontFamily: 'var(--font-mono)', resize: 'vertical', boxSizing: 'border-box' }}
                  placeholder="Project Zomboid Server: <ZomboidServerStats>"
                />
              </div>
            )}
          </div>

          <div>
            <label style={fieldLabel}>Pinned Message ID</label>
            <div style={{ display: 'flex', gap: '.5rem' }}>
              <input
                type="text"
                readOnly
                value={d.messageId}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', opacity: .7 }}
                placeholder="(auto-set)"
              />
              <button className="btn-secondary btn-sm" onClick={onClearMessageId} disabled={busy}>Clear</button>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '.6rem' }}>
          <button className="btn-primary" onClick={onSave} disabled={busy}>Save &amp; Update Now</button>
        </div>
      </Card>
    </div>
  )
}
