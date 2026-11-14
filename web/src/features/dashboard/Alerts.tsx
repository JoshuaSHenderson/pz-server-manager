// "Is anything wrong with this server right now", at the top of the dashboard.
//
// Renders a green-edged card when there is nothing to say rather than disappearing, because an
// absent panel and a panel reporting no problems look identical, and only one of them means the
// check ran.

import { useApi } from '../../api/hooks'
import type { AlertSeverity, AlertsResponse } from '../../api/types'
import { Card } from '../../components/Card'
import type { TabId } from '../../App'

const SEVERITY: Record<AlertSeverity, { colour: string }> = {
  error: { colour: '#e74c3c' },
  warn: { colour: '#f5a623' },
  info: { colour: '#60a5fa' },
}

export function Alerts({ onGoToTab }: { onGoToTab: (t: TabId) => void }) {
  // Two minutes: this scans both log streams, and the server caches the result for thirty seconds
  // anyway, so polling harder would mostly re-read the same cache.
  const { data, reload } = useApi<AlertsResponse>('/api/alerts', { pollMs: 120_000 })

  const alerts = data?.alerts ?? []
  const counts = data?.counts

  if (!alerts.length) {
    return (
      <div style={{ marginBottom: '1.4rem', borderLeft: '3px solid #2ecc71' }} className="alerts-wrap">
        <Card id="alerts" title="Server Alerts">
          <div style={{ fontSize: '.82rem', color: 'var(--muted)', marginTop: '.7rem' }}>
            Nothing to report — no mod issues, orphaned files, failed downloads or notable errors.
          </div>
        </Card>
      </div>
    )
  }

  const worst = counts?.error ? '#e74c3c' : counts?.warn ? '#f5a623' : '#60a5fa'

  return (
    <div style={{ marginBottom: '1.4rem', borderLeft: '3px solid ' + worst }}>
      <Card
        id="alerts"
        title="Server Alerts"
        aside={
          <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>
            {counts?.error ? <><span style={{ color: '#e74c3c' }}>{counts.error} error</span>{' · '}</> : null}
            {counts?.warn ? <><span style={{ color: '#f5a623' }}>{counts.warn} warning</span>{' · '}</> : null}
            {counts?.info ?? 0} info
          </span>
        }
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '.5rem' }}>
          <button className="btn-secondary btn-sm" onClick={reload}>Refresh</button>
        </div>

        {alerts.map((a, i) => {
          const colour = (SEVERITY[a.severity] ?? SEVERITY.info).colour
          return (
            <div
              key={a.category + a.title + i}
              style={{
                display: 'flex', gap: '.75rem', alignItems: 'flex-start', justifyContent: 'space-between',
                flexWrap: 'wrap', padding: '.5rem .7rem', borderLeft: '3px solid ' + colour,
                background: 'var(--bg)', marginBottom: '.4rem', borderRadius: 3,
              }}
            >
              <div style={{ minWidth: 260, flex: 1 }}>
                <span style={{
                  fontSize: '.66rem', fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
                  letterSpacing: '.06em', color: colour,
                }}>{a.category}</span>
                <div style={{ fontSize: '.83rem', marginTop: '.1rem' }}>{a.title}</div>
                {a.detail && (
                  <div style={{ fontSize: '.73rem', color: 'var(--muted)', marginTop: '.15rem', wordBreak: 'break-word' }}>
                    {a.detail.slice(0, 300)}
                  </div>
                )}
              </div>
              {a.tab && (
                <button className="btn-secondary btn-sm" onClick={() => onGoToTab(a.tab as TabId)}>
                  Open {a.tab}
                </button>
              )}
            </div>
          )
        })}
      </Card>
    </div>
  )
}
