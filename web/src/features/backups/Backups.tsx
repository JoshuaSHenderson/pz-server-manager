// World saves, the player database, and config archives.
//
// Three kinds, listed separately because they mean different things: the image writes one at every
// start and one at every version change, and the third is whatever an operator has uploaded here.
//
// Every restore confirms first and says to stop the server, because a restore over a running world
// is how you get a save that is half one backup and half another.

import { useRef, useState } from 'react'
import { api, withServer } from '../../api/client'
import { useAction, useApi } from '../../api/hooks'
import type { BackupFile, BackupsResponse } from '../../api/types'
import { Card } from '../../components/Card'
import { Empty, MessageSlot, PaneHead } from '../../components/ui'

type BackupKind = 'startup' | 'version' | 'manual'

function size(bytes: number): string {
  return bytes > 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
    : (bytes / 1024).toFixed(0) + ' KB'
}

export function Backups() {
  const { data, loading, reload } = useApi<BackupsResponse>('/api/backups')
  const action = useAction()
  const [preparing, setPreparing] = useState(false)

  const restore = async (type: BackupKind, name: string) => {
    if (!confirm('Restore from "' + name + '"?\n\nWARNING: This will overwrite current world data and player database. Stop the server first!')) return
    action.setMessage({ text: 'Restoring from ' + name + '...', kind: 'info' })
    await action.run(
      () => api.post('/api/backups/restore', { type, name }),
      'Restored successfully from ' + name + '. Start the server to verify.',
    )
  }

  const download = () => {
    setPreparing(true)
    action.setMessage({ text: 'Building backup archive — this may take 30-60 seconds for large worlds.', kind: 'info' })
    // A navigation rather than fetch: the server streams the tar straight to the browser, and
    // buffering it through JS first would hold a whole world save in memory.
    const a = document.createElement('a')
    a.href = withServer('/api/backups/create')
    a.style.display = 'none'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => { setPreparing(false); action.setMessage(null) }, 5000)
  }

  return (
    <div className="tab-pane active">
      <PaneHead title="Backups" subtitle="World saves, player DB, and config archives" />
      <MessageSlot message={action.message} onClear={() => action.setMessage(null)} />

      <div className="grid2">
        <Card id="backups-download" title="Download Backup">
          <p style={{ fontSize: '.85rem', color: 'var(--muted)', marginBottom: '1rem' }}>
            Creates a .tar.gz with world saves, player DB, and server config. Stop the server first for cleanest backup.
          </p>
          <button className="btn-primary" onClick={download} disabled={preparing}>
            {preparing ? <><span className="spin" /> Preparing...</> : 'Download Now'}
          </button>
        </Card>

        <UploadRestore onRestored={reload} action={action} />
      </div>

      <Card
        id="backups-list"
        title="Server Backups"
        aside={<button className="btn-secondary btn-sm" onClick={e => { e.preventDefault(); reload() }}>Refresh</button>}
      >
        <Section
          label="Startup backups (auto, on each server start)"
          items={data?.startup} type="startup" loading={loading} onRestore={restore} busy={action.busy}
        />
        <Section
          label="Version backups (auto, on server update)"
          items={data?.version} type="version" loading={loading} onRestore={restore} busy={action.busy}
        />
        <Section
          label="Manual backups (previously uploaded restores)"
          items={data?.manual} type="manual" loading={loading} onRestore={restore} busy={action.busy}
        />
      </Card>
    </div>
  )
}

function Section({ label, items, type, loading, busy, onRestore }: {
  label: string
  items: BackupFile[] | undefined
  type: BackupKind
  loading: boolean
  busy: boolean
  onRestore: (type: BackupKind, name: string) => void
}) {
  return (
    <div className="backup-section">
      <div className="backup-section-label">{label}</div>
      {loading ? <Empty>Loading...</Empty>
        : !items?.length ? <div className="empty" style={{ padding: '1rem' }}>None</div>
          : (
            <table>
              <thead><tr><th>Name</th><th>Size</th><th>Date</th><th /></tr></thead>
              <tbody>
                {items.map(b => (
                  <tr key={b.name}>
                    <td className="mono" style={{ wordBreak: 'break-all' }}>{b.name}</td>
                    <td style={{ color: 'var(--muted)', whiteSpace: 'nowrap' }}>{size(b.size)}</td>
                    <td style={{ color: 'var(--muted)', fontSize: '.78rem', whiteSpace: 'nowrap' }}>
                      {new Date(b.mtime).toLocaleString()}
                    </td>
                    <td>
                      <div className="actions">
                        <a
                          href={withServer('/api/backups/download?type=' + type + '&name=' + encodeURIComponent(b.name))}
                          className="btn-secondary"
                          style={{
                            padding: '.3rem .65rem', fontSize: '.78rem', fontWeight: 600, borderRadius: 6,
                            display: 'inline-flex', alignItems: 'center', textDecoration: 'none',
                            border: '1px solid var(--border)',
                          }}
                        >Download</a>
                        <button className="btn-warn btn-sm" disabled={busy} onClick={() => onRestore(type, b.name)}>
                          Restore
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </div>
  )
}

/**
 * Upload an archive and restore from it.
 *
 * Still XMLHttpRequest rather than fetch, for the one thing fetch cannot do: report upload
 * progress. A world save is large enough that a button with no feedback reads as a hang.
 */
function UploadRestore({ onRestored, action }: {
  onRestored: () => void
  action: ReturnType<typeof useAction>
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState<number | null>(null)

  const start = () => {
    const file = fileRef.current?.files?.[0]
    if (!file) return action.setMessage({ text: 'Select a file first.', kind: 'error' })
    if (!file.name.endsWith('.zip') && !file.name.endsWith('.tar.gz')) {
      return action.setMessage({ text: 'Only .zip and .tar.gz files are supported.', kind: 'error' })
    }
    if (!confirm('Upload and restore from "' + file.name + '"?\n\nWARNING: This will overwrite current world data. Stop the server first!')) return

    const ext = file.name.endsWith('.tar.gz') ? 'tar.gz' : 'zip'
    setProgress(0)

    const xhr = new XMLHttpRequest()
    xhr.open('POST', withServer('/api/backups/upload'))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.setRequestHeader('X-Backup-Ext', ext)

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) setProgress(Math.round(e.loaded / e.total * 100))
    }

    xhr.onload = () => {
      setProgress(null)
      let body: { success?: boolean; error?: string } | null = null
      try { body = JSON.parse(xhr.responseText) } catch { /* fall through to the status message */ }
      if (body?.success) {
        action.setMessage({ text: 'Restored successfully from ' + file.name + '. Start the server to verify.', kind: 'success' })
        if (fileRef.current) fileRef.current.value = ''
        onRestored()
      } else {
        action.setMessage({ text: 'Restore failed: ' + (body?.error || 'server error (status ' + xhr.status + ')'), kind: 'error' })
      }
    }

    xhr.onerror = () => {
      setProgress(null)
      action.setMessage({ text: 'Upload failed — check network connection.', kind: 'error' })
    }

    xhr.send(file)
  }

  return (
    <Card id="backups-upload" title="Upload & Restore">
      <p style={{ fontSize: '.85rem', color: 'var(--muted)', marginBottom: '1rem' }}>
        Upload a .tar.gz or PZ native .zip backup. <strong style={{ color: 'var(--warn)' }}>Stop the server before restoring.</strong>
      </p>
      <div style={{ marginBottom: '.75rem' }}>
        <input ref={fileRef} type="file" accept=".zip,.tar.gz" style={{ width: '100%', marginBottom: '.5rem' }} />
      </div>
      <button className="btn-warn" onClick={start} disabled={progress !== null}>
        {progress !== null ? <><span className="spin" /> Uploading...</> : 'Upload & Restore'}
      </button>
      {progress !== null && (
        <div style={{ marginTop: '.75rem' }}>
          <div style={{ fontSize: '.78rem', color: 'var(--muted)', marginBottom: '.25rem' }}>
            Uploading {progress}%...
          </div>
          <div className="progress-bar-wrap">
            <div className="progress-bar" style={{ width: progress + '%' }} />
          </div>
        </div>
      )}
    </Card>
  )
}
