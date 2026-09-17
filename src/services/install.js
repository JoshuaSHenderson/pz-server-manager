// Removing a Workshop item.
//
// The one removal path, so the three callers - a manual delete, untracking a collection with
// removeMods, and clearing a mod the curator dropped - cannot drift apart in what they leave
// behind. Nothing removes a mod on a timer; a sync only ever reports what the curator dropped, and
// an operator acts on it.

const fs = require('fs')
const path = require('path')
const { modsDir } = require('../paths')
const { getIniList, setIniList } = require('../domain/ini')
const { modIdsFromWorkshop, modNamesFromWorkshop } = require('../domain/modinfo')

/** @typedef {import('../paths').Server} Server */

// The one removal path for a Workshop item: delete the copied mod folders, then drop the item
// from WorkshopItems= and its mod ids from Mods=. Manual removal, untracking a collection with
// removeMods, and clearing a dropped mod all route through here so they can't drift apart.
// Nothing removes a mod on a timer — a sync only ever reports what the curator dropped.
function removeWorkshopItem(s, workshopId) {
  const removedIds = modIdsFromWorkshop(s, workshopId)
  const removedFolders = modNamesFromWorkshop(s, workshopId)
  for (const folder of removedFolders) {
    const dest = path.join(modsDir(s), folder)
    try { fs.rmSync(dest, { recursive: true, force: true }) }
    catch (e) { console.error('[remove] could not delete mod folder "' + folder + '": ' + e.message) }
  }
  setIniList(s, 'WorkshopItems', getIniList(s, 'WorkshopItems').filter(id => id !== workshopId))
  setIniList(s, 'Mods', getIniList(s, 'Mods').filter(id => !removedIds.includes(id)))
  return { removedIds, removedFolders }
}

module.exports = { removeWorkshopItem }
