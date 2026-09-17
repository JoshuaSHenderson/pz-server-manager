// Mod folders that must never reach the server, and the sweep that enforces it.
//
// See lib/excludes.js for the reasoning; the short version is that a Workshop item can ship a
// folder that breaks the server, Steam re-ships it on every download, and the only durable answer
// is to delete it again after each one. This file is the side-effecting half: the persisted list,
// and the one function that removes the folders from disk.

const fs = require('fs')
const path = require('path')
const { excludesPath, modsDir, workshopContent, installContent } = require('../paths')
const { readJson, writeJson, safeReaddir } = require('../util/fsx')
const { allExcludes, isExcluded, removalTargets, validFolder, validWorkshopId } = require('../../lib/excludes')
const { getIniList } = require('../domain/ini')
const { logFor } = require('../log')
const { modFolders } = require('../domain/modinfo')

/** @typedef {import('../paths').Server} Server */

// ===== EXCLUDED MOD FOLDERS =====
//
// See excludes.js for why this exists. Short version: a Workshop item can ship a folder that
// breaks the server, Steam re-ships it on every download, and the only durable answer is to
// delete it again after each one.
function readExcludes(s) {
  try {
    const v = JSON.parse(fs.readFileSync(excludesPath(s), 'utf8'))
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
  } catch { return {} }
}
// Deliberately allowed to throw, unlike writeDepIgnores: a silently dropped write here means the
// exclusion is gone on the next download and the server quietly goes back to booting wrong.
function writeExcludes(s, map) {
  fs.writeFileSync(excludesPath(s), JSON.stringify(map, null, 2))
}

// Which installed Workshop items ship a mod folder by this name. Two items shipping the same
// folder name is rare but real, and it decides whether the shared copy in <data>/mods can be
// deleted — removing another item's only copy is precisely the "mod vanished from the save"
// failure this whole change exists to avoid.
function folderProviders(s, folder) {
  const roots = [installContent(s), workshopContent(s)].filter(Boolean)
  return getIniList(s, 'WorkshopItems').filter(id =>
    roots.some(r => fs.existsSync(path.join(r, id, 'mods', folder))))
}

// The one place an excluded folder is removed from disk. Every path that installs mods and every
// path that brings the container up calls this, so nothing can reintroduce a banned folder behind
// the operator's back. Idempotent. Never edits the ini: an excluded folder is simply not there to
// contribute a mod id, and dropping ids from Mods= is the one thing that loses items.
function applyExcludes(s) {
  const removed = []
  for (const { workshopId, folder } of allExcludes(readExcludes(s))) {
    if (!validWorkshopId(workshopId) || !validFolder(folder)) {
      console.error('[excludes] ignoring malformed entry ' + workshopId + '/' + folder)
      continue
    }
    // Computed before anything is deleted, or the item's own copy would count as a provider.
    const others = folderProviders(s, folder).filter(id => id !== workshopId)
    if (others.length) logFor(s, 'exclude ' + workshopId + '/' + folder + ': leaving ' + path.join(modsDir(s), folder) + ' alone, also shipped by [' + others.join(', ') + ']')

    const itemRoots = [installContent(s), workshopContent(s)].filter(Boolean)
    const targets = []
    for (const t of removalTargets(workshopId, folder, others)) {
      if (t.root === 'mods') targets.push(path.join(modsDir(s), ...t.parts))
      else for (const r of itemRoots) targets.push(path.join(r, ...t.parts))
    }

    for (const target of targets) {
      if (!fs.existsSync(target)) continue
      try { fs.rmSync(target, { recursive: true, force: true }); removed.push(target) }
      catch (e) { console.error('[excludes] could not remove ' + target + ': ' + e.message) }
    }
  }
  if (removed.length) logFor(s, 'removed ' + removed.length + ' excluded mod folder(s): ' + removed.join(', '))
  return removed
}

// Post-download bookkeeping for one Workshop item. Only registers the item in the server ini
// if it actually produced loadable mod folders — registering empty/failed downloads is what
// previously polluted WorkshopItems with entries the game can't load.
// opts.force replaces what is already on disk instead of stepping around it. The default stays
// non-destructive because an ordinary download runs while people are playing; the reinstall flow

module.exports = { readExcludes, writeExcludes, folderProviders, applyExcludes }
