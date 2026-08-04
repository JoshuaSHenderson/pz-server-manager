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

// The UI moves rows in the DOM instead of re-rendering the list, to keep scroll position and
// focus. That path does removeChild(children[from]) then insertBefore(node, children[target]),
// where children[] has already shifted after the removal. Simulate it and assert it agrees with
// moveItem for every from/to pair — this is exactly where an off-by-one would silently corrupt
// the order the user then saves.
function domMove(list, from, to) {
  const kids = list.slice()
  const last = kids.length - 1
  const target = Math.max(0, Math.min(last, to))
  const [node] = kids.splice(from, 1)          // removeChild
  const ref = kids[target]                     // children[target] AFTER removal, or undefined
  const at = ref === undefined ? kids.length : kids.indexOf(ref)
  kids.splice(at, 0, node)                     // insertBefore(node, ref || null)
  return kids
}
const sample = ['A', 'B', 'C', 'D', 'E']
for (let from = 0; from < sample.length; from++) {
  for (let to = 0; to < sample.length; to++) {
    assert.deepStrictEqual(domMove(sample, from, to), moveItem(sample, from, to),
      'DOM move disagrees with moveItem for ' + from + '->' + to)
  }
}
// Clamped targets must agree too — Top/Bottom pass out-of-range values.
assert.deepStrictEqual(domMove(sample, 2, -3), moveItem(sample, 2, -3))
assert.deepStrictEqual(domMove(sample, 2, 99), moveItem(sample, 2, 99))

console.log('order: all assertions passed')
