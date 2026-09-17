// Deleting one Workshop item's files and downloading them again, without losing the save.
//
// Removing a mod's files and letting the server boot without it is how a save loses items: PZ
// discards what it cannot load, in every container and on every character. So the whole flow is
// arranged around one rule - the server never starts while a mod id in Mods= has no files on disk.
// Everything else (downtime, a stale copy, a failed download) is recoverable; that is not.
//
// The download runs with the server still up, because SteamCMD lives inside the PZ container and a
// stopped container cannot be exec'd into. Only the swap steps are downtime, and everything before
// the server comes back up is a move rather than a delete, so it can be undone.
//
// If the rollback itself fails, the server is left deliberately stopped and the operator is paged.
// A stopped server is recoverable by hand; a running one that has just discarded every item from a
// mod it could not load is not.

const fs = require('fs')
const path = require('path')
const { modsDir, workshopContent, installContent, reinstallDir } = require('../paths')
const { getIniList, setIniList } = require('../domain/ini')
const { itemHasContent, missingProviders } = require('../domain/inventory')
const { modNamesFromWorkshop } = require('../domain/modinfo')
const { registerInstalledMod, steamcmdDownload, readQueue, writeQueue } = require('./downloads')
const { folderProviders } = require('./excludes')
const { saveThen } = require('./lifecycle')
const { pushoverFor } = require('./notify')
const reinstallState = require('./reinstall-state')
const { markAwaitingReady, mstate } = require('../monitors/state')
const { safeReaddir } = require('../util/fsx')
const docker = require('../infra/docker')
const disk = require('../infra/disk')
const { humanBytes } = disk
const { backupModOrder } = require('./modorder')
const { logFor } = require('../log')

/** @typedef {import('../paths').Server} Server */

const { QUARANTINE_KEEP: REINSTALL_QUARANTINE_KEEP, DOWNLOAD_TIMEOUT_MS: REINSTALL_DOWNLOAD_TIMEOUT_MS } = reinstallState

// Promise wrappers, so the eleven-step reinstall below reads as a sequence rather than a callback
// ladder. Errors are trimmed because they end up in `state.error`, which the UI renders verbatim.
const dockerControl = (action, s, timeout) => new Promise((resolve, reject) =>
  docker.control(action, s.container, timeout, err => err ? reject(trimErr(err)) : resolve(undefined)))
const dockerExecIn = (s, argv, timeout) => new Promise((resolve, reject) => {
  try { resolve(docker.execInSync(s.container, argv, { timeout })) }
  catch (e) { reject(trimErr(e)) }
})
const trimErr = e => new Error(String((e && e.stderr) || (e && e.message) || e).trim().slice(0, 400))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const saveThenAsync = s => new Promise(resolve => saveThen(s, resolve))

// Move rather than delete, so every step before the server comes back up is reversible.
//
// /pz-data, /workshop and /pz-install are three separate bind mounts, so a rename between them is
// EXDEV — which is every move out of the workshop tree, since the quarantine lives under /pz-data.
// The fallback copies first and only unlinks once the copy is complete, so a half-finished copy is
// never the only surviving version of a mod.
function quarantineMove(from, to) {
  if (!fs.existsSync(from)) return false
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    fs.rmSync(to, { recursive: true, force: true }) // a partial copy from an earlier attempt
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
  return true
}

function pruneQuarantine(s) {
  try {
    const all = safeReaddir(reinstallDir(s)).sort().reverse()
    for (const old of all.slice(REINSTALL_QUARANTINE_KEEP)) {
      fs.rmSync(path.join(reinstallDir(s), old), { recursive: true, force: true })
    }
  } catch {}
}

// Mod ids the game can actually load, read from the two trees PZ itself scans: the SteamCMD
// install tree for Workshop mods, and <data>/mods for local ones. Deliberately not /workshop —
// that is the manager's inventory mirror, which B42 never reads, so counting it would let a mod
// pass this check and then fail to load.

// The <data>/mods folder names belonging to this item, read from the quarantined copy. Needed
// because modNamesFromWorkshop() reads the live workshop tree, which has just been moved aside.
function quarantinedFolders(quarantine) {
  const dir = path.join(quarantine, 'workshop', 'mods')
  if (!fs.existsSync(dir)) return []
  return safeReaddir(dir).filter(f => !/^\d+\.\d+$/.test(f))
}

async function reinstallWorkshopItem(s, workshopId) {
  // The state shape lives with the store, in src/services/reinstall-state.js.
  const state = reinstallState.set(s, {
    workshopId, step: 'starting', startedAt: new Date().toISOString(),
    finishedAt: null, ok: false, error: null, quarantine: null,
  })
  const step = (name) => { state.step = name; logFor(s, 'reinstall ' + workshopId + ': ' + name) }

  const install = installContent(s)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const quarantine = path.join(reinstallDir(s), workshopId + '-' + stamp)
  const snapshot = { mods: getIniList(s, 'Mods'), workshopItems: getIniList(s, 'WorkshopItems') }
  const foldersBefore = modNamesFromWorkshop(s, workshopId)
  let stopped = false          // the container is down and this flow owes it a start
  let installed = false        // step 7 ran, so there are fresh files on disk to clear on rollback
  let movedWorkshop = false
  const movedModFolders = []

  // Undoes everything the downtime window touched. Returns true only when the ini and the disk
  // agree again, which is the sole condition under which the server may be started.
  const rollback = () => {
    try {
      // Only when step 7 actually laid fresh files down. Without this guard a failure before the
      // swap would delete the item's mod folders and have nothing quarantined to put back.
      if (installed) {
        for (const folder of modNamesFromWorkshop(s, workshopId)) {
          if (movedModFolders.includes(folder)) continue // restored below from the quarantine
          if (folderProviders(s, folder).filter(id => id !== workshopId).length) continue // shared
          try { fs.rmSync(path.join(modsDir(s), folder), { recursive: true, force: true }) } catch {}
        }
      }
      if (movedWorkshop) {
        fs.rmSync(path.join(workshopContent(s), workshopId), { recursive: true, force: true })
        quarantineMove(path.join(quarantine, 'workshop'), path.join(workshopContent(s), workshopId))
      }
      for (const folder of movedModFolders) {
        fs.rmSync(path.join(modsDir(s), folder), { recursive: true, force: true })
        quarantineMove(path.join(quarantine, 'mods', folder), path.join(modsDir(s), folder))
      }
      setIniList(s, 'WorkshopItems', snapshot.workshopItems)
      setIniList(s, 'Mods', snapshot.mods)
      return missingProviders(s, snapshot.mods).length === 0
    } catch (e) {
      console.error('[reinstall] rollback failed for ' + workshopId + ':', e.message)
      return false
    }
  }

  try {
    // 1 — snapshot. backupModOrder() writes Mods= into the same store the Load Order tab restores
    // from, so a bad outcome is undoable by hand as well as automatically.
    step('snapshotting mod list')
    if (!snapshot.workshopItems.includes(workshopId)) throw new Error('Workshop item ' + workshopId + ' is not installed on this server')
    backupModOrder(s, 'pre-reinstall-' + workshopId)
    fs.mkdirSync(quarantine, { recursive: true })
    fs.writeFileSync(path.join(quarantine, 'ini-snapshot.json'), JSON.stringify(snapshot, null, 2))
    state.quarantine = quarantine

    // 2 — clear SteamCMD's copy so the download cannot no-op on an up-to-date manifest. This is
    // the staging tree, and the container is still up, so exec works.
    step('clearing SteamCMD copy')
    await dockerExecIn(s, ['rm', '-rf',
      '/home/steam/pz-dedicated/steamapps/workshop/content/108600/' + workshopId], 120000)

    // 3 — download with the server still up. Any failure between here and step 4 costs nothing:
    // only the staging tree has been touched and the server never went down.
    step('downloading from Steam')
    writeQueue(s, readQueue(s).filter(e => e.id !== workshopId))
    steamcmdDownload(s, [workshopId], 'reinstall', null)
    const deadline = Date.now() + REINSTALL_DOWNLOAD_TIMEOUT_MS
    for (;;) {
      await sleep(5000)
      // reconcileDownloads() owns the queue and calls registerInstalledMod() when an item settles.
      // Waiting on it beats running a second copy of the same bookkeeping alongside it.
      const entry = readQueue(s).find(e => e.id === workshopId)
      if (entry && entry.status !== 'queued') {
        if (entry.status !== 'installed') throw new Error('Download did not complete: ' + (entry.error || entry.status))
        break
      }
      if (Date.now() > deadline) throw new Error('Download did not finish within ' + Math.round(REINSTALL_DOWNLOAD_TIMEOUT_MS / 60000) + ' minutes')
    }

    // 4 — last checkpoint before any downtime.
    step('verifying downloaded files')
    if (!itemHasContent(install, workshopId)) throw new Error('SteamCMD produced no loadable mod folders for ' + workshopId + ' — nothing has been changed')

    // The quarantine is on a different filesystem from the workshop tree, so it is a copy, not a
    // relink. Checked here because running out of room mid-swap would strand the server down.
    const needBytes = disk.dirSizeSync(path.join(workshopContent(s), workshopId)) + disk.dirSizeSync(path.join(install, workshopId))
    const haveBytes = disk.freeBytes(s.data)
    if (haveBytes && needBytes > haveBytes * 0.9) {
      throw new Error('Not enough free space to quarantine ' + workshopId + ': needs about ' +
        humanBytes(needBytes) + ', ' + humanBytes(haveBytes) + ' free — nothing has been changed')
    }

    // 5 — down. saveThen() writes the world first; without it the JVM is SIGKILLed and the world
    // reverts to its last autosave.
    step('saving world and stopping server')
    state.holdsContainer = true
    mstate(s).intentionalStop = true
    await saveThenAsync(s)
    await dockerControl('stop', s, 120000)
    stopped = true

    // 6 — quarantine the old copies. The install tree is deliberately not moved: SteamCMD already
    // replaced it in steps 2-3, and it is the one tree that can be re-fetched from Steam at will.
    step('quarantining old files')
    // Read now, not before the download: reconcileDownloads() has already mirrored the new tree in
    // by this point, so folders that appeared in this version are only visible here. Unioned with
    // the pre-download list so a folder the author deleted still gets moved aside rather than left
    // in <data>/mods claiming a live mod id.
    const foldersToMove = new Set([...foldersBefore, ...modNamesFromWorkshop(s, workshopId)])
    movedWorkshop = quarantineMove(path.join(workshopContent(s), workshopId), path.join(quarantine, 'workshop'))
    for (const folder of new Set([...foldersToMove, ...quarantinedFolders(quarantine)])) {
      if (quarantineMove(path.join(modsDir(s), folder), path.join(quarantine, 'mods', folder))) movedModFolders.push(folder)
    }

    // 7/8 — mirror the fresh tree out, dropping excluded folders on the way (registerInstalledMod
    // skips them and then calls applyExcludes for the install tree).
    step('installing fresh files')
    const result = registerInstalledMod(s, workshopId, { force: true })
    installed = true
    if (result.status !== 'installed') throw new Error('Fresh files produced no loadable mod ids')

    // 9 — put Mods= back exactly as it was. registerInstalledMod appends, which would silently
    // move this item to the end of the load order; order is what loadModAfter depends on.
    step('restoring load order')
    const added = result.modIds.filter(id => !snapshot.mods.includes(id))
    setIniList(s, 'WorkshopItems', snapshot.workshopItems)
    setIniList(s, 'Mods', [...snapshot.mods, ...added])
    state.addedModIds = added

    // 10 — the gate.
    step('verifying mod list against disk')
    const missing = missingProviders(s, getIniList(s, 'Mods'))
    if (missing.length) throw new Error('After reinstall these enabled mods have no files: ' + missing.join(', '))

    // 11 — back up.
    step('starting server')
    markAwaitingReady(s)
    await dockerControl('start', s, 60000)
    pruneQuarantine(s)

    state.ok = true
    state.step = 'done'
    state.finishedAt = new Date().toISOString()
    logFor(s, 'reinstall ' + workshopId + ' complete - mod ids [' + result.modIds.join(', ') + ']' + (added.length ? ', newly added [' + added.join(', ') + ']' : ''))
    pushoverFor(s, 'PZ Mod Reinstalled', 'Workshop item ' + workshopId + ' was reinstalled cleanly and the server is starting.')
    return state
  } catch (e) {
    const failedAt = state.step
    state.error = e.message
    state.finishedAt = new Date().toISOString()
    logFor(s, 'reinstall ' + workshopId + ' FAILED at [' + failedAt + ']: ' + e.message)

    // Keyed on the stop, not on whether any file moved: a failure on the very first move happens
    // with the container already down, and reporting "nothing changed" there would leave the
    // server stopped with nobody bringing it back.
    if (!stopped) {
      pushoverFor(s, 'PZ Mod Reinstall Failed', 'Workshop item ' + workshopId + ' failed at "' + failedAt + '". The server was not stopped and nothing changed.')
      return state
    }

    state.step = 'rolling back'
    if (rollback()) {
      state.rolledBack = true
      logFor(s, 'reinstall ' + workshopId + ': rolled back, starting server again')
      markAwaitingReady(s)
      try { await dockerControl('start', s, 60000) } catch (e2) { console.error('[reinstall] start after rollback failed:', e2.message) }
      pushoverFor(s, 'PZ Mod Reinstall Failed', 'Workshop item ' + workshopId + ' failed at "' + failedAt + '" and was rolled back. The server is starting again.')
      return state
    }

    // The one case where staying down is the right answer. Starting now would boot a world whose
    // Mods= names files that are not there, and PZ deletes those mods' items from the save.
    state.strandedDown = true
    logFor(s, 'reinstall ' + workshopId + ': ROLLBACK FAILED - leaving the server stopped on purpose. Files are in ' + quarantine)
    pushoverFor(s, 'PZ SERVER STOPPED - action needed',
      'Reinstall of ' + workshopId + ' failed and could not be rolled back. The server is deliberately stopped to protect the save. Files: ' + quarantine)
    return state
  } finally {
    state.holdsContainer = false
  }
}

module.exports = { reinstallWorkshopItem, quarantineMove, pruneQuarantine, quarantinedFolders }
