// Enabled mods that load here but no client can download.
//
// The wording is the whole point of this panel. The operator is looking at mods that work
// perfectly from the server's side, so nothing appears broken — the damage is only visible to a
// player trying to join, who is told the mod "is not installed [WorkshopID: ]" and bounces.
//
// So the card leads with the player-facing symptom, and every button says what it changes before
// it is pressed: an ID in a list, not a file on disk.

import { api } from '../../api/client'
import { useApi } from '../../api/hooks'
import type { DriftIssue, DriftReport } from '../../api/types'

function SafetyBadge({ identical }: { identical: boolean | null }) {
  if (identical === true) {
    return <span style={{ color: '#3ba55d', fontSize: '.75rem', whiteSpace: 'nowrap' }}>Same files — safe</span>
  }
  if (identical === false) {
    return <span style={{ color: '#e05252', fontSize: '.75rem', whiteSpace: 'nowrap' }}>Different build — can delete items</span>
  }
  return <span className="text-muted" style={{ fontSize: '.75rem', whiteSpace: 'nowrap' }}>Cannot compare</span>
}

export function Drift({ onChanged, onMessage, onRestart }: {
  onChanged: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
  onRestart: () => void
}) {
  const { data, reload } = useApi<DriftReport>('/api/mods/drift')
  if (!data) return null

  const { issues, stale } = data
  if (!issues.length && !stale.length) return null

  const repair = async (i: DriftIssue) => {
    const to = i.suggest[0]
    if (!to) return
    const identical = i.buildsIdentical === true

    const msg =
      'Rename "' + i.id + '" to "' + to + '" in the server\'s mod list?\n\n' +
      'What this changes: one ID in the mod list.\n' +
      'What it does NOT change: no files are downloaded, deleted or moved, and load order stays the same.\n' +
      'The current mod list is backed up first.\n\n' +
      (identical
        ? 'The server\'s copy and the Workshop copy of this mod are identical apart from the ID, so nothing in your world changes.'
        : 'WARNING: the server\'s copy and the Workshop copy are DIFFERENT BUILDS. After this the game loads the ' +
          'Workshop build, and Project Zomboid permanently deletes any item whose ID that build no longer defines — ' +
          'from player inventories, containers and vehicles alike. Back up your save first if you are unsure.') +
      '\n\nRestart the server afterwards to apply.'

    if (!confirm(msg)) return

    try {
      const r = await api.post<{ backup: string }>('/api/mods/drift/repair', {
        remaps: [{ from: i.id, to }],
        acceptItemLoss: !identical,
      })
      onMessage('Renamed ' + i.id + ' to ' + to + '. Restart to apply. Previous mod list saved as ' + r.backup + '.', 'success')
      reload()
      onChanged()
    } catch (e) {
      onMessage('Error: ' + (e instanceof Error ? e.message : 'repair refused'), 'error')
    }
  }

  return (
    <>
      {issues.length > 0 && (
        <div className="card" style={{ marginBottom: '1.4rem', borderLeft: '3px solid #e05252' }}>
          <div className="card-title" style={{ marginBottom: '.5rem' }}>
            {issues.length} enabled mod(s) players cannot download
          </div>

          <p style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: '.9rem' }}>
            These mods load fine <em>on the server</em>, so nothing looks wrong from here — but no Workshop item
            publishes their ID any more, usually because the author renamed it. Anyone trying to join is told{' '}
            <span className="mono" style={{ fontSize: '.75rem' }}>Mod "…" is not installed [ModID: …, WorkshopID: ]</span>{' '}
            and is refused.
          </p>

          <p style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: '.9rem' }}>
            <strong>Rename ID</strong> changes the ID in the server's mod list to the one Steam publishes today.
            It downloads nothing, deletes nothing, and leaves load order untouched — the previous list is backed
            up first. Restart afterwards to apply.
          </p>

          <table>
            <thead>
              <tr><th>ID in mod list</th><th>Should be</th><th>Workshop item</th><th>Safety</th><th /></tr>
            </thead>
            <tbody>
              {issues.map(i => {
                const target = i.suggest[0]
                const workshopId = (i as DriftIssue & { workshopId?: string }).workshopId
                return (
                  <tr key={i.id}>
                    <td><span className="mono" style={{ fontSize: '.78rem' }}>{i.id}</span></td>
                    <td>
                      {target
                        ? <span className="mono" style={{ fontSize: '.78rem' }}>{target}</span>
                        : <span className="text-muted">—</span>}
                    </td>
                    <td>
                      {workshopId
                        ? (
                          <a
                            href={'https://steamcommunity.com/sharedfiles/filedetails/?id=' + workshopId}
                            target="_blank" rel="noreferrer" className="mono" style={{ fontSize: '.75rem' }}
                          >{workshopId}</a>
                        )
                        : <span className="text-muted" style={{ fontSize: '.75rem' }}>{i.folder || '—'}</span>}
                    </td>
                    <td>{i.kind === 'clientBlocked' ? <SafetyBadge identical={i.buildsIdentical} /> : null}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {i.kind === 'clientBlocked' && i.suggest.length === 1 && target ? (
                        <button
                          className={(i.buildsIdentical === false ? 'btn-warn' : 'btn-primary') + ' btn-sm'}
                          onClick={() => repair(i)}
                          title={'Changes this mod\'s ID in the server\'s mod list from ' + i.id + ' to ' + target +
                            '. No files are downloaded, deleted or moved.'}
                        >Rename ID{i.buildsIdentical === false ? '…' : ''}</button>
                      ) : i.kind === 'clientBlocked' ? (
                        <span className="text-muted" style={{ fontSize: '.75rem' }}>
                          Two Workshop items use this folder — fix by hand
                        </span>
                      ) : i.kind === 'localOnly' ? (
                        <span className="text-muted" style={{ fontSize: '.75rem' }}>No Workshop item ships it</span>
                      ) : (
                        <span className="text-muted" style={{ fontSize: '.75rem' }}>Not on disk at all</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '.9rem' }}>
            <button className="btn-warn btn-sm" onClick={onRestart}>Restart Server</button>
          </div>
        </div>
      )}

      {stale.length > 0 && <StaleCopies stale={stale} />}
    </>
  )
}

/**
 * Report-only, and collapsed.
 *
 * This is where the next drift comes from, but refreshing a stale copy swaps the build the game
 * loads and PZ discards items the new build no longer defines. That is a decision, not a button.
 */
function StaleCopies({ stale }: { stale: DriftReport['stale'] }) {
  return (
    <div className="card" style={{ marginBottom: '1.4rem' }}>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: '.9rem', color: 'var(--muted)' }}>
          {stale.length} stale duplicate mod cop(ies){' '}
          <span style={{ opacity: .75 }}>— not in use, no action needed</span>
        </summary>

        <p style={{ fontSize: '.8rem', color: 'var(--muted)', margin: '.9rem 0' }}>
          Every mod exists twice: SteamCMD's download under <span className="mono" style={{ fontSize: '.75rem' }}>install/</span>,
          and a copy the manager keeps under <span className="mono" style={{ fontSize: '.75rem' }}>&lt;data&gt;/mods</span>.
          An auto-update refreshes the download but not that second copy, so these have fallen behind.
        </p>

        <p style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: '.9rem' }}>
          <strong>The game is not loading these.</strong> When a mod folder exists in both places the{' '}
          <span className="mono" style={{ fontSize: '.75rem' }}>install/</span> copy wins, so the server is already
          running the current build of every mod listed here. They are dead weight, not a live problem.
        </p>

        <p style={{ fontSize: '.8rem', color: 'var(--muted)', marginBottom: '.9rem' }}>
          They are worth watching for one reason: if a mod ever ends up present <em>only</em> in{' '}
          <span className="mono" style={{ fontSize: '.75rem' }}>&lt;data&gt;/mods</span>, the stale copy becomes what
          loads — and no client can download it, which is the "not installed [WorkshopID: ]" failure above. No button,
          because refreshing one swaps the build the game would load and Project Zomboid deletes items a newer build
          no longer defines.
        </p>

        <table>
          <thead>
            <tr><th>Mod folder</th><th>Server has</th><th>Workshop has</th><th>Item</th></tr>
          </thead>
          <tbody>
            {stale.map(t => (
              <tr key={t.folder}>
                <td><span className="mono" style={{ fontSize: '.78rem' }}>{t.folder}</span></td>
                <td className="mono" style={{ fontSize: '.78rem' }}>{t.local || 'none'}</td>
                <td className="mono" style={{ fontSize: '.78rem' }}>{t.workshop}</td>
                <td>
                  <a
                    href={'https://steamcommunity.com/sharedfiles/filedetails/?id=' + t.workshopId}
                    target="_blank" rel="noreferrer" className="mono" style={{ fontSize: '.75rem' }}
                  >{t.workshopId}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}
