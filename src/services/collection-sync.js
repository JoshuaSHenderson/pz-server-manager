// Resolving a Workshop collection to real mods, and keeping a tracked one in step with it.
//
// A PZ collection routinely contains other collections, and installing those ids directly produces
// "mods" that are really collection stubs with no game content - so everything is resolved down to
// leaves first.
//
// Syncing is purely additive, and that is a decision rather than an omission. Mods the curator has
// dropped are recorded on the registry entry and surfaced, never deleted: pulling one out from
// under a running server desyncs every connected client, and a mod vanishing as a silent side
// effect of "check for updates" is indistinguishable from the server eating someone's save. The
// operator removes them and restarts when it suits them.

const { autoSyncPath } = require('../paths')
const { readJson, writeJson } = require('../util/fsx')
const { getIniList } = require('../domain/ini')
const { resolveCollectionLeaves, getTitles } = require('../infra/steam')
const { readCollections, writeCollections, upsertCollection } = require('./collections')
const { hasModContent, steamcmdDownload } = require('./downloads')
const { droppedItems } = require('../../lib/prune')
const { logFor } = require('../log')

/** @typedef {import('../paths').Server} Server */

// Install (or re-install) a collection: resolves nested collections down to real mod items,
// records it in the registry, and queues anything not already present.
//
// Syncing is purely additive. Mods the curator has dropped are recorded on the registry entry
// and surfaced — in the Mods tab and as an alert — but never deleted here. Deleting one out from
// under a running server desyncs every connected client, and a mod vanishing as a silent side
// effect of "check for updates" is indistinguishable from the server eating someone's save. The
// operator removes them and restarts when it suits them.
function installCollection(s, collectionId, cb) {
  resolveCollectionLeaves(collectionId, (err, leaves, nested) => {
    if (err) return cb(err)
    getTitles([collectionId], titles => {
      // Captured before the upsert overwrites it — this is what the collection used to contain.
      const existing = readCollections(s).find(c => c.id === collectionId)
      const previous = (existing && existing.items) || []
      const installed = getIniList(s, 'WorkshopItems')
      const have = new Set(installed)
      const todo = leaves.filter(id => !have.has(id) || !hasModContent(s, id))
      const dropped = droppedItems({
        knownDropped: (existing && existing.droppedItems) || [],
        previous,
        leaves,
        otherCollections: readCollections(s).filter(c => c.id !== collectionId),
        installed
      })
      upsertCollection(s, {
        id: collectionId,
        title: titles[collectionId] || '',
        items: leaves,
        nestedCollections: nested || [],
        droppedItems: dropped,
        lastSynced: new Date().toISOString()
      })
      if (dropped.length) logFor(s, 'collection ' + collectionId + ': ' + dropped.length + ' dropped mod(s) still installed, awaiting removal [' + dropped.join(', ') + ']')
      logFor(s, 'collection ' + collectionId + ' synced: ' + leaves.length + ' item(s), ' + todo.length + ' to download')
      if (todo.length) steamcmdDownload(s, todo, 'collection', collectionId)
      cb(null, {
        total: leaves.length, queued: todo.length, nested: (nested || []).length,
        dropped: dropped.length, droppedIds: dropped
      })
    })
  })
}

// Every mod the curators have dropped, across every tracked collection, that is still installed.
// One flat list because that is how it gets acted on: remove them, then restart once.
function allDroppedItems(s) {
  const seen = new Set()
  const out = []
  for (const c of readCollections(s)) {
    for (const id of (c.droppedItems || [])) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, collectionId: c.id, collectionTitle: c.title || '' })
    }
  }
  return out
}

// --- Scheduled collection auto-sync ---
// Config lives alongside the registry so it survives restarts. Off by default.

/** @param {Server} s */
function readAutoSync(s) {
  return Object.assign({ enabled: false, intervalHours: 24, lastRun: null }, readJson(autoSyncPath(s), {}))
}

/**
 * Swallows a write failure for the same reason auto-update does: the stored lastRun is a schedule
 * hint, and losing one costs an extra sync rather than anything irreversible.
 * @param {Server} s @param {any} cfg
 */
function writeAutoSync(s, cfg) {
  try { writeJson(autoSyncPath(s), cfg) }
  catch (e) { console.error('[autosync] could not persist state for ' + s.id + ': ' + e.message) }
}

module.exports = { installCollection, allDroppedItems, readAutoSync, writeAutoSync }
