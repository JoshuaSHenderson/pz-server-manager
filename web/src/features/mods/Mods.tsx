// The Mods tab.
//
// Panel order is deliberate and runs worst-first:
//
//   1. drift        — enabled mods no player can download. Stops people joining at all.
//   2. dropped      — mods the curator removed that the server is still loading.
//   3. downloading  — a strip, only while something is in flight.
//   ...then the things you go looking for rather than are told about.
//
// One `refresh` counter is threaded through every panel because the panels are not independent:
// toggling a mod id changes the dependency analysis, excluding a folder changes the audit, and a
// sync changes the download queue. Passing a bump rather than letting each panel poll on its own
// keeps the fan-out to one round of requests after an action, instead of nine timers.

import { useCallback, useState } from 'react'
import { api } from '../../api/client'
import { useApi } from '../../api/hooks'
import type { DownloadsResponse, ModsResponse } from '../../api/types'
import { MessageSlot, PaneHead, type MessageKind } from '../../components/ui'
import { AddContent } from './AddContent'
import { Audit } from './Audit'
import { Collections, DroppedMods } from './Collections'
import { Dependencies } from './Dependencies'
import { DownloadActivity, DownloadBanner } from './Downloads'
import { Drift } from './Drift'
import { Excludes } from './Excludes'
import { LoadOrder } from './LoadOrder'
import { ModsTable } from './ModsTable'
import { Reinstall } from './Reinstall'

export function Mods() {
  const [message, setMessage] = useState<{ text: string; kind: MessageKind } | null>(null)
  // Bumped after any action that changes what another panel would show.
  const [refresh, setRefresh] = useState(0)
  const bump = useCallback(() => setRefresh(n => n + 1), [])

  const onMessage = useCallback((text: string, kind: MessageKind) => setMessage({ text, kind }), [])

  const mods = useApi<ModsResponse>('/api/mods', { deps: [refresh] })
  // Five seconds: this is the only thing on the page that changes without anyone pressing a button.
  const downloads = useApi<DownloadsResponse>('/api/downloads', { pollMs: 5000, deps: [refresh] })

  const restart = async () => {
    if (!confirm('Restart? Players will be disconnected.')) return
    try {
      await api.post('/api/server/restart')
      onMessage('Server restart OK.', 'success')
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e), 'error')
    }
  }

  const reinstall = async (workshopId: string) => {
    if (!confirm('Reinstall Workshop item ' + workshopId + ' from Steam?\n\n' +
      'The server keeps running during the download, then stops while the files are swapped and ' +
      'starts again. The old files are kept so a failure can be rolled back.\n\n' +
      'Do this with nobody connected.')) return
    try {
      await api.post('/api/mods/' + workshopId + '/reinstall')
      onMessage('Reinstalling ' + workshopId + '...', 'info')
      bump()
    } catch (e) {
      onMessage('Error: ' + (e instanceof Error ? e.message : String(e)), 'error')
    }
  }

  const active = downloads.data?.active ?? []

  return (
    <div className="tab-pane active">
      <PaneHead title="Mods" subtitle="Steam Workshop content installed on the server" />
      <MessageSlot message={message} onClear={() => setMessage(null)} />

      {/* Above even the dropped-mod banner: a dropped mod still lets people play, this stops them
          joining at all. Renders nothing when clean. */}
      <Drift onChanged={bump} onMessage={onMessage} onRestart={restart} />
      <DroppedMods onChanged={bump} onMessage={onMessage} onRestart={restart} />
      <DownloadBanner active={active} />

      <AddContent onChanged={bump} onMessage={onMessage} />
      <Collections onChanged={bump} onMessage={onMessage} />

      {/* Each of these renders its own card, so they are siblings rather than nested inside the
          installed-mods list. */}
      <Dependencies onChanged={bump} onMessage={onMessage} />
      <Audit onChanged={bump} onMessage={onMessage} />
      <LoadOrder onSaved={bump} onMessage={onMessage} />
      <Reinstall />
      <Excludes onChanged={bump} onMessage={onMessage} />

      <ModsTable
        mods={mods.data?.mods ?? []}
        active={active}
        loading={mods.loading}
        onChanged={bump}
        onMessage={onMessage}
        onReinstall={reinstall}
      />

      <DownloadActivity
        queue={downloads.data?.queue ?? []}
        active={active}
        onChanged={bump}
        onMessage={onMessage}
      />
    </div>
  )
}
