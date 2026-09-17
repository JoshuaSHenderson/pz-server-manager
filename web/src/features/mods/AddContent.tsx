// Adding a mod or a collection.
//
// Both accept a bare ID or a full Workshop URL, because that is what is on the clipboard when
// someone is looking at a mod page.

import { useState } from 'react'
import { api } from '../../api/client'
import { Card } from '../../components/Card'

/** The first run of six or more digits — the shape of every Workshop id. */
function parseWorkshopId(raw: string): string {
  return /(\d{6,})/.exec(raw)?.[1] ?? ''
}

export function AddContent({ onChanged, onMessage }: {
  onChanged: () => void
  onMessage: (text: string, kind: 'success' | 'error' | 'info') => void
}) {
  const [modInput, setModInput] = useState('')
  const [collInput, setCollInput] = useState('')
  const [busy, setBusy] = useState<'mod' | 'collection' | null>(null)

  const addMod = async () => {
    const workshopId = parseWorkshopId(modInput)
    if (!workshopId) return onMessage('Enter a Workshop mod ID or URL.', 'error')
    setBusy('mod')
    try {
      await api.post('/api/mods/install', { workshopId })
      setModInput('')
      onMessage('Queued ' + workshopId + '. It appears below once downloaded — restart the server to load it.', 'success')
      onChanged()
    } catch (e) {
      onMessage('Failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setBusy(null) }
  }

  const addCollection = async () => {
    const collectionId = parseWorkshopId(collInput)
    if (!collectionId) return onMessage('Enter a Workshop collection ID or URL.', 'error')
    setBusy('collection')
    onMessage('Resolving collection ' + collectionId + ' (including nested collections)...', 'info')
    try {
      const r = await api.post<{ total: number; queued: number; nested: number }>('/api/collections', { collectionId })
      setCollInput('')
      onMessage(
        'Collection tracked: ' + r.total + ' mod(s) total, ' + r.queued + ' queued for download' +
        (r.nested ? ' (' + r.nested + ' nested collection(s) expanded)' : '') + '.',
        'success',
      )
      onChanged()
    } catch (e) {
      onMessage('Failed: ' + (e instanceof Error ? e.message : String(e)), 'error')
    } finally { setBusy(null) }
  }

  return (
    <Card id="mods-add" title="Add Content">
      <div style={{ marginTop: '.9rem' }} />
      <div className="row" style={{ marginBottom: '.6rem' }}>
        <input
          type="text"
          placeholder="Workshop mod ID or URL"
          value={modInput}
          onChange={e => setModInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void addMod() }}
        />
        <button className="btn-primary" onClick={addMod} disabled={busy !== null}>
          {busy === 'mod' ? <><span className="spin" /> Adding...</> : 'Add Mod'}
        </button>
      </div>

      <div className="row">
        <input
          type="text"
          placeholder="Workshop collection ID or URL"
          value={collInput}
          onChange={e => setCollInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void addCollection() }}
        />
        <button className="btn-primary" onClick={addCollection} disabled={busy !== null}>
          {busy === 'collection' ? <><span className="spin" /> Resolving...</> : 'Add Collection'}
        </button>
      </div>

      <p style={{ marginTop: '.6rem', fontSize: '.78rem', color: 'var(--muted)' }}>
        Paste an ID or a full <span className="mono">steamcommunity.com/sharedfiles/filedetails/?id=…</span> URL.
        Collections are tracked below and expand nested collections automatically.
      </p>
    </Card>
  )
}
