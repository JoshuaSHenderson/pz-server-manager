// Getting a Workshop item onto disk, and knowing when it got there.
//
// The whole flow is asynchronous in a way that is not this manager's choice: SteamCMD lives inside
// the game container and is started with `docker exec -d`, deliberately detached so a download
// survives a restart of the manager. Nothing calls back when it finishes. So completion is
// reconciled on an interval against what actually landed on disk, and the queue is persisted
// because it is the only record that a download was ever asked for.
//
// An item leaves 'queued' only once it is no longer actively downloading AND what landed has been
// confirmed. Absence from the active-download log is not treated as success on its own - that
// assumption once marked never-downloaded mods as installed and wrote them into servertest.ini.

const fs = require('fs')
const path = require('path')
const { queuePath, modsDir, workshopContent, installContent } = require('../paths')
const { readJson, writeJson, safeReaddir } = require('../util/fsx')
const { getIniList, setIniList } = require('../domain/ini')
const { modFolders, modIdsFromWorkshop, modNamesFromWorkshop } = require('../domain/modinfo')
const { readExcludes, folderProviders, applyExcludes } = require('./excludes')
const { isExcluded } = require('../../lib/excludes')
const { steamCollectionDetails } = require('../infra/steam')
const docker = require('../infra/docker')
const disk = require('../infra/disk')
const { humanBytes } = disk
const { logFor } = require('../log')
const reinstallState = require('./reinstall-state')

/** @typedef {import('../paths').Server} Server */

// ===== MODS =====


// --- Download queue (persisted — survives a mod-manager container restart) ---
// One JSON array per server: { id, source, collectionId, status: 'queued'|'installed'|'failed',
// queuedAt, updatedAt, error, modIds, copiedFolders }
function readQueue(s) {
  try { return JSON.parse(fs.readFileSync(queuePath(s), 'utf8')) } catch { return [] }
}
function writeQueue(s, queue) {
  try { fs.writeFileSync(queuePath(s), JSON.stringify(queue.slice(-300), null, 2)) }
  catch (e) { console.error('[queue] write failed:', e.message) }
}
function queueAdd(s, workshopIds, source, collectionId) {
  const queue = readQueue(s)
  const now = new Date().toISOString()
  // Drop any prior terminal record for the same id so re-installs don't stack up duplicates.
  const kept = queue.filter(e => !(workshopIds.includes(e.id) && e.status !== 'queued'))
  for (const id of workshopIds) {
    if (kept.some(e => e.id === id && e.status === 'queued')) continue
    kept.push({ id, source, collectionId: collectionId || null, status: 'queued', queuedAt: now, updatedAt: now })
  }
  writeQueue(s, kept)
}

// True when this Workshop item has real, loadable mod content on disk.
function hasModContent(s, workshopId) {
  return modFolders(s, workshopId).length > 0
}
// runs with the container stopped and is the only caller that wants the old files gone.
function registerInstalledMod(s, workshopId, opts) {
  const force = !!(opts && opts.force)
  const fromInstall = installContent(s) ? path.join(installContent(s), workshopId) : null
  const itemDest = path.join(workshopContent(s), workshopId)

  if (force && fromInstall && fs.existsSync(fromInstall)) {
    // The whole point of a reinstall: the mirrored copy must end up identical to what SteamCMD
    // just wrote, including folders the author has removed since the last download.
    try {
      fs.rmSync(itemDest, { recursive: true, force: true })
      fs.cpSync(fromInstall, itemDest, { recursive: true })
    } catch (e) { console.error('[install] force mirror failed for ' + workshopId + ':', e.message) }
  } else {
    try {
      // `sh -c` with the id passed as $1 rather than spliced into the script: the id is validated
      // digits at every entry point, and this keeps it that way even if one day it is not.
      docker.execInSync(s.container, ['sh', '-c',
        'cp -rn /home/steam/pz-dedicated/steamapps/workshop/content/108600/"$1" ' +
        '/home/steam/Steam/steamapps/workshop/content/108600/ 2>/dev/null; true',
        'sh', workshopId], { timeout: 30000 })
    } catch (e) {
      console.error('[install] mirror copy inside ' + s.container + ' failed for ' + workshopId + ': ' + e.message)
    }
  }

  const dir = path.join(itemDest, 'mods')
  const excludes = readExcludes(s)
  const copiedFolders = []
  if (fs.existsSync(dir)) {
    for (const folder of fs.readdirSync(dir)) {
      if (/^\d+\.\d+$/.test(folder)) continue
      // Never copy a banned folder in the first place — applyExcludes() below would only have to
      // delete it again, and between the two it would briefly be loadable.
      if (isExcluded(excludes, workshopId, folder)) continue
      const src = path.join(dir, folder)
      const dest = path.join(modsDir(s), folder)
      try {
        // Only replace a folder no other installed item ships. <data>/mods is flat and shared, so
        // forcing over a name two items happen to use would overwrite the other mod's files.
        if (force && fs.existsSync(dest) && !folderProviders(s, folder).some(id => id !== workshopId)) {
          fs.rmSync(dest, { recursive: true, force: true })
        }
        if (!fs.existsSync(dest)) { fs.cpSync(src, dest, { recursive: true }); copiedFolders.push(folder) }
      } catch (e) {
        // Was swallowed silently, which is the worst possible outcome here: the item then looks
        // installed, gets written into Mods=, and the mod it names has no files to load from.
        console.error('[install] could not copy mod folder "' + folder + '" for item ' + workshopId + ': ' + e.message)
      }
    }
  }
  // Clears the item's excluded folders out of the install/workshop trees too — the copy loop above
  // only guards <data>/mods, and the game reads the install tree.
  applyExcludes(s)

  const newModIds = modIdsFromWorkshop(s, workshopId)
  if (!newModIds.length) return { status: 'empty', modIds: [], copiedFolders }
  setIniList(s, 'WorkshopItems', [...new Set([...getIniList(s, 'WorkshopItems'), workshopId])])
  setIniList(s, 'Mods', [...new Set([...getIniList(s, 'Mods'), ...newModIds])])
  return { status: 'installed', modIds: newModIds, copiedFolders }
}

// Kicks off a SteamCMD download and returns immediately — runs via a *detached* `docker exec -d`
// inside the PZ server container, so the download survives a restart of this manager.
// Completion is detected by reconcileDownloads() below, not by a callback on this process.
function steamcmdDownload(s, workshopIds, source, collectionId) {
  if (!workshopIds.length) return
  queueAdd(s, workshopIds, source, collectionId)
  const items = workshopIds.flatMap(id => ['+workshop_download_item', '108600', id])
  const argv = ['/home/steam/steamcmd/steamcmd.sh', '+force_install_dir', '/home/steam/pz-dedicated',
    '+login', 'anonymous', ...items, '+quit']
  logFor(s, 'SteamCMD: downloading ' + workshopIds.length + ' item(s) [' + workshopIds.slice(0, 8).join(', ') + (workshopIds.length > 8 ? ', ...' : '') + '] source=' + source)
  docker.execInDetached(s.container, argv, { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[download] failed to start for ' + s.name + ':', stderr || err.message)
      const queue = readQueue(s)
      for (const e of queue) {
        if (workshopIds.includes(e.id) && e.status === 'queued') {
          e.status = 'failed'
          e.error = 'Could not start SteamCMD in container "' + s.container + '": ' +
            (stripAnsi(stderr || err.message).trim().slice(0, 300) || 'no output') +
            '. Check the server container is running.'
          e.updatedAt = new Date().toISOString()
        }
      }
      writeQueue(s, queue)
    }
  })
}

// --- Download failure diagnosis ---
//
// Every failed download used to report the same sentence regardless of cause, which made a
// resumable timeout, an out-of-disk and a not-actually-a-mod item indistinguishable. These
// helpers turn SteamCMD's own output plus the state on disk into something actionable.
function stripAnsi(str) { return String(str).replace(/\x1b\[[0-9;]*m/g, '') }



// How much of an item SteamCMD has already pulled into the server's force_install_dir. That tree
// is not mounted into this container, so ask the server container. A surviving partial is the
// difference between "retry resumes" and "retry starts from zero".
function partialBytes(s, workshopId) {
  try {
    const out = docker.execInSync(s.container, ['sh', '-c',
      'du -sb /home/steam/pz-dedicated/steamapps/workshop/content/108600/"$1" 2>/dev/null || true',
      'sh', workshopId], { timeout: 20000 }).trim()
    return parseInt(out.split(/\s+/)[0], 10) || 0
  } catch { return 0 }
}

// Explains why an item settled with no usable mod folders.
function explainDownloadFailure(s, workshopId, logLines) {
  // Last match wins — the most recent attempt is the one worth reporting.
  let steamErr = null
  const re = new RegExp('ERROR!.*\\b' + workshopId + '\\b.*')
  for (const line of logLines || []) {
    const m = stripAnsi(line).match(re)
    if (m) steamErr = m[0].trim()
  }
  const partial = partialBytes(s, workshopId)
  const free = disk.freeBytes(s.data)
  const bits = []

  bits.push(steamErr ? 'SteamCMD: "' + steamErr + '".' : 'SteamCMD produced no mod folders for this item.')
  if (partial > 0) bits.push(humanBytes(partial) + ' is already downloaded — Retry resumes from there rather than starting over.')
  if (/timeout/i.test(steamErr || '')) bits.push('SteamCMD times out on very large items; each retry picks up where the last stopped, so repeated retries do finish.')
  if (free > 0 && free < 10 * 1024 * 1024 * 1024) {
    bits.push('Only ' + humanBytes(free) + ' free on disk — note each mod is stored twice (workshop copy + server mods folder).')
  }
  if (!steamErr && !partial) {
    bits.push('If this Workshop item is a save, map-only upload or otherwise contains no mod.info, it will never install as a mod.')
  }
  return bits.join(' ')
}

// Reconciles the persisted queue against reality on an interval.
//
// An item leaves "queued" only once it is no longer actively downloading AND we've confirmed
// what actually landed on disk. Absence from the active-download log is NOT treated as success
// on its own — that assumption previously marked never-downloaded mods as "installed" and wrote
// them into servertest.ini. Items that produce no mod content are marked failed with a reason,
// and nested collections are detected and expanded into their child items.
const QUEUE_GRACE_MS = 90 * 1000
function reconcileDownloads(s) {
  // It writes Mods=/WorkshopItems= and copies into <data>/mods — both of which the reinstall's
  // swap phase is rewriting from a snapshot. Whichever wrote last would win, silently.
  if (reinstallState.holdsContainer(s)) return
  const queue = readQueue(s)
  const pending = queue.filter(e => e.status === 'queued')
  if (!pending.length) return
  docker.logs(s.container, ['--tail', '1500'], { maxBuffer: 8 * docker.MB }, (err, out) => {
    const activeIds = new Set(parseDownloads((out || '').split('\n')).map(a => a.workshopId))
    const settled = []
    for (const entry of pending) {
      if (activeIds.has(entry.id)) continue
      // Give a just-queued item time to actually appear in the log before judging it.
      if (Date.now() - new Date(entry.queuedAt).getTime() < QUEUE_GRACE_MS) continue
      settled.push(entry)
    }
    if (!settled.length) return

    // Anything with no content might be a nested collection rather than a failed mod — ask Steam.
    const empties = settled.filter(e => !hasModContent(s, e.id)).map(e => e.id)
    steamCollectionDetails(empties, (cErr, collMap) => {
      const nowIso = new Date().toISOString()
      const expand = []
      for (const entry of settled) {
        const kids = collMap && collMap[entry.id]
        if (kids && kids.length) {
          entry.status = 'collection'
          entry.error = null
          entry.childCount = kids.length
          entry.updatedAt = nowIso
          // Pull the collection out of the mod list — it isn't a loadable mod — and queue its children.
          setIniList(s, 'WorkshopItems', getIniList(s, 'WorkshopItems').filter(id => id !== entry.id))
          expand.push({ parent: entry.id, kids })
          continue
        }
        try {
          const r = registerInstalledMod(s, entry.id)
          if (r.status === 'installed') {
            logFor(s, 'installed ' + entry.id + ' - mod ids [' + r.modIds.join(', ') + ']')
            entry.status = 'installed'
            entry.modIds = r.modIds
            entry.copiedFolders = r.copiedFolders
            entry.error = null
          } else {
            entry.status = 'failed'
            entry.error = explainDownloadFailure(s, entry.id, (out || '').split('\n'))
            logFor(s, 'download FAILED for ' + entry.id + ' - ' + entry.error)
          }
        } catch (e) {
          entry.status = 'failed'
          entry.error = e.message
        }
        entry.updatedAt = nowIso
      }
      writeQueue(s, queue)
      for (const x of expand) {
        const fresh = x.kids.filter(k => !getIniList(s, 'WorkshopItems').includes(k))
        if (fresh.length) {
          console.log('[collection] ' + x.parent + ' is a nested collection — queueing ' + fresh.length + ' child item(s)')
          steamcmdDownload(s, fresh, 'collection', x.parent)
        }
      }
    })
  })
}

// --- Download state parser ---
function parseDownloads(lines) {
  const state = {}
  for (const line of lines) {
    let m = line.match(/Workshop: download (\d+)\/(\d+) ID=(\d+)/)
    if (m) { state[m[3]] = { status: 'downloading', downloaded: parseInt(m[1]), total: parseInt(m[2]) }; continue }
    m = line.match(/onItemDownloaded.*ID=(\d+)/)
    if (m) { state[m[1]] = { status: 'done' }; continue }
    m = line.match(/CheckItemState\s*->\s*Ready.*ID=(\d+)/)
    if (m) { state[m[1]] = { status: 'ready' }; continue }
    m = line.match(/ID=(\d+).*=\s*(NeedsUpdate|None)\b/)
    if (m && !state[m[1]]) { state[m[1]] = { status: 'pending' }; continue }
    m = line.match(/GetItemState\(\).*ID=(\d+).*=\s*(NeedsUpdate|None)\b/)
    if (m && !state[m[1]]) { state[m[1]] = { status: 'pending' }; continue }
  }
  return Object.entries(state)
    .filter(([, s]) => s.status === 'downloading' || s.status === 'pending')
    .map(([id, s]) => ({
      workshopId: id, status: s.status,
      downloaded: s.downloaded || 0, total: s.total || 0,
      pct: s.total ? Math.round(s.downloaded / s.total * 100) : 0
    }))
}

module.exports = {
  readQueue, writeQueue, queueAdd, hasModContent, registerInstalledMod, steamcmdDownload,
  stripAnsi, partialBytes, explainDownloadFailure, reconcileDownloads, parseDownloads,
  QUEUE_GRACE_MS,
}
