// Run: node test_prune.js
const assert = require('assert')
const { prunableItems } = require('./prune')

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

console.log('prune: all assertions passed')
