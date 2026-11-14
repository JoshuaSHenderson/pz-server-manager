// What is downloading now, and what has been requested since.
//
// Two views of one endpoint: a one-line strip that only exists while something is in flight, and a
// collapsed history that is a record rather than something read every visit.

import { useState } from 'react'
import { api } from '../../api/client'
import type { ActiveDownload, QueueEntry } from '../../api/types'
import { Empty } from '../../components/ui'

/** Compact one-line strip while downloads are live; renders nothing when idle. */
export function DownloadBanner({ active }: { active: ActiveDownload[] }) {
  if (!active.length) return null

  const withPct = active.filter(a => a.status === 'downloading' && a.total > 0)
  const pct = withPct.length
    ? Math.round(withPct.reduce((sum, a) => sum + a.pct, 0) / withPct.length)
    : null

  return (
    <div className="msg msg-info" style={{ marginBottom: '.75rem', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
      <span className="spin" />
      <span>
        <strong>
          {active.length} mod{active.length > 1 ? 's' : ''} downloading{pct !== null ? ' — ' + pct + '% avg' : ''}.
        </strong>{' '}
        <span style={{ fontSize: '.8rem', opacity: .85 }}>Don't restart the server until this finishes.</span>
      </span>
    </div>
  )
}

const STATUS_COLOUR: Record<string, string> = {
  queued: '#f5a623',
  installed: '#2ecc71',
  failed: '#e74c3c',
  collection: '#60a5fa',
}

const STATUS_LABEL: Record<string, string> = {
  queued: 'Queued',
  installed: 'Installed',
  failed: 'Failed',
  collection: 'Collection (expanded)',
}

export function DownloadActivity({ queue, active, onChanged, onMessage }: {
  queue: QueueEntry[]
  active: ActiveDownload[]
  onChanged: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
}) {
  const [busy, setBusy] = useState(false)
  const live = new Map(active.map(a => [a.workshopId, a]))

  const pending = queue.filter(e => e.status === 'queued').length
  const failed = queue.filter(e => e.status === 'failed').length

  const retry = async (workshopId: string) => {
    await api.post('/api/mods/retry', { workshopId }).catch(() => {})
    onMessage('Re-queued ' + workshopId + '.', 'info')
    onChanged()
  }

  // Settled entries only — anything still queued is work in flight, and dropping it would orphan
  // the download, because reconcileDownloads would then never register the mod when it lands.
  const clear = async () => {
    setBusy(true)
    try {
      const r = await api.del<{ cleared: number; kept: number }>('/api/downloads/queue')
      onMessage(
        'Cleared ' + r.cleared + ' settled entr' + (r.cleared === 1 ? 'y' : 'ies') +
        (r.kept ? ', kept ' + r.kept + ' still in progress' : '') + '.',
        'success',
      )
      onChanged()
    } catch (e) {
      onMessage('Clear failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <details>
        <summary style={{ cursor: 'pointer', fontSize: '.9rem', color: 'var(--muted)' }}>
          Download Activity{' '}
          <span className="mono" style={{ fontSize: '.78rem' }}>
            {queue.length
              ? '(' + queue.length + ' recent' +
                (pending ? ', ' + pending + ' in progress' : '') +
                (failed ? ', ' + failed + ' failed' : '') + ')'
              : '(nothing yet)'}
          </span>
        </summary>

        <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="btn-secondary btn-sm"
            onClick={clear}
            disabled={busy || !queue.length}
            title="Clear finished and failed entries from this list. Downloads still in progress are kept, and no mod files are removed."
          >Clear</button>
        </div>

        <div style={{ marginTop: '.6rem' }}>
          {!queue.length ? <Empty>No download activity recorded</Empty> : (
            <table>
              <thead>
                <tr><th>Workshop ID</th><th>Status</th><th>Source</th><th>Updated</th><th /></tr>
              </thead>
              <tbody>
                {queue.slice(0, 60).map(e => {
                  const l = live.get(e.id)
                  const downloading = e.status === 'queued' && l?.status === 'downloading' && l.total > 0
                  return (
                    <tr key={e.id + e.queuedAt}>
                      <td>
                        <a
                          href={'https://steamcommunity.com/sharedfiles/filedetails/?id=' + e.id}
                          target="_blank" rel="noreferrer" className="mono"
                        >{e.id}</a>
                      </td>
                      <td>
                        {downloading
                          ? <span style={{ color: '#60a5fa' }}>Downloading {l.pct}%</span>
                          : <span style={{ color: STATUS_COLOUR[e.status] }}>{STATUS_LABEL[e.status] ?? e.status}</span>}
                        {e.error && (
                          <><br /><span style={{ fontSize: '.72rem', color: 'var(--muted)' }}>{e.error}</span></>
                        )}
                      </td>
                      <td className="text-muted" style={{ fontSize: '.78rem' }}>
                        {e.source === 'collection' ? 'Collection ' + (e.collectionId ?? '') : 'Single'}
                      </td>
                      <td className="text-muted" style={{ fontSize: '.74rem' }}>
                        {new Date(e.updatedAt || e.queuedAt).toLocaleString()}
                      </td>
                      <td>
                        {e.status === 'failed' && (
                          <button className="btn-secondary btn-sm" onClick={() => retry(e.id)}>Retry</button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </details>
    </div>
  )
}
