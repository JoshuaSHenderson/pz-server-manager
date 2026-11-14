// Snapshots of Mods=, so a reordering can be undone.
//
// Mods= is load order: later entries override earlier ones, and mods with loadModAfter= expect to
// sit behind their dependencies. Reordering rewrites the whole line, so every save snapshots the
// previous order first - a bad drag is then one click to undo rather than a hand-rebuilt list of
// 180 mod ids.
//
// Anything that rewrites Mods= takes a snapshot first, including the reinstall flow and the
// one-pair load-order fix, not just the drag-and-drop editor.

const fs = require('fs')
const path = require('path')
const { modOrderBackupDir } = require('../paths')
const { getIniList } = require('../domain/ini')
const { safeReaddir, readJson } = require('../util/fsx')

/** @typedef {import('../paths').Server} Server */

// --- Load order ---
//
// Mods= is load order: later entries override earlier ones, and mods with loadModAfter= expect to
// sit behind their dependencies. Reordering rewrites the whole line, so every save snapshots the
// previous order first — a bad drag is then one click to undo rather than a hand-rebuilt list of
// 180 mod ids.
const MOD_ORDER_BACKUP_KEEP = 20

/**
 * The saved snapshots, newest first. Filenames are timestamps, so a reverse sort is chronological.
 * @param {Server} s
 */
function listModOrderBackups(s) {
  return safeReaddir(modOrderBackupDir(s))
    .filter(f => f.startsWith('Mods-') && f.endsWith('.json'))
    .sort().reverse()
    .map(f => {
      /** @type {{ savedAt?: string, label?: string, mods?: string[] }} */
      const entry = readJson(path.join(modOrderBackupDir(s), f), {})
      return { file: f, savedAt: entry.savedAt || '', label: entry.label || '', count: (entry.mods || []).length }
    })
}

function backupModOrder(s, label) {
  const dir = modOrderBackupDir(s)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = 'Mods-' + stamp + '.json'
  fs.writeFileSync(path.join(dir, file), JSON.stringify({
    savedAt: new Date().toISOString(),
    label: label || '',
    mods: getIniList(s, 'Mods')
  }, null, 2))
  // Keep the most recent few; these are tiny but unbounded growth is nobody's friend.
  const all = listModOrderBackups(s)
  for (const old of all.slice(MOD_ORDER_BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(dir, old.file)) } catch {}
  }
  return file
}

module.exports = { listModOrderBackups, backupModOrder, MOD_ORDER_BACKUP_KEEP }
