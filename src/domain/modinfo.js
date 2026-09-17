// Reading mod.info off disk, and working out which id the game will actually register.
//
// This is the file where most of this manager's hard-won knowledge lives, so the comments below
// are the point of it as much as the code. The short version: a B42 mod folder holds one mod.info
// per version folder, authors rename id= between them, and PZ registers the one from the highest
// version folder not newer than the running build. Read the wrong copy and an installed, correctly
// loading mod looks broken — or worse, a dead id looks fine.

const fs = require('fs')
const path = require('path')
const { workshopContent, installContent, logDir } = require('../paths')
const { safeReaddir } = require('../util/fsx')
const { getIniList } = require('./ini')
const { parseDepList } = require('../../lib/deps')
const { versionRank } = require('../../lib/moddrift')

/** @typedef {import('../paths').Server} Server */

// --- Workshop helpers ---
// The first mod.info in the folder, root before version subfolders. Good enough to answer "is
// there a mod here", which is all modFolders() asks.
//
// It is NOT the id the game will register: a B42 folder holds one mod.info per version folder and
// authors rename id= between them (42.0 SpnCharCustom -> 42.13 SPNCC; 3161951724 fixed a typo,
// 76chevyKserieseExpanded -> 76chevyKseriesExpanded). PZ takes the highest version folder not
// newer than the running build; this takes the root. So an id read from here can be one the game
// never loads, and missingProviders() will pass it. Whether Mods= is actually live is settled
// after boot by reportDeadMods() against the log — see modload.js.
function findModInfo(modFolder) {
  const direct = path.join(modFolder, 'mod.info')
  if (fs.existsSync(direct)) return direct
  try {
    for (const sub of fs.readdirSync(modFolder)) {
      const p = path.join(modFolder, sub, 'mod.info')
      if (fs.existsSync(p)) return p
    }
  } catch {}
  return null
}
// Where to read an item's mod ids from. The install tree first: that is what SteamCMD last wrote,
// so it is both what the game loads and what Steam serves to clients.
//
// Not the mirror. registerInstalledMod() copies into the mirror with `cp -rn`, which never
// overwrites, so a mod.info there keeps whatever id the author used at first install. Reading ids
// from it meant every auto-update re-appended the *old* id to Mods=: MarzGuns kept coming back
// months after the Workshop renamed it to GunsOfMarz, and the stale <data>/mods copy — protected
// by the same never-overwrite rule — made the dead id look valid on disk. That pair is the whole
// engine behind "Mod ... is not installed [WorkshopID: ]".
// The mod.info the game will actually read: the highest version folder not newer than the build,
// else the folder root, else common/.
//
// findModInfo() answers a different question — "is there a mod here" — and returns the first file
// it finds. For Hot Brass that is the root copy declaring the B41 id zHBVCEF, while the running
// build registers HBVCEFb42 from 42.15/. Keyed by the wrong id, an enabled and perfectly loaded
// mod showed up in the UI as "not installed" with no title and no Workshop link.
function preferredModInfo(modFolder, buildRank) {
  let best = null, bestRank = -1, common = null
  for (const sub of safeReaddir(modFolder)) {
    const p = path.join(modFolder, sub, 'mod.info')
    if (!fs.existsSync(p)) continue
    const rank = versionRank(sub)
    if (rank === null) { if (sub === 'common') common = p; continue }
    if ((buildRank === null || rank <= buildRank) && rank > bestRank) { bestRank = rank; best = p }
  }
  if (best) return best
  const root = path.join(modFolder, 'mod.info')
  if (fs.existsSync(root)) return root
  return common
}

function itemModsRoot(s, workshopId) {
  const inst = installContent(s)
  const fromInstall = inst && path.join(inst, workshopId, 'mods')
  if (fromInstall && fs.existsSync(fromInstall)) return fromInstall
  return path.join(workshopContent(s), workshopId, 'mods')
}
function modFolders(s, workshopId) {
  const dir = itemModsRoot(s, workshopId)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => !/^\d+\.\d+$/.test(f) && findModInfo(path.join(dir, f)))
}
function modIdsFromWorkshop(s, workshopId) {
  const dir = itemModsRoot(s, workshopId)
  const ids = []
  const buildRank = serverBuildRank(s)
  for (const folder of modFolders(s, workshopId)) {
    const info = preferredModInfo(path.join(dir, folder), buildRank)
    if (info) {
      const m = fs.readFileSync(info, 'utf8').match(/^id=(.+)$/m)
      if (m) ids.push(m[1].trim())
    }
  }
  return ids
}
function modNamesFromWorkshop(s, workshopId) { return modFolders(s, workshopId) }

// Every (Workshop item, folder) -> mod id on disk, one row per folder. installedModMeta() below
// keys by mod id instead, so a second folder declaring an id already seen silently overwrites the
// first — which is how two folders both claiming id=MarzGuns stayed invisible in the UI while PZ
// picked between them at random on every boot. Anything that needs to reason about folders rather
// than ids uses this.
function modIdsByFolder(s) {
  const buildRank = serverBuildRank(s)
  const rows = []
  for (const wid of getIniList(s, 'WorkshopItems')) {
    // Same root modFolders() walked. Reading folder names from one tree and mod.info from the
    // other is how a renamed mod ends up listed as "not installed": the folder is found in the
    // install tree, the id is read from the mirror's never-overwritten copy, and the two disagree.
    const dir = itemModsRoot(s, wid)
    for (const folder of modFolders(s, wid)) {
      const info = preferredModInfo(path.join(dir, folder), buildRank)
      if (!info) continue
      let m
      try { m = fs.readFileSync(info, 'utf8').match(/^id=(.+)$/m) } catch { continue }
      if (m) rows.push({ workshopId: wid, folder, modId: m[1].trim() })
    }
  }
  return rows
}

// Mod ids claimed by more than one folder. PZ resolves the collision by scan order, so a server
// with any of these boots nondeterministically — the "restart it twice and it works" symptom.
function duplicateModIds(s) {
  const byId = {}
  for (const row of modIdsByFolder(s)) (byId[row.modId] = byId[row.modId] || []).push(row)
  return Object.entries(byId)
    .filter(([, rows]) => rows.length > 1)
    .map(([modId, rows]) => ({ modId, providers: rows.map(r => ({ workshopId: r.workshopId, folder: r.folder })) }))
}

// Full mod.info metadata for every installed mod, keyed by mod id. Same files
// modIdsFromWorkshop() reads, but keeps the dependency fields as well.
function installedModMeta(s) {
  const buildRank = serverBuildRank(s)
  const out = {}
  for (const wid of getIniList(s, 'WorkshopItems')) {
    // Same root modFolders() walked. Reading folder names from one tree and mod.info from the
    // other is how a renamed mod ends up listed as "not installed": the folder is found in the
    // install tree, the id is read from the mirror's never-overwritten copy, and the two disagree.
    const dir = itemModsRoot(s, wid)
    for (const folder of modFolders(s, wid)) {
      const info = preferredModInfo(path.join(dir, folder), buildRank)
      if (!info) continue
      let txt
      try { txt = fs.readFileSync(info, 'utf8') } catch { continue }
      // .trim() also drops the trailing \r on CRLF mod.info files, which many mods ship.
      const field = k => {
        const m = txt.match(new RegExp('^' + k + '=(.*)$', 'm'))
        return m ? m[1].trim() : ''
      }
      const id = field('id')
      if (!id) continue
      out[id] = {
        workshopId: wid,
        name: field('name') || id,
        require: parseDepList(field('require')),
        incompatible: parseDepList(field('incompatible')),
        loadModAfter: parseDepList(field('loadModAfter'))
      }
    }
  }
  return out
}

// The build the game is running, read from its own log ("version=42.20.4 b0bbce05d5 demo=false").
// Returns null when it cannot be read — a server that has never booted, or a rotated log — and
// every caller treats null as "take the newest version folder" rather than refusing to answer.
function serverBuildRank(s) {
  try {
    const logs = fs.readdirSync(logDir(s)).filter(f => f.endsWith('_DebugLog-server.txt')).sort()
    if (!logs.length) return null
    const head = fs.readFileSync(path.join(logDir(s), logs[logs.length - 1]), 'utf8').slice(0, 20000)
    const m = head.match(/version=(\d+(?:\.\d+){0,2})/)
    return m ? versionRank(m[1]) : null
  } catch { return null }
}

// Every id= in a mod folder, plus the one the game will actually register. PZ takes the highest
// version folder that is not newer than the build, falling back to the folder root (a B41 layout).
// findModInfo() deliberately is not used here — it answers "is there a mod", not "which id".
function folderIds(modFolder, buildRank) {
  const ids = []
  let best = null, bestRank = -1
  const read = (file) => {
    try {
      const m = fs.readFileSync(file, 'utf8').match(/^id=(.+)$/m)
      return m ? m[1].trim() : null
    } catch { return null }
  }
  const rootId = fs.existsSync(path.join(modFolder, 'mod.info')) ? read(path.join(modFolder, 'mod.info')) : null
  if (rootId) ids.push(rootId)
  // Every immediate subfolder, not just version-named ones: mod.info legitimately lives in
  // common/ with nothing at the root (CarriableItems and B42PackMule both ship that way), and
  // missing it reports a perfectly healthy mod as an orphan. Generous about what counts as
  // *provided* — that is the obtainability question — and strict about which id actually loads,
  // which only a version folder can decide.
  let commonId = null
  for (const sub of safeReaddir(modFolder)) {
    const id = read(path.join(modFolder, sub, 'mod.info'))
    if (!id) continue
    ids.push(id)
    const rank = versionRank(sub)
    if (rank === null) { if (sub === 'common') commonId = id; continue }
    if ((buildRank === null || rank <= buildRank) && rank > bestRank) { bestRank = rank; best = id }
  }
  return { ids: [...new Set(ids)], preferredId: best || rootId || commonId || null }
}

module.exports = {
  findModInfo, preferredModInfo, itemModsRoot, modFolders, modIdsFromWorkshop,
  modNamesFromWorkshop, modIdsByFolder, duplicateModIds, installedModMeta,
  serverBuildRank, folderIds,
}
