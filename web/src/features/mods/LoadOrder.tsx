// The load order editor.
//
// Mods= is load order: later entries win when two mods change the same thing, and mods with
// loadModAfter= expect to sit behind their dependencies. Edits are staged locally and only written
// when Save is pressed, so a mis-drag costs nothing until then.
//
// "Move to…" exists because with 170-odd mods, walking something from position 12 to 150 on the
// arrows is 138 clicks. It asks for the number only once pressed — a permanently open field on
// every row was worse, an editable box nothing tells you to submit.

import { useEffect, useState } from 'react'
import { api } from '../../api/client'
import { useApi } from '../../api/hooks'
import type { OrderEntry, OrderResponse } from '../../api/types'
import { Card } from '../../components/Card'

/** Move one entry to a new index, clamped. Mirrors moveItem() in lib/order.js. */
function move<T>(list: T[], from: number, to: number): T[] {
  const out = [...list]
  if (from < 0 || from >= out.length) return out
  const target = Math.max(0, Math.min(out.length - 1, to))
  const [item] = out.splice(from, 1)
  if (item !== undefined) out.splice(target, 0, item)
  return out
}

export function LoadOrder({ onSaved, onMessage }: {
  onSaved: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
}) {
  const { data, reload } = useApi<OrderResponse>('/api/mods/order')
  const [mods, setMods] = useState<OrderEntry[]>([])
  const [original, setOriginal] = useState<string[]>([])
  const [moveTo, setMoveTo] = useState<{ modId: string; value: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!data) return
    setMods(data.mods)
    setOriginal(data.mods.map(m => m.modId))
  }, [data])

  const dirty = mods.map(m => m.modId).join(' ') !== original.join(' ')

  const moveBy = (modId: string, delta: number) => {
    const from = mods.findIndex(m => m.modId === modId)
    if (from < 0) return
    setMods(m => move(m, from, from + delta))
  }

  const moveEdge = (modId: string, where: 'top' | 'bottom') => {
    const from = mods.findIndex(m => m.modId === modId)
    if (from < 0) return
    setMods(m => move(m, from, where === 'top' ? 0 : m.length - 1))
  }

  const commitMoveTo = () => {
    if (!moveTo) return
    const n = parseInt(moveTo.value, 10)
    // Blank or non-numeric just closes rather than moving anything somewhere surprising;
    // out-of-range clamps to the ends exactly like the Top/Bottom buttons.
    if (Number.isFinite(n)) {
      const from = mods.findIndex(m => m.modId === moveTo.modId)
      if (from >= 0) setMods(m => move(m, from, n - 1))
    }
    setMoveTo(null)
  }

  const save = async () => {
    const ids = mods.map(m => m.modId)
    if (!confirm('Save this load order?\n\n' + ids.length + ' mods. The current order is backed up first, and the server must be restarted to apply.')) return
    setBusy(true)
    try {
      const r = await api.put<{ count: number; backup: string }>('/api/mods/order', { mods: ids, label: 'manual reorder' })
      onMessage('Load order saved (' + r.count + ' mods). Previous order backed up as ' + r.backup + '. Restart to apply.', 'success')
      reload()
      onSaved()
    } catch (e) {
      onMessage('Could not save order: ' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setBusy(false) }
  }

  const restore = async (file: string) => {
    if (!confirm('Restore load order from ' + file + '?\n\nThe current order is backed up first. Restart the server to apply.')) return
    setBusy(true)
    try {
      const r = await api.post<{ count: number }>('/api/mods/order/restore', { file })
      onMessage('Restored ' + file + ' (' + r.count + ' mods). Restart to apply.', 'success')
      reload()
      onSaved()
    } catch (e) {
      onMessage('Could not restore: ' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setBusy(false) }
  }

  const backups = data?.backups ?? []

  return (
    <Card
      id="mods-order"
      title={
        <>Load order <span className="mono" style={{ fontSize: '.78rem', fontWeight: 400, color: 'var(--muted)' }}>({mods.length})</span></>
      }
      defaultOpen={false}
      aside={
        <span style={{ fontSize: '.75rem', color: 'var(--muted)' }}>
          Later entries win when two mods change the same thing · Move to… jumps a mod straight to a position
        </span>
      }
    >
      <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', margin: '.9rem 0 .6rem' }}>
        <button className="btn-primary btn-sm" onClick={save} disabled={!dirty || busy}>Save order</button>
        <button
          className="btn-secondary btn-sm"
          onClick={() => { setMods(data?.mods ?? []); setMoveTo(null) }}
          disabled={!dirty || busy}
        >Discard changes</button>
      </div>

      {dirty && (
        <div className="msg msg-info" style={{ marginBottom: '.6rem', fontSize: '.8rem' }}>
          Unsaved changes — nothing is written until you press Save order.
        </div>
      )}

      <div style={{ maxHeight: 420, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 3 }}>
        {mods.map((m, i) => (
          <div className="order-row" key={m.modId}>
            <span className="ord-num">{i + 1}</span>
            <span className="ord-label">
              {m.modId}
              {!m.installed && <span style={{ color: '#e74c3c', fontSize: '.68rem' }}> (not installed)</span>}
              {m.loadModAfter.length > 0 && (
                <span style={{ fontSize: '.68rem', color: '#60a5fa' }}> after: {m.loadModAfter.join(', ')}</span>
              )}
            </span>

            <button className="btn-secondary btn-sm ord-up" title="Move up one" onClick={() => moveBy(m.modId, -1)}>▲</button>
            <button className="btn-secondary btn-sm ord-down" title="Move down one" onClick={() => moveBy(m.modId, 1)}>▼</button>
            <button className="btn-secondary btn-sm" title="Move to top" onClick={() => moveEdge(m.modId, 'top')}>Top</button>
            <button className="btn-secondary btn-sm" title="Move to bottom" onClick={() => moveEdge(m.modId, 'bottom')}>Bottom</button>

            {moveTo?.modId === m.modId ? (
              <span className="ord-moveto">
                {/* text + inputmode=numeric rather than type=number: a number input renders spinner
                    arrows, which are the very click-one-at-a-time thing this replaces. */}
                <input
                  className="ord-pos"
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  autoFocus
                  aria-label="New position"
                  value={moveTo.value}
                  onChange={e => setMoveTo({ modId: m.modId, value: e.target.value })}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitMoveTo()
                    if (e.key === 'Escape') setMoveTo(null)
                  }}
                />
                <button className="btn-primary btn-sm" title="Move it there" onClick={commitMoveTo}>Go</button>
                <button className="btn-secondary btn-sm" title="Cancel" onClick={() => setMoveTo(null)}>✕</button>
              </span>
            ) : (
              <button
                className="btn-secondary btn-sm ord-moveto-btn"
                title="Move this mod to a position you choose"
                // Only one editor open at a time: half-typed boxes scattered down a 173-row list is
                // how you move the wrong mod.
                onClick={() => setMoveTo({ modId: m.modId, value: '' })}
              >Move to…</button>
            )}
          </div>
        ))}
      </div>

      {backups.length ? (
        <details style={{ marginTop: '.8rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '.76rem', color: 'var(--muted)' }}>
            Backups <span className="mono">({backups.length})</span>{' '}
            <span style={{ opacity: .7 }}>— a snapshot is taken automatically before every save</span>
          </summary>
          <div style={{ fontSize: '.76rem', color: 'var(--muted)', marginTop: '.5rem' }}>
            {backups.slice(0, 8).map(b => (
              <div key={b.file} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', padding: '.25rem 0',
              }}>
                <span className="mono">
                  {b.file} <span style={{ opacity: .7 }}>{b.label ? b.label + ' · ' : ''}{b.count} mods</span>
                </span>
                <button className="btn-secondary btn-sm" disabled={busy} onClick={() => restore(b.file)}>Restore</button>
              </div>
            ))}
          </div>
        </details>
      ) : (
        <div style={{ marginTop: '.8rem', fontSize: '.76rem', color: 'var(--muted)' }}>
          No backups yet — one is taken automatically before each save.
        </div>
      )}
    </Card>
  )
}
