// What is actually on disk versus what servertest.ini claims.
//
// Mods routinely get half-removed: a Workshop item unregistered but its files left behind, or a
// folder copied into the server's mods dir whose Workshop item is long gone. Those cost real disk
// and confuse later installs, and nothing else in this manager would ever surface them.
//
// Two of the categories here overlap but are not the same question, and the difference is the
// whole reason both exist:
//
//   phantomEnabled  reads the manager's own inventory mirror
//   notLoadable     reads the two trees the game itself scans
//
// A mod present in the mirror but absent from where PZ looks passes the first and fails the
// second - and it loads as nothing, which drops its items from the save.

const fs = require('fs')
const path = require('path')
const { modsDir, workshopContent } = require('../paths')
const { getIniList } = require('../domain/ini')
const { installedModMeta, duplicateModIds, modNamesFromWorkshop } = require('../domain/modinfo')
const { missingProviders } = require('../domain/inventory')
const { hasModContent } = require('./downloads')
const disk = require('../infra/disk')

const { humanBytes } = disk

/** @typedef {import('../paths').Server} Server */

// --- Disk audit ---
//
// Full visibility over what is actually on disk versus what the ini claims. Mods routinely get
// half-removed: a Workshop item unregistered but its files left behind, or a folder copied into
// the server's mods dir whose Workshop item is long gone. Those cost disk and confuse later
// installs, and nothing else in here would ever surface them.

function auditServer(s) {
  const registered = getIniList(s, 'WorkshopItems')
  const registeredSet = new Set(registered)
  const enabled = getIniList(s, 'Mods')
  const meta = installedModMeta(s)                       // registered items only
  const providedLower = new Set(Object.keys(meta).map(id => id.toLowerCase()))

  // Every Workshop id sitting in the content dir, registered or not.
  let onDisk = []
  try { onDisk = fs.readdirSync(workshopContent(s)).filter(f => /^\d+$/.test(f)) } catch {}

  // Downloaded but not in WorkshopItems= — pure wasted disk.
  const unregistered = onDisk.filter(id => !registeredSet.has(id)).map(id => ({
    workshopId: id,
    folders: (() => { try { return fs.readdirSync(path.join(workshopContent(s), id, 'mods')) } catch { return [] } })(),
    bytes: disk.dirSizeSync(path.join(workshopContent(s), id))
  }))

  // Registered but no mod content on disk — the server will fail to load these.
  const missingContent = registered.filter(id => !hasModContent(s, id))

  // Folders copied into the server's mods dir with no registered Workshop item behind them.
  const expectedFolders = new Set()
  for (const wid of registered) for (const f of modNamesFromWorkshop(s, wid)) expectedFolders.add(f)
  let modsDirFolders = []
  try { modsDirFolders = fs.readdirSync(modsDir(s), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch {}
  const orphanFolders = modsDirFolders.filter(f => !expectedFolders.has(f)).map(f => ({
    folder: f, bytes: disk.dirSizeSync(path.join(modsDir(s), f))
  }))

  // Enabled in Mods= but no installed mod.info provides that id — silently does nothing.
  const phantomEnabled = enabled.filter(id => !providedLower.has(id.toLowerCase()))

  // Installed and available but not loaded. Informational, not a problem.
  const enabledLower = new Set(enabled.map(id => id.toLowerCase()))
  const installedNotEnabled = Object.keys(meta).filter(id => !enabledLower.has(id.toLowerCase()))

  // Two folders claiming one mod id. PZ takes whichever it scans first, so the server boots
  // differently on consecutive starts — the "it needs a second restart" symptom, and invisible
  // everywhere else in this UI because installedModMeta() is keyed by id and keeps only the last
  // folder it read. Only ids that are actually enabled are worth flagging.
  const enabledSet = new Set(enabled)
  const duplicateIds = duplicateModIds(s).filter(d => enabledSet.has(d.modId))

  // phantomEnabled above reads the /workshop mirror. This reads the two trees the game itself
  // scans, so it catches the case that one cannot: a mod present in the manager's inventory but
  // absent from where PZ looks, which loads as nothing and drops its items from the save.
  const notLoadable = missingProviders(s, enabled)

  const reclaimable = unregistered.reduce((n, u) => n + u.bytes, 0) + orphanFolders.reduce((n, o) => n + o.bytes, 0)

  return {
    registered: registered.length,
    enabled: enabled.length,
    onDisk: onDisk.length,
    unregistered, missingContent, orphanFolders, phantomEnabled, installedNotEnabled, duplicateIds, notLoadable,
    reclaimableBytes: reclaimable,
    reclaimableHuman: humanBytes(reclaimable),
    freeBytes: disk.freeBytes(s.data),
    freeHuman: humanBytes(disk.freeBytes(s.data))
  }
}

module.exports = { auditServer }
