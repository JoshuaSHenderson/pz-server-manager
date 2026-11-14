// Unmet require=, declared conflicts, and load-order constraints.
//
// PZ will not tell you a dependency is unmet; the mod just misbehaves in-game. Nothing here is
// auto-fixed, because authors list optional companion mods in require= constantly — every row asks
// rather than acts, and "Not required" dismisses one pairing without silencing the mod.

import { useState } from 'react'
import { api } from '../../api/client'
import { useApi } from '../../api/hooks'
import type { DependenciesResponse, DependencyIssue, DependencyIssueType } from '../../api/types'
import { Card } from '../../components/Card'

const KIND: Record<DependencyIssueType, { colour: string; label: string }> = {
  incompatible: { colour: '#e74c3c', label: 'Conflict' },
  missing: { colour: '#e74c3c', label: 'Missing' },
  disabled: { colour: '#f5a623', label: 'Not loaded' },
  order: { colour: '#60a5fa', label: 'Load order' },
}

function describe(i: DependencyIssue) {
  const me = <strong>{i.modName || i.modId}</strong>
  const dep = <strong>{i.dependencyName || i.dependency}</strong>
  switch (i.type) {
    case 'incompatible':
      return <>{me} declares it is incompatible with {dep}, and both are loaded.</>
    case 'missing':
      return <>{me} requires <strong>{i.dependency}</strong>, which is not installed.</>
    case 'disabled':
      return <>{me} requires {dep}, which is installed but not enabled.</>
    case 'order':
      return (
        <>{me} must load after {dep}, but currently loads before it
          (position {(i.modIndex ?? 0) + 1} vs {(i.dependencyIndex ?? 0) + 1}).</>
      )
  }
}

export function Dependencies({ onChanged, onMessage }: {
  onChanged: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
}) {
  const { data, reload } = useApi<DependenciesResponse>('/api/dependencies')
  const [showIgnored, setShowIgnored] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!data) return null
  const { issues, ignored } = data

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      onMessage(ok, 'success')
      reload()
      onChanged()
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    } finally { setBusy(false) }
  }

  const setEnabled = (modId: string, enabled: boolean) =>
    act(() => api.post('/api/mods/enabled', { modId, enabled }),
      (enabled ? 'Enabled ' : 'Disabled ') + modId + '. Restart the server to apply.')

  const fixOrder = (i: DependencyIssue) =>
    act(async () => {
      const r = await api.post<{ remaining: number; backup: string }>(
        '/api/dependencies/fix-order', { modId: i.modId, dependency: i.dependency })
      onMessage(
        'Moved ' + i.modId + ' after ' + i.dependency + '. ' +
        (r.remaining ? r.remaining + ' order issue(s) still outstanding.' : 'No order issues left.') +
        ' Backed up as ' + r.backup + '. Restart to apply.',
        'success',
      )
    }, '')

  const setIgnored = (modId: string, dependency: string, ignore: boolean) =>
    act(() => api.post('/api/dependencies/ignore', { modId, dependency, ignored: ignore }),
      ignore ? 'Dismissed ' + modId + ' → ' + dependency + '.' : 'Restored ' + modId + ' → ' + dependency + '.')

  const ignoredLink = ignored.length > 0 && (
    <>
      {' · '}{ignored.length} ignored{' '}
      <a
        href="#"
        onClick={e => { e.preventDefault(); setShowIgnored(v => !v) }}
        style={{ color: '#60a5fa' }}
      >({showIgnored ? 'hide' : 'review'})</a>
    </>
  )

  const ignoredPanel = showIgnored && ignored.length > 0 && (
    <div className="card" style={{ marginBottom: '1rem' }}>
      <div className="card-title">Ignored dependency warnings</div>
      <p style={{ fontSize: '.76rem', color: 'var(--muted)', margin: '0 0 .6rem' }}>
        Each of these hides one dependent → dependency pairing. A <em>stale</em> entry names a mod
        that is no longer enabled, so it can never match again — usually what a mod id rename leaves behind.
      </p>
      {ignored.map(ig => (
        <div key={ig.key} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem',
          padding: '.3rem .5rem', background: 'var(--bg)', marginBottom: '.2rem', borderRadius: 3,
        }}>
          <span className="mono" style={{ fontSize: '.78rem' }}>
            {ig.modId} → {ig.dependency}
            {ig.stale && <span style={{ color: 'var(--muted)', fontSize: '.72rem' }}> · stale</span>}
          </span>
          <button className="btn-secondary btn-sm" disabled={busy} onClick={() => setIgnored(ig.modId, ig.dependency, false)}>
            Restore
          </button>
        </div>
      ))}
    </div>
  )

  if (!issues.length) {
    return (
      <>
        {ignoredPanel}
        {ignored.length > 0 && (
          <div className="msg msg-info" style={{ marginBottom: '1rem', fontSize: '.82rem' }}>
            All mod dependencies satisfied.{' '}
            <span style={{ opacity: .8 }}>
              {ignored.length} ignored{' '}
              <a href="#" onClick={e => { e.preventDefault(); setShowIgnored(v => !v) }} style={{ color: '#60a5fa' }}>
                ({showIgnored ? 'hide' : 'review'})
              </a>.
            </span>
          </div>
        )}
      </>
    )
  }

  const blocking = issues.filter(i => i.type === 'incompatible' || i.type === 'missing').length

  return (
    <>
      {ignoredPanel}
      <div style={{ marginBottom: '1rem', borderLeft: '3px solid ' + (blocking ? '#e74c3c' : '#f5a623') }}>
        <Card
          id="mods-deps"
          title={
            <>Dependency issues{' '}
              <span className="mono" style={{ fontSize: '.78rem', fontWeight: 400, color: 'var(--muted)' }}>({issues.length})</span>
            </>
          }
          aside={
            <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>
              Checked {data.checked} loaded mods{ignoredLink}
            </span>
          }
        >
          <div style={{ fontSize: '.76rem', color: 'var(--muted)', margin: '.7rem 0' }}>
            Read from each mod's <span className="mono">mod.info</span>. Authors often list optional
            companion mods as required — use <strong>Not required</strong> to dismiss those. Nothing
            is changed automatically.
          </div>

          {issues.map(i => {
            const kind = KIND[i.type]
            return (
              <div
                key={i.modId + '>' + i.dependency}
                style={{
                  display: 'flex', gap: '.75rem', alignItems: 'flex-start', justifyContent: 'space-between',
                  flexWrap: 'wrap', padding: '.55rem .7rem', borderLeft: '3px solid ' + kind.colour,
                  background: 'var(--bg)', marginBottom: '.4rem', borderRadius: 3,
                }}
              >
                <div style={{ minWidth: 260, flex: 1 }}>
                  <span style={{
                    fontSize: '.68rem', fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
                    letterSpacing: '.06em', color: kind.colour,
                  }}>{kind.label}</span>
                  <div style={{ fontSize: '.82rem', marginTop: '.15rem' }}>{describe(i)}</div>
                </div>

                <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
                  {i.type === 'disabled' && i.dependencyModId && (
                    <button className="btn-primary btn-sm" disabled={busy} onClick={() => setEnabled(i.dependencyModId!, true)}>
                      Enable {i.dependencyModId}
                    </button>
                  )}

                  {/* Either side of a conflict can go; the operator knows which they actually want. */}
                  {i.type === 'incompatible' && (
                    <>
                      <button className="btn-danger btn-sm" disabled={busy} onClick={() => setEnabled(i.modId, false)}>
                        Disable {i.modId}
                      </button>
                      {i.dependencyModId && (
                        <button className="btn-danger btn-sm" disabled={busy} onClick={() => setEnabled(i.dependencyModId!, false)}>
                          Disable {i.dependencyModId}
                        </button>
                      )}
                    </>
                  )}

                  {i.type === 'order' && (
                    <button
                      className="btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => fixOrder(i)}
                      title={'Move ' + i.modId + ' down the load order to sit just after ' + (i.dependencyName || i.dependency) +
                        ', which is where it says it needs to be. Only the position changes — no mod is added, removed, enabled or disabled. ' +
                        'The current order is backed up first, and the server needs a restart to apply it.'}
                    >Fix</button>
                  )}

                  {i.type === 'missing' && (
                    <a
                      className="btn-secondary btn-sm"
                      target="_blank" rel="noreferrer"
                      style={{ textDecoration: 'none' }}
                      href={'https://steamcommunity.com/workshop/browse/?appid=108600&searchtext=' + encodeURIComponent(i.dependency)}
                    >Find on Workshop</a>
                  )}

                  <button
                    className="btn-secondary btn-sm"
                    disabled={busy}
                    title="Hide this one pairing. Use when the mod lists an optional companion in require=."
                    onClick={() => setIgnored(i.modId, i.dependency, true)}
                  >Not required</button>
                </div>
              </div>
            )
          })}
        </Card>
      </div>
    </>
  )
}
