// Run: node test_prune.js
const assert = require('assert')
const { prunableItems, droppedItems } = require('./prune')

// Dropped from the collection -> prunable.
assert.deepStrictEqual(prunableItems(['1', '2', '3'], ['1', '2'], []), ['3'])

// Nothing dropped -> nothing removed.
assert.deepStrictEqual(prunableItems(['1', '2'], ['1', '2'], []), [])

// New items appearing are an install concern, never a prune concern.
assert.deepStrictEqual(prunableItems(['1'], ['1', '2', '3'], []), [])

// The one that must never regress: a dropped item another tracked collection still lists is kept.
assert.deepStrictEqual(prunableItems(['1', '2'], ['1'], [{ items: ['2'] }]), [])

// ...but a dropped item no other collection lists is still removed alongside it.
assert.deepStrictEqual(prunableItems(['1', '2', '3'], ['1'], [{ items: ['2'] }]), ['3'])

// Multiple other collections, several sharers.
assert.deepStrictEqual(
  prunableItems(['a', 'b', 'c', 'd'], ['a'], [{ items: ['b'] }, { items: ['c', 'z'] }]),
  ['d']
)

// First sync (no previous state) can never delete anything.
assert.deepStrictEqual(prunableItems([], ['1', '2'], []), [])

// Missing/undefined inputs are treated as empty, not thrown on — a malformed registry entry
// must not crash the sync loop mid-run.
assert.deepStrictEqual(prunableItems(undefined, undefined, undefined), [])
assert.deepStrictEqual(prunableItems(['1'], [], [{}]), ['1'])

// --- droppedItems: the reported list, which must survive repeated syncs ---

// A curator drop that is still installed here gets reported.
assert.deepStrictEqual(droppedItems({
  previous: ['1', '2', '3'], leaves: ['1', '2'], installed: ['1', '2', '3']
}), ['3'])

// The regression this function exists to prevent: on the NEXT sync `previous` has already become
// `leaves`, so nothing is freshly dropped — the earlier finding must still be carried.
assert.deepStrictEqual(droppedItems({
  knownDropped: ['3'], previous: ['1', '2'], leaves: ['1', '2'], installed: ['1', '2', '3']
}), ['3'])

// Operator removed it -> it drops off the list by itself.
assert.deepStrictEqual(droppedItems({
  knownDropped: ['3'], previous: ['1', '2'], leaves: ['1', '2'], installed: ['1', '2']
}), [])

// Curator put it back -> no longer outstanding.
assert.deepStrictEqual(droppedItems({
  knownDropped: ['3'], previous: ['1', '2'], leaves: ['1', '2', '3'], installed: ['1', '2', '3']
}), [])

// Another tracked collection picked it up -> not ours to report.
assert.deepStrictEqual(droppedItems({
  knownDropped: ['3'], previous: ['1'], leaves: ['1'],
  otherCollections: [{ items: ['3'] }], installed: ['1', '3']
}), [])

// A drop that was never installed here is nothing to act on.
assert.deepStrictEqual(droppedItems({
  previous: ['1', '2'], leaves: ['1'], installed: ['1']
}), [])

// Carried and fresh findings merge without duplicating.
assert.deepStrictEqual(droppedItems({
  knownDropped: ['3'], previous: ['1', '3', '4'], leaves: ['1'], installed: ['1', '3', '4']
}), ['3', '4'])

// Malformed/empty input must not throw — this runs inside the auto-sync loop.
assert.deepStrictEqual(droppedItems(), [])
assert.deepStrictEqual(droppedItems({}), [])

console.log('prune: all assertions passed')
