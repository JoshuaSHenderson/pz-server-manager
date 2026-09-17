// The registry of Workshop collections this server tracks.
//
// Persisted per server so a collection can be listed, re-synced to pick up items the curator has
// added upstream, and untracked. Syncing is deliberately additive: a mod the curator dropped is
// recorded and surfaced, never deleted here. Deleting one out from under a running server desyncs
// every connected client, and a mod vanishing as a silent side effect of "check for updates" is
// indistinguishable from the server eating someone's save.

const { collectionsPath } = require('../paths')
const { readJson, writeJson } = require('../util/fsx')

/** @typedef {import('../paths').Server} Server */

// --- Collections registry (persisted per server) ---
// Tracks which collections were installed here so they can be listed, re-synced (to pick up
// items added to the collection upstream), and removed.
/** @param {Server} s @returns {any[]} */
function readCollections(s) { return readJson(collectionsPath(s), []) }

/** @param {Server} s @param {any[]} list */
function writeCollections(s, list) {
  try { writeJson(collectionsPath(s), list) }
  catch (e) { console.error('[collections] write failed:', e.message) }
}
/**
 * Insert or merge one collection entry, keyed by id.
 * @param {Server} s
 * @param {{ id: string, [k: string]: any }} entry
 */
function upsertCollection(s, entry) {
  const list = readCollections(s)
  const i = list.findIndex(c => c.id === entry.id)
  if (i >= 0) list[i] = Object.assign(list[i], entry)
  else list.push(entry)
  writeCollections(s, list)
}

module.exports = { readCollections, writeCollections, upsertCollection }
