// Load-order validation.
//
// Reordering writes Mods= wholesale. A dropped or invented entry there silently changes which
// mods the server loads, so the submitted list must be a pure permutation of the current one —
// adding and removing mods is what the per-mod toggles are for. Pure, tested in test_order.js.

function counts(list) {
  const m = new Map()
  for (const v of list) m.set(v, (m.get(v) || 0) + 1)
  return m
}

// Returns { ok: true } or { ok: false, error } describing exactly what differs, so the UI can
// show the user something better than "invalid".
function validateReorder(current, next) {
  if (!Array.isArray(next)) return { ok: false, error: 'mods must be an array' }
  if (next.some(v => typeof v !== 'string' || !v.trim())) {
    return { ok: false, error: 'mods must contain only non-empty strings' }
  }
  const a = counts(current || [])
  const b = counts(next)

  const added = [...b.keys()].filter(k => !a.has(k))
  if (added.length) return { ok: false, error: 'Not currently enabled: ' + added.join(', ') }

  const removed = [...a.keys()].filter(k => !b.has(k))
  if (removed.length) return { ok: false, error: 'Missing from the new order: ' + removed.join(', ') }

  for (const [k, n] of a) {
    if (b.get(k) !== n) return { ok: false, error: 'Wrong number of entries for: ' + k }
  }
  return { ok: true }
}

// Move one entry to a new index, clamped. Returns a new array; the original is untouched.
function moveItem(list, from, to) {
  const out = (list || []).slice()
  if (from < 0 || from >= out.length) return out
  const target = Math.max(0, Math.min(out.length - 1, to))
  const [item] = out.splice(from, 1)
  out.splice(target, 0, item)
  return out
}

module.exports = { validateReorder, moveItem }
