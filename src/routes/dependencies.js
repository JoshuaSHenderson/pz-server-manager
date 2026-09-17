// Unmet require=, declared conflicts, and load-order constraints.
//
// Nothing is auto-fixed. Authors list optional companion mods in require= constantly, so every
// finding is reported and the operator decides, with a per-pair ignore list for the ones that do
// not apply.

const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const { getIniList, setIniList } = require('../domain/ini')
const { installedModMeta } = require('../domain/modinfo')
const { readDepIgnores, writeDepIgnores, depKey } = require('../services/depignores')
const { backupModOrder } = require('../services/modorder')
const { getTitles } = require('../infra/steam')
const { analyzeDependencies, sortIssues } = require('../../lib/deps')
const { validateReorder, moveItem } = require('../../lib/order')

const router = require('express').Router()

// --- Mod dependencies ---
//
// PZ won't tell you a dependency is unmet; the mod just misbehaves in-game. These endpoints read
// require= / incompatible= / loadModAfter= from every installed mod.info and report what the
// current Mods= list doesn't satisfy.
//
// Not every declared requirement is genuinely required — authors list optional companion mods in
// require= all the time — so nothing is auto-installed or auto-enabled. Issues are reported and
// the user decides, with an ignore list for the ones that don't apply.
router.get('/api/dependencies', (req, res) => {
  const s = srv(req)
  const meta = installedModMeta(s)
  const enabled = getIniList(s, 'Mods')
  const ignores = readDepIgnores(s)
  const installed = Object.keys(meta)
  const issues = sortIssues(analyzeDependencies({ enabled, installed, meta, ignores }))

  // Resolve ids to something the UI can act on and a human can read.
  const byLowerId = {}
  for (const [id, m] of Object.entries(meta)) byLowerId[id.toLowerCase()] = Object.assign({ id }, m)

  res.json({
    issues: issues.map(i => {
      const self = byLowerId[String(i.modId).toLowerCase()] || {}
      const dep = byLowerId[String(i.dependency).toLowerCase()] || null
      return Object.assign({}, i, {
        key: depKey(i.modId, i.dependency),
        modName: self.name || i.modId,
        modWorkshopId: self.workshopId || null,
        dependencyName: dep ? dep.name : null,
        dependencyModId: dep ? dep.id : null,        // real-cased id, for enabling
        dependencyWorkshopId: dep ? dep.workshopId : null
      })
    }),
    checked: enabled.length,
    installedCount: installed.length,
    // Flagged rather than silently dropped: an ignore whose mod is no longer enabled can never
    // match again, so it sits in the list forever with nothing on screen explaining why. That is
    // what a mod id rename leaves behind — "MarzGuns>SWMG" outlived the id it was written for.
    // Still the user's decision to clear, so it is reported, not deleted.
    ignored: ignores.map(k => {
      const at = String(k).indexOf('>')
      const modId = at === -1 ? k : k.slice(0, at)
      const dependency = at === -1 ? '' : k.slice(at + 1)
      return {
        key: k, modId, dependency,
        stale: !enabled.some(id => id.toLowerCase() === String(modId).toLowerCase()),
      }
    })
  })
})

// Dismiss (or restore) one dependent>dependency pair. Scoped to the pair, not the mod, so
// ignoring one optional companion doesn't silence a genuine problem in the same mod.
router.post('/api/dependencies/ignore', (req, res) => {
  const s = srv(req)
  const { modId, dependency, ignored } = req.body || {}
  if (!modId || !dependency) return res.status(400).json({ error: 'modId and dependency are required' })
  if (typeof ignored !== 'boolean') return res.status(400).json({ error: 'ignored must be a boolean' })
  const key = depKey(modId, dependency)
  const list = readDepIgnores(s).filter(k => k.toLowerCase() !== key.toLowerCase())
  if (ignored) list.push(key)
  writeDepIgnores(s, list)
  logFor(s, (ignored ? 'ignoring' : 'restored') + ' dependency ' + key)
  res.json({ success: true, key, ignored })
})

// Satisfy one loadModAfter constraint by moving the dependent mod.
//
// "X must load after Y" with Y sitting later in Mods= is a pure ordering fault, so the repair is a
// move and nothing else: the mod that carries the constraint slides to just past the mod it names.
// moveItem(list, from, to) with to = the dependency's index does exactly that — removing the entry
// first shifts the dependency down one, so inserting at its old index lands immediately after it.
//
// Deliberately one pair per press. A mod can carry several loadModAfter entries and mods can
// constrain each other, so a single move can satisfy one pair and break another; a full
// topological sort would reshuffle a 173-entry list the user has hand-tuned. Instead the move is
// applied, the analysis re-run, and whatever is still outstanding reported back so the next press
// works on current facts.
//
// The pair must be a real, current issue — a caller cannot post an arbitrary move here, because
// this writes Mods= and order is what loadModAfter depends on.
router.post('/api/dependencies/fix-order', (req, res) => {
  const s = srv(req)
  const { modId, dependency } = req.body || {}
  if (!modId || !dependency) return res.status(400).json({ error: 'modId and dependency are required' })

  const meta = installedModMeta(s)
  const mods = getIniList(s, 'Mods')
  const issues = analyzeDependencies({
    enabled: mods, installed: Object.keys(meta), meta, ignores: readDepIgnores(s),
  })
  const lower = v => String(v).toLowerCase()
  const issue = issues.find(i => i.type === 'order' &&
    lower(i.modId) === lower(modId) && lower(i.dependency) === lower(dependency))
  if (!issue) return res.status(400).json({ error: 'Not a current load-order issue: ' + modId + ' after ' + dependency })

  // Resolve against Mods= itself: loadModAfter values are frequently mis-cased by authors.
  const from = mods.findIndex(id => lower(id) === lower(issue.modId))
  const to = mods.findIndex(id => lower(id) === lower(issue.dependency))
  if (from === -1 || to === -1) return res.status(400).json({ error: 'Both mods must be in the load order' })

  const next = moveItem(mods, from, to)
  const check = validateReorder(mods, next)
  if (!check.ok) return res.status(500).json({ error: 'Refusing to write a non-permutation: ' + check.error })

  const backup = backupModOrder(s, 'before load-order fix: ' + issue.modId + ' after ' + issue.dependency)
  setIniList(s, 'Mods', next)

  const remaining = analyzeDependencies({
    enabled: next, installed: Object.keys(meta), meta, ignores: readDepIgnores(s),
  }).filter(i => i.type === 'order')

  logFor(s, 'load-order fix: moved "' + issue.modId + '" from ' + (from + 1) + ' to ' + (to + 1) +
    ' so it loads after "' + issue.dependency + '"' +
    (remaining.length ? ' (' + remaining.length + ' order issue(s) still outstanding)' : '') +
    ', previous order backed up as ' + backup)

  res.json({
    success: true, modId: issue.modId, dependency: issue.dependency,
    from: from + 1, to: to + 1, backup,
    remainingOrderIssues: remaining.length, restartRequired: true,
  })
})

module.exports = router
