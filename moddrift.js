// Mod id drift: when the id in Mods= stops being the id the Workshop publishes.
//
// Mod authors rename id= between version folders — SpnCharCustom -> SPNCC, zHBVCEF -> HBVCEFb42,
// MarzGuns -> GunsOfMarz, and 3161951724 fixing a typo, 76chevyKserieseExpanded ->
// 76chevyKseriesExpanded. The Workshop copy moves on; <data>/mods keeps whatever was copied the
// first time, because registerInstalledMod() only copies when the destination does not exist.
// So the old id stays alive locally, the server keeps loading it happily, and every disk check
// passes — while Steam, and therefore every client, has only the new one.
//
// The result is the failure this module exists to catch:
//
//   Mod "'76 Chevrolet K series Expanded" is not installed
//   [ModID: 76chevyKserieseExpanded, WorkshopID: ]
//
// The empty WorkshopID is the signature: the server is asking for an id no Workshop item
// publishes, so the client has nothing to download and cannot join. Note what this is NOT — the
// mod loaded fine on the server, so reportDeadMods() sees nothing wrong. A dead entry is a
// server-side problem the boot log can see; this is a client-side problem only the disk can see.
//
// The stable key across a rename is the mod FOLDER name, not the id: <data>/mods/GunsOfMarz and
// .../3722134990/mods/GunsOfMarz are the same mod, one build apart. That is what lets us suggest
// a repair rather than just report a fault.

// inventory: one entry per mod folder found on disk
//   { folder, source: 'workshop' | 'local', workshopId, ids: [...], preferredId }
//   ids         every id= in the folder (root and every version subfolder)
//   preferredId the id the game will actually register — highest version folder <= build.
//               Resolved by the caller, which is the half that needs the filesystem.
// enabled: the Mods= list, in load order.
function analyzeModDrift(opts) {
  opts = opts || {}
  const enabled = (opts.enabled || []).map(s => String(s).trim()).filter(Boolean)
  const inventory = opts.inventory || []

  const workshop = inventory.filter(e => e.source === 'workshop')
  const local = inventory.filter(e => e.source === 'local')
  const publishes = (entry, id) => (entry.ids || []).includes(id)

  const issues = []
  const ok = []

  for (const id of enabled) {
    // A client can only ever obtain a mod through a Workshop item, so that — not <data>/mods —
    // is what decides whether this entry is joinable.
    if (workshop.some(e => publishes(e, id))) { ok.push(id); continue }

    const holders = local.filter(e => publishes(e, id))
    if (!holders.length) {
      // Nothing on disk provides it at all. Not a drift — a missing mod.
      issues.push({ id, kind: 'orphan', folder: null, suggest: [], workshopId: null })
      continue
    }

    // Same folder name in the Workshop tree = the same mod, one build newer. Its preferred id is
    // the rename target.
    // filter, not find: two Workshop items can ship a folder of the same name, and collapsing
    // them to the first would hide the ambiguity and let planRepair() apply a guess.
    const twins = holders.flatMap(h => workshop.filter(w => w.folder === h.folder))

    if (!twins.length) {
      // Local-only mod: no Workshop item ships this folder, so no client can ever get it. There is
      // no id to rename to — it has to be removed or published.
      issues.push({
        id, kind: 'localOnly', folder: holders[0].folder, suggest: [], workshopId: null,
      })
      continue
    }

    const suggest = [...new Set(twins.map(t => t.preferredId).filter(Boolean))]
    issues.push({
      id,
      kind: 'clientBlocked',
      folder: twins[0].folder,
      workshopId: twins[0].workshopId || null,
      // More than one candidate means two Workshop items ship a folder of this name; the caller
      // must not auto-apply an ambiguous rename.
      suggest,
    })
  }

  return { ok, issues }
}

// A repair is only ever a rename in place: same position in Mods=, same length. Load order is what
// loadModAfter depends on, and dropping an id is the one edit that loses items, so neither is on
// the table here.
//
// Every requested remap is checked against a freshly computed analysis — the caller may not invent
// a target — and an ambiguous suggestion is refused rather than guessed.
function planRepair(analysis, mods, remaps) {
  const byId = new Map()
  for (const i of (analysis.issues || [])) byId.set(i.id, i)

  const applied = []
  const rejected = []
  let next = [...mods]

  for (const r of remaps || []) {
    const from = String((r || {}).from || '').trim()
    const to = String((r || {}).to || '').trim()
    const issue = byId.get(from)

    if (!issue) { rejected.push({ from, to, reason: 'not a reported drift issue' }); continue }
    if (issue.kind !== 'clientBlocked') { rejected.push({ from, to, reason: 'kind ' + issue.kind + ' has no rename target' }); continue }
    if (!issue.suggest.includes(to)) { rejected.push({ from, to, reason: 'not a suggested target for ' + from }); continue }
    if (issue.suggest.length > 1) { rejected.push({ from, to, reason: 'ambiguous: ' + issue.suggest.join(', ') }); continue }
    const at = next.indexOf(from)
    if (at === -1) { rejected.push({ from, to, reason: 'not in Mods=' }); continue }
    if (next.includes(to)) { rejected.push({ from, to, reason: to + ' is already enabled' }); continue }

    next[at] = to
    applied.push({ from, to, position: at })
  }

  return { mods: next, applied, rejected }
}

// A version folder is "41", "42" or "42.13" and nothing else. Strict on purpose: parseInt() alone
// reads "49powerWagon" as 49 and "76chevyKseries" as 76, which silently reclassifies a third of
// the mod folders on this server as version folders and hides them from the inventory.
// Returns null for anything that is not purely numeric-dotted.
function versionRank(v) {
  if (!/^\d+(\.\d+){0,2}$/.test(String(v))) return null
  const p = String(v).split('.').map(n => parseInt(n, 10))
  return (p[0] || 0) * 10000 + (p[1] || 0) * 100 + (p[2] || 0)
}

module.exports = { analyzeModDrift, planRepair, versionRank }
