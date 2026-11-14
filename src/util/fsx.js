// Filesystem reads that are allowed to come back empty.
//
// Most of what this manager reads may legitimately not be there yet: a server that has never
// booted has no Logs directory, a server with no collections has no collections.json, a fresh
// volume has none of it. Those are ordinary states, not errors, and every call site used to spell
// that out with its own try/catch — forty-odd of them, several of which swallowed a real failure
// along with the expected absence.

const fs = require('fs')

/**
 * Directory entries, or [] if the directory is missing or unreadable.
 * @param {string} dir
 * @returns {string[]}
 */
function safeReaddir(dir) {
  try { return fs.readdirSync(dir) } catch { return [] }
}

/**
 * Subdirectory names only.
 * @param {string} dir
 * @returns {string[]}
 */
function safeReaddirDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch { return [] }
}

/**
 * Parse a JSON file, falling back to `fallback` when it is missing or corrupt.
 *
 * Corrupt is treated the same as missing on purpose: these files are small pieces of manager state
 * (a queue, a registry, an ignore list), and refusing to start because one of them was truncated by
 * a power cut would take the whole manager down over a recoverable inconvenience. A parse failure
 * is logged so it is not silent.
 *
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {T}
 */
function readJson(file, fallback) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return fallback }
  try { return JSON.parse(raw) } catch (e) {
    console.error('[store] ' + file + ' is not valid JSON, falling back to the default: ' + e.message)
    return fallback
  }
}

/**
 * Write a JSON file, pretty-printed the way every one of these files already was.
 *
 * Deliberately allowed to throw. These writes are the durable half of an action the user just
 * asked for — an exclusion that is not saved is an exclusion that silently comes back on the next
 * download — so a caller that cannot afford to lose one must be able to see that it failed.
 *
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
}

module.exports = { safeReaddir, safeReaddirDirs, readJson, writeJson }
