// Which Workshop items a collection sync should delete.
//
// Pure on purpose: this decides what gets rm -rf'd, so it lives apart from the server and has a
// test (test_prune.js). An item is prunable only if it was tracked before, Steam no longer lists
// it in the collection, and no other tracked collection still owns it.
function prunableItems(previous, leaves, otherCollections) {
  const stillListed = new Set(leaves || [])
  const othersOwn = new Set()
  for (const c of otherCollections || []) {
    for (const i of (c.items || [])) othersOwn.add(i)
  }
  return (previous || []).filter(id => !stillListed.has(id) && !othersOwn.has(id))
}

module.exports = { prunableItems }
