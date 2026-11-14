// Mod folders banned from ever reaching the server, and the duplicate mod ids that motivate
// most exclusions.
//
// Registered ahead of the mods router, which would otherwise match "excludes" as a Workshop id and
// try to uninstall it.

const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const { getIniList } = require('../domain/ini')
const { duplicateModIds, modIdsByFolder } = require('../domain/modinfo')
const { readExcludes, writeExcludes, applyExcludes } = require('../services/excludes')
const {
  addExclude, removeExclude, validFolder, validWorkshopId,
} = require('../../lib/excludes')

const router = require('express').Router()

router.get('/api/mods/excludes', (req, res) => {
  const s = srv(req)
  res.json({ excludes: readExcludes(s), duplicates: duplicateModIds(s) })
})

router.post('/api/mods/excludes', (req, res) => {
  const s = srv(req)
  const { workshopId, folder, force } = req.body || {}
  if (!validWorkshopId(workshopId)) return res.status(400).json({ error: 'workshopId must be digits' })
  if (!validFolder(folder)) return res.status(400).json({ error: 'Invalid folder name' })

  // The guard that matters. Excluding the only folder providing an enabled mod id would leave
  // Mods= naming a mod the server can no longer load, and PZ starting without a mod is what
  // strips that mod's items out of every character and container in the save. Refusing is
  // recoverable; discovering it after a boot is not. force:true is the deliberate override.
  const rows = modIdsByFolder(s)
  const mine = rows.filter(r => r.workshopId === workshopId && r.folder === folder)
  if (!mine.length && !force) {
    return res.status(404).json({ error: 'No mod folder "' + folder + '" found in Workshop item ' + workshopId })
  }
  const enabled = new Set(getIniList(s, 'Mods'))
  const orphaned = mine
    .map(r => r.modId)
    .filter(id => enabled.has(id))
    .filter(id => !rows.some(r => r.modId === id && !(r.workshopId === workshopId && r.folder === folder)))
  if (orphaned.length && !force) {
    return res.status(409).json({
      error: 'Excluding ' + folder + ' would leave ' + orphaned.join(', ') + ' enabled in Mods= with nothing to load. Disable the mod first, or re-send with force to accept that.',
      orphaned,
    })
  }

  let next
  try { next = addExclude(readExcludes(s), workshopId, folder) }
  catch (e) { return res.status(400).json({ error: e.message }) }
  try { writeExcludes(s, next) }
  catch (e) { return res.status(500).json({ error: 'Could not save exclusions: ' + e.message }) }

  logFor(s, 'excluding mod folder ' + workshopId + '/' + folder + (orphaned.length ? ' (forced, orphans ' + orphaned.join(', ') + ')' : ''))
  const removed = applyExcludes(s)
  res.json({ success: true, workshopId, folder, removed, orphaned })
})

router.delete('/api/mods/excludes', (req, res) => {
  const s = srv(req)
  const { workshopId, folder } = req.body || {}
  if (!validWorkshopId(workshopId)) return res.status(400).json({ error: 'workshopId must be digits' })
  if (!validFolder(folder)) return res.status(400).json({ error: 'Invalid folder name' })
  try { writeExcludes(s, removeExclude(readExcludes(s), workshopId, folder)) }
  catch (e) { return res.status(500).json({ error: 'Could not save exclusions: ' + e.message }) }
  // Nothing is restored here — the folder comes back on the item's next download or reinstall.
  logFor(s, 'no longer excluding mod folder ' + workshopId + '/' + folder + ' — returns on its next download')
  res.json({ success: true, workshopId, folder })
})

module.exports = router
