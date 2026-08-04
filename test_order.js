// Run: node test_order.js
const assert = require('assert')
const { validateReorder, moveItem } = require('./order')

const cur = ['A', 'B', 'C']

// A pure permutation is the only thing accepted.
assert.deepStrictEqual(validateReorder(cur, ['C', 'A', 'B']), { ok: true })
assert.deepStrictEqual(validateReorder(cur, ['A', 'B', 'C']), { ok: true })
assert.deepStrictEqual(validateReorder([], []), { ok: true })

// The failures that would silently change which mods load.
assert.strictEqual(validateReorder(cur, ['A', 'B']).ok, false)          // dropped
assert.strictEqual(validateReorder(cur, ['A', 'B', 'C', 'D']).ok, false) // invented
assert.strictEqual(validateReorder(cur, ['A', 'B', 'B']).ok, false)      // duplicated
assert.match(validateReorder(cur, ['A', 'B']).error, /Missing from the new order: C/)
assert.match(validateReorder(cur, ['A', 'B', 'C', 'D']).error, /Not currently enabled: D/)
assert.match(validateReorder(cur, ['A', 'B', 'B']).error, /Wrong number of entries for: C|Missing from the new order: C/)

// Shape guards — these come straight off an HTTP body.
assert.strictEqual(validateReorder(cur, 'A,B,C').ok, false)
assert.strictEqual(validateReorder(cur, null).ok, false)
assert.strictEqual(validateReorder(cur, ['A', '', 'C']).ok, false)
assert.strictEqual(validateReorder(cur, ['A', 3, 'C']).ok, false)

// Ids differing only by case are different mods here — Mods= is written verbatim.
assert.strictEqual(validateReorder(cur, ['a', 'B', 'C']).ok, false)

// moveItem
assert.deepStrictEqual(moveItem(['A', 'B', 'C'], 0, 2), ['B', 'C', 'A'])
assert.deepStrictEqual(moveItem(['A', 'B', 'C'], 2, 0), ['C', 'A', 'B'])
assert.deepStrictEqual(moveItem(['A', 'B', 'C'], 1, 1), ['A', 'B', 'C'])
// Out-of-range targets clamp instead of creating holes or dropping entries.
assert.deepStrictEqual(moveItem(['A', 'B', 'C'], 0, -5), ['A', 'B', 'C'])
assert.deepStrictEqual(moveItem(['A', 'B', 'C'], 0, 99), ['B', 'C', 'A'])
assert.deepStrictEqual(moveItem(['A', 'B', 'C'], 9, 0), ['A', 'B', 'C'])
// Never mutates its input.
const src = ['A', 'B', 'C']
moveItem(src, 0, 2)
assert.deepStrictEqual(src, ['A', 'B', 'C'])
// A move is always a permutation, which is what validateReorder demands.
assert.deepStrictEqual(validateReorder(src, moveItem(src, 0, 2)), { ok: true })

console.log('order: all assertions passed')
