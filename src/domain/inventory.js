// What is actually on disk, across the two trees PZ scans and the one it does not.
//
// Three trees are in play and confusing them is the source of most of this manager's history:
//
//   <data>/mods              local mods. PZ loads these. No client can download them.
//   <install>/…/content/…    SteamCMD's force_install_dir. PZ loads these, and Steam serves the
//                            same files to clients, so a mod here is one a player can obtain.
//   <workshop>/content/…     this manager's own mirror. B42 never reads it.
//
// Anything that answers "can the game load this" or "can a client download this" has to say which
// tree it means, which is why these live together rather than beside whichever endpoint asked.

const fs = require('fs')
const path = require('path')
const { modsDir, workshopContent, installContent } = require('../paths')
const { getIniList } = require('./ini')
const { serverBuildRank, folderIds, findModInfo, preferredModInfo } = require('./modinfo')
const { safeReaddir } = require('../util/fsx')
const { analyzeModDrift, versionRank } = require('../../lib/moddrift')

/** @typedef {import('../paths').Server} Server */

// One entry per mod folder across both trees the game reads. `local` is <data>/mods, which no
// client can obtain from; `workshop` is the install tree, which mirrors what Steam serves.
function buildModInventory(s) {
  const buildRank = serverBuildRank(s)
  const out = []
  const inst = installContent(s)
  if (inst) {
    for (const wid of safeReaddir(inst)) {
      const dir = path.join(inst, wid, 'mods')
      for (const folder of safeReaddir(dir)) {
        if (versionRank(folder) !== null) continue
        const { ids, preferredId } = folderIds(path.join(dir, folder), buildRank)
        if (ids.length) out.push({ folder, source: 'workshop', workshopId: wid, ids, preferredId })
      }
    }
  }
  for (const folder of safeReaddir(modsDir(s))) {
    const { ids, preferredId } = folderIds(path.join(modsDir(s), folder), buildRank)
    if (ids.length) out.push({ folder, source: 'local', workshopId: null, ids, preferredId })
  }
  return out
}

// Whether the local copy and the Workshop copy of a folder are the same build, compared by
// relative path + size and ignoring mod.info (the one file we already know differs).
//
// This is the safety gate on a repair. Identical builds mean the rename is pure bookkeeping —
// 76chevyKserieseExpanded differed from the Workshop copy by a single byte. Different builds mean
// switching makes the game load different scripts, and PZ discards items whose ids no longer
// exist: GunsOfMarz renamed M4 to M4A1 and dropped Booster_Scope, which cost three objects here.
function buildsIdentical(s, folder) {
  const inst = installContent(s)
  if (!inst) return null
  const wsRoot = safeReaddir(inst)
    .map(wid => path.join(inst, wid, 'mods', folder))
    .find(p => fs.existsSync(p))
  const localRoot = path.join(modsDir(s), folder)
  if (!wsRoot || !fs.existsSync(localRoot)) return null
  const listing = (root) => {
    const acc = []
    const walk = (dir, rel) => {
      for (const name of safeReaddir(dir).sort()) {
        const full = path.join(dir, name)
        let st
        try { st = fs.statSync(full) } catch { continue }
        if (st.isDirectory()) walk(full, rel + name + '/')
        else if (name !== 'mod.info') acc.push(rel + name + ':' + st.size)
      }
    }
    walk(root, '')
    return acc.join('\n')
  }
  try { return listing(wsRoot) === listing(localRoot) } catch { return null }
}

// Local copies the Workshop has moved past — the state drift grows out of.
//
// registerInstalledMod() copies into <data>/mods only when the destination is absent, so an
// auto-update refreshes the install tree and leaves the local copy at whatever version it was
// first installed at. That copy keeps serving its old id, which is how an entry in Mods= can stay
// valid on disk for months after Steam has renamed it.
//
// Reported, never repaired automatically: refreshing a stale copy swaps the build the game loads,
// and PZ discards items whose ids that build no longer defines. Doing it unprompted would have
// destroyed items here. Compares version-folder names only — a readdir, not a tree walk, so this
// stays cheap enough to run on every boot.
function staleLocalCopies(s) {
  const inst = installContent(s)
  if (!inst) return []
  const wsFolders = new Map()
  for (const wid of safeReaddir(inst)) {
    const dir = path.join(inst, wid, 'mods')
    for (const folder of safeReaddir(dir)) {
      if (versionRank(folder) !== null) continue
      if (!wsFolders.has(folder)) wsFolders.set(folder, { workshopId: wid, dir: path.join(dir, folder) })
    }
  }
  const out = []
  for (const folder of safeReaddir(modsDir(s))) {
    const ws = wsFolders.get(folder)
    if (!ws) continue
    const versions = (dir) => safeReaddir(dir).filter(f => versionRank(f) !== null)
    const top = (dir) => versions(dir).reduce((a, b) => (versionRank(b) > versionRank(a || '0') ? b : a), null)
    const wsTop = top(ws.dir), localTop = top(path.join(modsDir(s), folder))
    if (wsTop && versionRank(wsTop) > versionRank(localTop || '0')) {
      out.push({ folder, workshopId: ws.workshopId, workshop: wsTop, local: localTop })
    }
  }
  return out
}

function modDriftReport(s) {
  const inventory = buildModInventory(s)
  const analysis = analyzeModDrift({ enabled: getIniList(s, 'Mods'), inventory })
  const issues = analysis.issues.map(i => ({
    ...i,
    // Only meaningful for a rename; an orphan has no local copy to compare.
    buildsIdentical: i.kind === 'clientBlocked' ? buildsIdentical(s, i.folder) : null,
  }))
  return { ok: analysis.ok, issues, stale: staleLocalCopies(s), checkedAt: new Date().toISOString() }
}

// A Workshop item is "present" only if it has at least one folder carrying a readable mod.info.
// An empty or half-written tree passes an existsSync check and then loads nothing.
function itemHasContent(root, workshopId) {
  if (!root) return false
  const dir = path.join(root, workshopId, 'mods')
  if (!fs.existsSync(dir)) return false
  try {
    return fs.readdirSync(dir).some(f => !/^\d+\.\d+$/.test(f) && findModInfo(path.join(dir, f)))
  } catch { return false }
}

function loadableModIds(s) {
  const ids = new Set()
  const buildRank = serverBuildRank(s)
  const take = (folderPath) => {
    // The id the game registers, not the first mod.info in the folder — otherwise Hot Brass reads
    // as zHBVCEF (root, B41) while the running build loads HBVCEFb42 from 42.15/, and this gate
    // reports a mod that is enabled and loading fine as having nothing on disk to load it.
    const info = preferredModInfo(folderPath, buildRank)
    if (!info) return
    try {
      const m = fs.readFileSync(info, 'utf8').match(/^id=(.+)$/m)
      if (m) ids.add(m[1].trim())
    } catch {}
  }
  const inst = installContent(s)
  if (inst) {
    for (const wid of safeReaddir(inst)) {
      const dir = path.join(inst, wid, 'mods')
      for (const folder of safeReaddir(dir)) {
        if (/^\d+\.\d+$/.test(folder)) continue
        take(path.join(dir, folder))
      }
    }
  }
  for (const folder of safeReaddir(modsDir(s))) take(path.join(modsDir(s), folder))
  return ids
}

// Enabled mod ids with nothing on disk to load them from. This must be empty before the container
// is allowed to start — it is the whole safety condition in one line.
function missingProviders(s, enabledIds) {
  const provided = loadableModIds(s)
  return enabledIds.filter(id => !provided.has(id))
}

module.exports = {
  buildModInventory, buildsIdentical, staleLocalCopies, modDriftReport,
  itemHasContent, loadableModIds, missingProviders,
}
