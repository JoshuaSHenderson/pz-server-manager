// The installed-mods list, and the actions that change what is installed.
//
// Mounted after the excludes, order, drift, autoupdate and reinstall routers, because
// DELETE /api/mods/:workshopId would otherwise swallow every one of their paths.

const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const { getIniList, setIniList } = require('../domain/ini')
const {
  modIdsFromWorkshop, modNamesFromWorkshop, 
} = require('../domain/modinfo')
const {
  readQueue, writeQueue, hasModContent, steamcmdDownload,
} = require('../services/downloads')
const { removeWorkshopItem } = require('../services/install')
const { readCollections, writeCollections } = require('../services/collections')
const { getTitles, getCachedTags, steamCollectionDetails } = require('../infra/steam')
const { validWorkshopId } = require('../../lib/excludes')

const router = require('express').Router()

router.get('/api/mods', (req, res) => {
  const s = srv(req)
  const workshopIds = getIniList(s, 'WorkshopItems')
  const queue = readQueue(s)
  const qById = {}
  for (const e of queue) qById[e.id] = e

  // Which collection(s) each mod came from. The registry is authoritative (it's re-resolved on
  // every sync); the queue's collectionId is a fallback for mods installed before a collection
  // was tracked. A mod can legitimately belong to more than one collection.
  const collections = readCollections(s)
  const byMod = {}
  for (const c of collections) {
    for (const item of (c.items || [])) {
      if (!byMod[item]) byMod[item] = []
      if (!byMod[item].some(x => x.id === c.id)) byMod[item].push({ id: c.id, title: c.title || '' })
    }
  }
  for (const [wid, q] of Object.entries(qById)) {
    if (!q.collectionId) continue
    if (!byMod[wid]) byMod[wid] = []
    if (!byMod[wid].some(x => x.id === q.collectionId)) byMod[wid].push({ id: q.collectionId, title: '' })
  }

  // A Workshop item can ship several mod ids (Authentic Z packs Current/Lite/Backpacks+ into one),
  // and Mods= decides which of them the server actually loads. Report that per id so the UI can
  // toggle them individually instead of only offering to delete the whole item.
  const modsList = getIniList(s, 'Mods')
  const enabledIds = new Set(modsList)
  // Position in Mods= is load order. A Workshop item can ship several mod ids, so an item can
  // occupy several positions — report each, and the earliest for sorting.
  const orderIndex = {}
  modsList.forEach((id, i) => { orderIndex[id] = i })

  const base = workshopIds.map(wid => {
    const modIds = modIdsFromWorkshop(s, wid)
    const folders = modNamesFromWorkshop(s, wid)
    const q = qById[wid]
    let status = 'ok'
    if (!modIds.length) status = (q && q.status === 'collection') ? 'collection' : 'missing'
    const enabled = modIds.filter(id => enabledIds.has(id))
    const positions = enabled.map(id => orderIndex[id])
    return {
      workshopId: wid, modIds, modFolders: folders, status,
      enabledIds: enabled,
      // 1-based to match what the load-order editor shows.
      orderPositions: positions.map(i => i + 1),
      minOrder: positions.length ? Math.min.apply(null, positions) + 1 : null,
      loadOrderTotal: modsList.length,
      error: (q && q.error) || null,
      collections: byMod[wid] || []
    }
  })

  // Resolve titles for the mods and for any collection we don't already have a name for.
  const needTitles = workshopIds.concat(
    base.reduce((acc, m) => acc.concat(m.collections.filter(c => !c.title).map(c => c.id)), [])
  )
  getTitles([...new Set(needTitles)], titles => {
    res.json({
      mods: base.map(m => Object.assign(m, {
        tags: getCachedTags(m.workshopId),
        title: titles[m.workshopId] || '',
        collections: m.collections.map(c => ({ id: c.id, title: c.title || titles[c.id] || '' }))
      }))
    })
  })
})

router.post('/api/mods/install', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.body
  if (!workshopId || !/^\d+$/.test(workshopId)) return res.status(400).json({ error: 'Invalid workshopId' })
  steamcmdDownload(s, [workshopId], 'single', null)
  res.json({ success: true, workshopId, queued: true })
})

router.post('/api/mods/retry', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.body
  if (!workshopId || !/^\d+$/.test(workshopId)) return res.status(400).json({ error: 'Invalid workshopId' })
  steamcmdDownload(s, [workshopId], 'single', null)
  res.json({ success: true, workshopId, queued: true })
})

// Re-queues every mod currently registered but missing its files, and drops stale ini entries
// for anything Steam says is actually a collection.
router.post('/api/mods/repair', (req, res) => {
  const s = srv(req)
  const broken = getIniList(s, 'WorkshopItems').filter(id => !hasModContent(s, id))
  if (!broken.length) return res.json({ success: true, repaired: 0, collections: 0 })
  steamCollectionDetails(broken, (err, collMap) => {
    const colls = Object.keys(collMap || {})
    const retryable = broken.filter(id => !colls.includes(id))
    // Collections aren't mods: unregister them and install their children instead.
    if (colls.length) {
      setIniList(s, 'WorkshopItems', getIniList(s, 'WorkshopItems').filter(id => !colls.includes(id)))
      for (const cid of colls) {
        const kids = collMap[cid].filter(k => !getIniList(s, 'WorkshopItems').includes(k))
        if (kids.length) steamcmdDownload(s, kids, 'collection', cid)
      }
    }
    if (retryable.length) steamcmdDownload(s, retryable, 'single', null)
    res.json({ success: true, repaired: retryable.length, collections: colls.length })
  })
})

// Toggle one mod id in Mods= without touching WorkshopItems or any files on disk. Needed because
// variant packs ship mutually exclusive mods in a single Workshop item — Authentic Z's Current and
// Lite both register the same az:* item_body_location ids, so loading both throws
// "Tried to register duplicate object" and kills the client's Lua reset on connect. Deleting the
// item to drop one variant would take the others' files with it.
// Re-enabling appends to the end of Mods= (same as install does); load order is not preserved.
router.post('/api/mods/enabled', (req, res) => {
  const s = srv(req)
  const { modId, enabled } = req.body || {}
  if (typeof modId !== 'string' || !modId) return res.status(400).json({ error: 'modId required' })
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' })
  // Only ids belonging to an installed Workshop item may be written, so a stale UI can't inject
  // a name the server would then fail to load.
  const known = new Set(getIniList(s, 'WorkshopItems').flatMap(wid => modIdsFromWorkshop(s, wid)))
  if (!known.has(modId)) return res.status(400).json({ error: 'Unknown mod id: ' + modId })
  const rest = getIniList(s, 'Mods').filter(id => id !== modId)
  setIniList(s, 'Mods', enabled ? [...rest, modId] : rest)
  logFor(s, (enabled ? 'enabled' : 'disabled') + ' mod "' + modId + '" (' + (enabled ? rest.length + 1 : rest.length) + ' loaded)')
  res.json({ success: true, modId, enabled })
})

router.delete('/api/mods/:workshopId', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.params
  // Checked before use: it selects the files this deletes.
  if (!validWorkshopId(workshopId)) return res.status(400).json({ error: 'workshopId must be digits' })
  const { removedIds, removedFolders } = removeWorkshopItem(s, workshopId)
  logFor(s, 'removed Workshop item ' + workshopId + ' - mod ids [' + removedIds.join(', ') + '], folders [' + removedFolders.join(', ') + ']')
  writeQueue(s, readQueue(s).filter(e => e.id !== workshopId))
  // Whatever the reason for removal, it is no longer outstanding. Clearing it here rather than
  // waiting for the next sync is what makes the "remove it" button in the dropped-mods panel
  // settle immediately instead of leaving a row that looks like it did nothing.
  const colls = readCollections(s)
  let clearedDropped = false
  for (const c of colls) {
    if (c.droppedItems && c.droppedItems.includes(workshopId)) {
      c.droppedItems = c.droppedItems.filter(id => id !== workshopId)
      clearedDropped = true
    }
  }
  if (clearedDropped) writeCollections(s, colls)
  res.json({ success: true, workshopId, removedIds, removedFolders })
})

module.exports = router
