// Dependency warnings the operator has dismissed.
//
// PZ will not tell you a requirement is unmet; the mod just misbehaves in-game. So every installed
// mod.info's require= / incompatible= / loadModAfter= is read and compared against Mods=.
//
// Nothing is auto-installed or auto-enabled from that analysis, because not every declared
// requirement is genuinely required - authors list optional companion mods in require= constantly.
// Issues are reported and the operator decides, and this is the list of the ones they have decided
// do not apply. Scoped to a dependent>dependency pair rather than to a mod, so ignoring one
// optional companion does not silence a real problem in the same mod.

const { depIgnorePath } = require('../paths')
const { readJson, writeJson } = require('../util/fsx')

/** @typedef {import('../paths').Server} Server */

/** @param {Server} s @returns {string[]} */
function readDepIgnores(s) {
  const v = readJson(depIgnorePath(s), [])
  return Array.isArray(v) ? v : []
}

/**
 * Swallows a write failure: a lost dismissal re-reports a warning, which is an annoyance rather
 * than a risk. Contrast writeExcludes, which is deliberately allowed to throw because a lost
 * exclusion means the server quietly goes back to booting wrong.
 * @param {Server} s @param {string[]} list
 */
function writeDepIgnores(s, list) {
  try { writeJson(depIgnorePath(s), list) }
  catch (e) { console.error('[deps] could not persist ignores for ' + s.id + ': ' + e.message) }
}

/** @param {string} modId @param {string} dependency */
function depKey(modId, dependency) { return modId + '>' + dependency }

module.exports = { readDepIgnores, writeDepIgnores, depKey }
