// Tracked Workshop collections: listing, installing, syncing, untracking, and the auto-sync switch.

const registry = require('../registry/servers')
const { srv } = registry
const { getIniList } = require('../domain/ini')
const { readCollections, writeCollections } = require('../services/collections')
const {
  installCollection, allDroppedItems, readAutoSync, writeAutoSync,
} = require('../services/collection-sync')
const { removeWorkshopItem } = require('../services/install')
const { hasModContent } = require('../services/downloads')
const { getTitles } = require('../infra/steam')

const router = require('express').Router()

router.get('/api/collections', (req, res) => {
  const s = srv(req)
  const list = readCollections(s)
  const installed = new Set(getIniList(s, 'WorkshopItems'))
  const out = list.map(c => {
    const items = c.items || []
    const have = items.filter(id => installed.has(id) && hasModContent(s, id)).length
    return Object.assign({}, c, { itemCount: items.length, installedCount: have, missingCount: items.length - have })
  })
  getTitles(list.map(c => c.id), titles => {
    res.json({ collections: out.map(c => Object.assign(c, { title: c.title || titles[c.id] || '' })) })
  })
})

// Re-check a tracked collection against Steam and pull in anything new or missing.
router.post('/api/collections', (req, res) => {
  const s = srv(req)
  const { collectionId } = req.body || {}
  if (!collectionId || !/^\d+$/.test(collectionId)) return res.status(400).json({ error: 'Invalid collectionId' })
  installCollection(s, collectionId, (err, r) => {
    if (err) return res.status(502).json({ error: 'Could not read collection', detail: err.message })
    res.json(Object.assign({ success: true, collectionId }, r))
  })
})

// Re-check a tracked collection against Steam and pull in anything new or missing.
router.post('/api/collections/:id/sync', (req, res) => {
  const s = srv(req)
  const { id } = req.params
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid collection id' })
  installCollection(s, id, (err, r) => {
    if (err) return res.status(502).json({ error: 'Sync failed', detail: err.message })
    res.json(Object.assign({ success: true, collectionId: id }, r))
  })
})

router.get('/api/collections/dropped', (req, res) => res.json({ dropped: allDroppedItems(srv(req)) }))

// Clear an id from every collection's dropped list without touching the files. For the case where
// the operator decides to keep a mod the curator dropped — otherwise every sync re-reports it.
router.post('/api/collections/dropped/:workshopId/keep', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.params
  const list = readCollections(s)
  for (const c of list) {
    if (c.droppedItems) c.droppedItems = c.droppedItems.filter(id => id !== workshopId)
  }
  writeCollections(s, list)
  res.json({ success: true, id: workshopId })
})

// Stop tracking a collection. Mods it installed are left in place unless removeMods is set.
router.delete('/api/collections/:id', (req, res) => {
  const s = srv(req)
  const { id } = req.params
  const removeMods = String(req.query.removeMods) === 'true'
  const list = readCollections(s)
  const entry = list.find(c => c.id === id)
  writeCollections(s, list.filter(c => c.id !== id))
  let removed = 0
  if (removeMods && entry) {
    // Only remove items this collection uniquely owns — never yank a mod another tracked
    // collection still depends on.
    const othersOwn = new Set()
    for (const c of list) if (c.id !== id) for (const i of (c.items || [])) othersOwn.add(i)
    for (const wid of (entry.items || [])) {
      if (othersOwn.has(wid)) continue
      removeWorkshopItem(s, wid)
      removed++
    }
  }
  res.json({ success: true, removedMods: removed })
})

router.get('/api/collections/autosync', (req, res) => res.json(readAutoSync(srv(req))))

router.put('/api/collections/autosync', (req, res) => {
  const s = srv(req)
  const { enabled, intervalHours } = req.body || {}
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Invalid' })
  const iv = parseInt(intervalHours)
  if (![6, 12, 24, 48, 168].includes(iv)) return res.status(400).json({ error: 'Interval must be 6, 12, 24, 48 or 168 hours' })
  const cur = readAutoSync(s)
  writeAutoSync(s, Object.assign(cur, { enabled, intervalHours: iv }))
  res.json({ success: true })
})

module.exports = router
