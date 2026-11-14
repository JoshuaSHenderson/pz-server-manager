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

// What a collection's curator has dropped that is still installed here.
//
// Reported rather than deleted. Pulling a mod out from under a running server desyncs every
// connected client, so the operator gets a list and removes it deliberately, on a restart of
// their choosing.
//
// The list has to be carried forward. After a sync, the stored `items` become the next sync's
// `previous` — so recomputing from scratch would find the dropped mod once and then forget it
// on the very next pass. Anything already known stays on the list until it genuinely goes away:
// uninstalled by the operator, put back by the curator, or picked up by another collection.
function droppedItems(o) {
  o = o || {}
  const stillListed = new Set(o.leaves || [])
  const othersOwn = new Set()
  for (const c of o.otherCollections || []) {
    for (const i of (c.items || [])) othersOwn.add(i)
  }
  const installed = new Set(o.installed || [])
  const resolved = id => !installed.has(id) || stillListed.has(id) || othersOwn.has(id)

  const carried = (o.knownDropped || []).filter(id => !resolved(id))
  const fresh = prunableItems(o.previous, o.leaves, o.otherCollections).filter(id => !resolved(id))
  return [...new Set([...carried, ...fresh])]
}

module.exports = { prunableItems, droppedItems }
