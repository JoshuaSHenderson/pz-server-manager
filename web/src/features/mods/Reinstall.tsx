// Clean reinstall of one Workshop item.
//
// Long-running, and it takes the server down partway through, so the button only starts it and
// everything after that is read back from GET /api/mods/reinstall. Polled while it is running and
// left alone once it settles — there is nothing to watch on an idle server.

import { useApi } from '../../api/hooks'
import type { ReinstallResponse } from '../../api/types'

export function Reinstall() {
  // Five seconds while something is in flight. The hook's own poll skips hidden tabs, and the
  // interval is dropped entirely once the flow reports it has finished.
  const { data } = useApi<ReinstallResponse>('/api/mods/reinstall', { pollMs: 5000 })

  const st = data?.state
  if (!st) return null

  if (data.busy) {
    return (
      <div className="card">
        <div className="card-title">Reinstalling {st.workshopId}</div>
        <div style={{ fontSize: '.85rem' }}>{st.step}...</div>
        <p className="text-muted" style={{ fontSize: '.78rem', marginTop: '.5rem' }}>
          Scheduled restarts and mod auto-updates are paused until this finishes.
        </p>
      </div>
    )
  }

  if (st.ok) {
    return (
      <div className="card">
        <div className="card-title" style={{ color: '#2ecc71' }}>Reinstalled {st.workshopId}</div>
        <div style={{ fontSize: '.85rem' }}>
          Files replaced and the server is starting.
          {st.addedModIds?.length
            ? ' New mod id(s) added to the end of the load order: ' + st.addedModIds.join(', ') + '.'
            : ''}
        </div>
      </div>
    )
  }

  // The one outcome that needs a person: the swap failed and could not be undone, so the server is
  // stopped on purpose rather than booting a world whose Mods= names files that are not there.
  return (
    <div className="card">
      <div className="card-title" style={{ color: '#e74c3c' }}>
        {st.strandedDown
          ? 'Reinstall failed, server deliberately left stopped'
          : 'Reinstall of ' + st.workshopId + ' failed'}
      </div>
      <div style={{ fontSize: '.85rem' }}>{st.error || 'unknown error'}</div>

      {st.strandedDown ? (
        <p style={{ fontSize: '.82rem', marginTop: '.6rem' }}>
          Starting the server now would load the world without this mod, which permanently removes its
          items from every character and container. The old files are in{' '}
          <span className="mono">{st.quarantine || ''}</span> and must be restored before starting.
        </p>
      ) : (
        <p className="text-muted" style={{ fontSize: '.82rem', marginTop: '.6rem' }}>
          {st.rolledBack
            ? 'Rolled back, and the server is starting again.'
            : 'The server was not stopped and nothing changed.'}
        </p>
      )}
    </div>
  )
}
