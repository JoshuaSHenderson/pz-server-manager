// Listing the backup archives on disk, and deciding which ones a request may name.
//
// Three kinds live side by side: the ones the game image writes at startup, the ones it writes on
// a version change, and the ones an operator has uploaded here. They are all read-only from this
// manager's point of view except the manual set.
//
// validBackupPath() is the gate. A name reaches it straight from a query string and ends up as a
// filesystem path, so it must contain no separator, not start with a dot, carry a known extension,
// and resolve to a file that already exists in the directory for its kind.

const fs = require('fs')
const path = require('path')
const { backupDirs } = require('../paths')
const { safeReaddir } = require('../util/fsx')

/** @typedef {import('../paths').Server} Server */

// ===== BACKUP HELPERS =====

/**
 * The archives in one backup directory, newest first.
 * @param {string} dir
 * @returns {{ name: string, size: number, mtime: string }[]}
 */
function listBackupDir(dir) {
  return safeReaddir(dir)
    .filter(f => f.endsWith('.zip') || f.endsWith('.tar.gz'))
    .flatMap(f => {
      // A file can vanish between the readdir and the stat — a rotation, or an upload being
      // cleaned up. Dropping it is better than failing the whole listing.
      try {
        const stat = fs.statSync(path.join(dir, f))
        return [{ name: f, size: stat.size, mtime: stat.mtime.toISOString() }]
      } catch { return [] }
    })
    .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
}

function validBackupPath(s, type, name) {
  const dir = backupDirs(s)[type]
  if (!dir) return null
  if (!name || /[/\\]/.test(name) || name.startsWith('.')) return null
  if (!name.endsWith('.zip') && !name.endsWith('.tar.gz')) return null
  const p = path.join(dir, name)
  if (!fs.existsSync(p)) return null
  return p
}

module.exports = { listBackupDir, validBackupPath }
