// Mod dependency analysis.
//
// Pure on purpose: this decides what the UI warns about, and a false alarm here costs the user
// real time chasing a problem that isn't there. Tested in test_deps.js.
//
// PZ declares relationships in mod.info:
//   require=A,B          hard dependency — the game expects these loaded
//   incompatible=A,B     known conflict
//   loadModAfter=A,B     must appear after these in Mods=
// Values are comma separated, frequently carry a leading backslash (require=\SomeMod), and
// trailing commas are common.

function parseDepList(raw) {
  return String(raw || '')
    .split(',')
    .map(s => s.trim().replace(/^\\+/, ''))
    .filter(Boolean)
}

// Mod ids are compared case-insensitively. Authors routinely mis-case a dependency id, and
// warning that a mod is "missing" when it is installed under a different case is worse than
// missing a genuine case-only mismatch — the game itself is the arbiter either way.
function norm(id) { return String(id || '').toLowerCase() }

// enabled   : mod ids in Mods=, in load order
// installed : every mod id present on disk (enabled or not)
// meta      : { [modId]: { require: [], incompatible: [], loadModAfter: [] } }
// ignores   : ["dependentModId>dependencyId", ...] issues the user has dismissed
//
// Only enabled mods are analysed: a mod that isn't loaded can't have unmet needs.
function analyzeDependencies(opts) {
  opts = opts || {}
  const enabled = opts.enabled || []
  const installed = opts.installed || []
  const meta = opts.meta || {}
  const ignored = new Set((opts.ignores || []).map(norm))

  const enabledSet = new Set(enabled.map(norm))
  const installedSet = new Set(installed.map(norm))
  const position = {}
  enabled.forEach((id, i) => { position[norm(id)] = i })

  const issues = []
  const add = (type, modId, dependency, detail) => {
    if (ignored.has(norm(modId + '>' + dependency))) return
    issues.push(Object.assign({ type: type, modId: modId, dependency: dependency }, detail || {}))
  }

  for (const modId of enabled) {
    const m = meta[modId] || meta[Object.keys(meta).find(k => norm(k) === norm(modId))] || {}

    for (const dep of (m.require || [])) {
      if (enabledSet.has(norm(dep))) continue
      // Installed but not loaded is a one-click fix; not installed at all needs a download.
      add(installedSet.has(norm(dep)) ? 'disabled' : 'missing', modId, dep)
    }

    for (const bad of (m.incompatible || [])) {
      if (enabledSet.has(norm(bad))) add('incompatible', modId, bad)
    }

    // Order only matters when both are actually loaded.
    for (const after of (m.loadModAfter || [])) {
      if (!enabledSet.has(norm(after))) continue
      if (position[norm(after)] > position[norm(modId)]) {
        add('order', modId, after, { modIndex: position[norm(modId)], dependencyIndex: position[norm(after)] })
      }
    }
  }
  return issues
}

// Worst-first, so the UI's first row is the one most likely to break the server.
const SEVERITY = { incompatible: 0, missing: 1, disabled: 2, order: 3 }
function sortIssues(issues) {
  return issues.slice().sort((a, b) =>
    (SEVERITY[a.type] - SEVERITY[b.type]) || String(a.modId).localeCompare(String(b.modId)))
}

module.exports = { parseDepList, analyzeDependencies, sortIssues, SEVERITY }
