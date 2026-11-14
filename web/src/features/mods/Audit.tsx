// What is actually on disk versus what servertest.ini claims.
//
// Half-removed mods leave files behind that nothing else in this UI surfaces, and they cost real
// disk. Four categories, two of which are files that can be deleted and two of which are ini
// problems that are fixed elsewhere — the panel never offers to delete the latter.

import { api } from '../../api/client'
import { useApi } from '../../api/hooks'
import type { AuditResponse } from '../../api/types'
import { Card } from '../../components/Card'

const mb = (b: number) => (b > 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.round(b / 1048576) + ' MB')

export function Audit({ onChanged, onMessage }: {
  onChanged: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
}) {
  const { data, reload } = useApi<AuditResponse>('/api/audit')
  if (!data) return null

  const problems = data.unregistered.length + data.orphanFolders.length +
    data.missingContent.length + data.phantomEnabled.length

  if (!problems) {
    return (
      <div className="msg msg-info" style={{ marginBottom: '1rem', fontSize: '.8rem' }}>
        Mod files match the config — {data.registered} registered, {data.enabled} loaded, {data.onDisk} on disk.{' '}
        {data.freeHuman} free.
      </div>
    )
  }

  const orphanCount = data.unregistered.length + data.orphanFolders.length

  const retry = async (workshopId: string) => {
    await api.post('/api/mods/retry', { workshopId }).catch(() => {})
    onMessage('Re-queued ' + workshopId + '.', 'info')
    onChanged()
  }

  const dropFromMods = async (modId: string) => {
    if (!confirm('Remove "' + modId + '" from the load order?\n\nNo mod provides this id, so nothing is currently loading from it.')) return
    try {
      await api.post('/api/mods/enabled', { modId, enabled: false })
      onMessage('Removed ' + modId + ' from Mods=.', 'success')
      reload()
      onChanged()
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const deleteOne = async (kind: 'workshop' | 'folder', id: string) => {
    if (!confirm('Delete ' + id + '?\n\nThis removes the files from disk. It is not referenced by servertest.ini, so nothing currently loaded is affected. Re-downloading later means fetching it from Steam again.')) return
    try {
      const r = await api.del<{ freed: string }>('/api/audit/orphan', { kind, id })
      onMessage('Deleted ' + id + ' — freed ' + r.freed + '.', 'success')
      reload()
    } catch (e) {
      onMessage('Could not delete ' + id + ': ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  // Two confirms: the first states what and how much, the second is a deliberate speed bump before
  // an irreversible bulk delete. The server recomputes the audit anyway, so a stale page can only
  // ever delete things that are still orphaned.
  const deleteAll = async () => {
    if (!orphanCount) return
    if (!confirm('Delete all ' + orphanCount + ' orphaned items?\n\n' +
      data.unregistered.length + ' unregistered Workshop item(s)\n' +
      data.orphanFolders.length + ' stray mods folder(s)\n\n' +
      'Frees roughly ' + data.reclaimableHuman + '. None are referenced by servertest.ini, so nothing currently loaded is affected.')) return
    if (!confirm('This cannot be undone.\n\nRe-downloading any of these later means fetching them from Steam again. Continue?')) return

    onMessage('Deleting ' + orphanCount + ' orphaned item(s)...', 'info')
    try {
      const r = await api.del<{ deleted: number; freed: string; failed: unknown[] }>('/api/audit/orphans')
      const failed = r.failed?.length ?? 0
      onMessage(
        'Deleted ' + r.deleted + ' orphaned item(s) — freed ' + r.freed + '.' +
        (failed ? ' ' + failed + ' could not be removed.' : ''),
        failed ? 'error' : 'success',
      )
      reload()
      onChanged()
    } catch (e) {
      onMessage('Delete all failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  return (
    <div style={{ marginBottom: '1rem', borderLeft: '3px solid #f5a623' }}>
      <Card
        id="mods-audit"
        title={
          <>Orphaned Mod Folders{' '}
            <span className="mono" style={{ fontSize: '.78rem', fontWeight: 400, color: 'var(--muted)' }}>({orphanCount})</span>
          </>
        }
        aside={
          <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>
            {data.registered} registered · {data.enabled} loaded · {data.onDisk} on disk ·{' '}
            <strong>{data.reclaimableHuman} reclaimable</strong> · {data.freeHuman} free
            <button
              className="btn-secondary btn-sm"
              style={{ marginLeft: '.4rem' }}
              onClick={e => { e.preventDefault(); reload() }}
            >Rescan</button>
            {orphanCount > 0 && (
              <button
                className="btn-danger btn-sm"
                style={{ marginLeft: '.4rem' }}
                onClick={e => { e.preventDefault(); void deleteAll() }}
              >Delete all ({orphanCount} · {data.reclaimableHuman})</button>
            )}
          </span>
        }
      >
        <Section title="Registered but no files on disk — the server cannot load these" count={data.missingContent.length}>
          {data.missingContent.map(id => (
            <Row key={id} label={id} note="in WorkshopItems, nothing downloaded">
              <button className="btn-secondary btn-sm" onClick={() => retry(id)}>Re-download</button>
            </Row>
          ))}
        </Section>

        <Section title="Enabled but not provided by any installed mod" count={data.phantomEnabled.length}>
          {data.phantomEnabled.map(id => (
            <Row key={id} label={id} note="in Mods= but no mod.info declares it">
              <button className="btn-secondary btn-sm" onClick={() => dropFromMods(id)}>Remove from Mods=</button>
            </Row>
          ))}
        </Section>

        <Section title="Downloaded but not registered — wasted disk" count={data.unregistered.length}>
          {data.unregistered.map(u => (
            <Row key={u.workshopId} label={u.workshopId} note={u.folders.slice(0, 2).join(', ') + ' · ' + mb(u.bytes)}>
              <button className="btn-danger btn-sm" onClick={() => deleteOne('workshop', u.workshopId)}>Delete</button>
            </Row>
          ))}
        </Section>

        <Section title="Stray folders in the server mods directory" count={data.orphanFolders.length}>
          {data.orphanFolders.map(o => (
            <Row key={o.folder} label={o.folder} note={mb(o.bytes) + ' · no registered Workshop item'}>
              <button className="btn-danger btn-sm" onClick={() => deleteOne('folder', o.folder)}>Delete</button>
            </Row>
          ))}
        </Section>
      </Card>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null
  return (
    <div style={{ marginBottom: '.7rem' }}>
      <div style={{
        fontSize: '.72rem', fontFamily: 'var(--font-mono)', textTransform: 'uppercase',
        letterSpacing: '.06em', color: 'var(--muted)', marginBottom: '.3rem',
      }}>{title} ({count})</div>
      {children}
    </div>
  )
}

function Row({ label, note, children }: { label: string; note?: string; children?: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem',
      padding: '.3rem .5rem', background: 'var(--bg)', marginBottom: '.2rem', borderRadius: 3,
    }}>
      <span style={{ fontSize: '.79rem', minWidth: 0, wordBreak: 'break-word' }}>
        <span className="mono">{label}</span>
        {note && <span style={{ color: 'var(--muted)', fontSize: '.72rem' }}> {note}</span>}
      </span>
      {children}
    </div>
  )
}
