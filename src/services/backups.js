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

function listBackupDir(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.zip') || f.endsWith('.tar.gz'))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f))
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() }
      })
      .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
  } catch { return [] }
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
