// Duplicate mod ids, and the mod folders banned from ever reaching the server.
//
// One Workshop item can ship several mod folders, and two of them can declare the same mod id. PZ
// loads whichever it scans first, so the server boots differently on consecutive restarts — the
// "restart it twice and it works" symptom. Nothing else in this UI can show that: the mods table is
// keyed by mod id, so the colliding folders collapse into one row. This panel is folder-level on
// purpose.

import { useState } from 'react'
import { api, ApiError } from '../../api/client'
import { useApi } from '../../api/hooks'
import type { ExcludesResponse } from '../../api/types'

export function Excludes({ onChanged, onMessage }: {
  onChanged: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
}) {
  const { data, reload } = useApi<ExcludesResponse>('/api/mods/excludes')
  const [busy, setBusy] = useState(false)

  if (!data) return null

  const duplicates = data.duplicates ?? []
  const rows = Object.entries(data.excludes ?? {})
    .flatMap(([workshopId, folders]) => folders.map(folder => ({ workshopId, folder })))

  if (!duplicates.length && !rows.length) return null

  const exclude = async (workshopId: string, folder: string, force = false) => {
    if (!force && !confirm('Exclude "' + folder + '" from Workshop item ' + workshopId + '?\n\n' +
      'Its files are deleted now and after every future download. Restart the server to apply.')) return

    setBusy(true)
    try {
      const r = await api.post<{ removed?: string[] }>('/api/mods/excludes', { workshopId, folder, force })
      onMessage(
        'Excluded ' + folder + '. Removed ' + (r.removed?.length ?? 0) + ' copy(ies). Restart the server to apply.',
        'success',
      )
      reload()
      onChanged()
    } catch (e) {
      // A 409 means the exclusion would leave a mod enabled in Mods= with nothing to load. That is
      // the state that makes PZ drop the mod's items from the save, so it is confirmed explicitly
      // rather than waved through.
      if (e instanceof ApiError && e.status === 409) {
        setBusy(false)
        if (confirm(e.message + '\n\nExclude it anyway?')) return exclude(workshopId, folder, true)
        return
      }
      onMessage('Error: ' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setBusy(false) }
  }

  const unexclude = async (workshopId: string, folder: string) => {
    if (!confirm('Stop excluding "' + folder + '"?\n\nThe folder is not restored now, it comes back the next time this item downloads.')) return
    setBusy(true)
    try {
      await api.del('/api/mods/excludes', { workshopId, folder })
      onMessage('No longer excluding ' + folder + '.', 'success')
      reload()
    } catch (e) {
      onMessage('Error: ' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setBusy(false) }
  }

  return (
    <>
      {duplicates.length > 0 && (
        <div className="card">
          <div className="card-title" style={{ color: '#e74c3c' }}>
            {duplicates.length} mod ID{duplicates.length > 1 ? 's are' : ' is'} claimed by more than one folder
          </div>
          <p className="text-muted" style={{ fontSize: '.82rem', margin: '.2rem 0 .9rem' }}>
            The server loads whichever folder it scans first, so it boots differently each restart.
            Exclude the folder you do not want and it stays gone through every future download.
          </p>

          {duplicates.map(d => (
            <div key={d.modId} style={{ marginBottom: '.8rem' }}>
              <div className="mono" style={{ fontSize: '.85rem', marginBottom: '.35rem' }}>{d.modId}</div>
              {d.providers.map(p => (
                <div
                  key={p.workshopId + '/' + p.folder}
                  style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap', margin: '.2rem 0 .2rem 1rem' }}
                >
                  <span className="mono" style={{ fontSize: '.76rem' }}>{p.workshopId} / {p.folder}</span>
                  <button
                    className="btn-secondary btn-sm"
                    disabled={busy}
                    onClick={() => exclude(p.workshopId, p.folder)}
                  >Exclude this folder</button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <div className="card-title">Excluded mod folders</div>
          <p className="text-muted" style={{ fontSize: '.82rem', margin: '.2rem 0 .9rem' }}>
            Deleted again after every download and before every start. Removing an entry here does not
            bring the folder back, it returns on the next download or reinstall of that item.
          </p>
          {rows.map(r => (
            <div
              key={r.workshopId + '/' + r.folder}
              style={{ display: 'flex', alignItems: 'center', gap: '.6rem', flexWrap: 'wrap', margin: '.25rem 0' }}
            >
              <span className="mono" style={{ fontSize: '.78rem' }}>{r.workshopId} / {r.folder}</span>
              <button
                className="btn-secondary btn-sm"
                disabled={busy}
                onClick={() => unexclude(r.workshopId, r.folder)}
              >Stop excluding</button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
