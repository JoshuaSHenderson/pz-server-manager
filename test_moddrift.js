// Run: node test_moddrift.js
const assert = require('assert')
const { analyzeModDrift, planRepair, versionRank } = require('./moddrift')

// --- the bug that reported 110 of 173 mods as unobtainable: parseInt("49powerWagon") is 49, so
// every mod folder whose name starts with a digit was mistaken for a version folder and dropped
// out of the inventory. A third of this server's mods are named that way.
for (const notAVersion of ['49powerWagon', '76chevyKseries', '59 Cadillac Miller-Meteor', 'common', 'Bandits', '42abc', '']) {
  assert.strictEqual(versionRank(notAVersion), null, notAVersion + ' must not parse as a version')
}
assert.strictEqual(versionRank('41'), 410000)
assert.strictEqual(versionRank('42'), 420000)
assert.ok(versionRank('42.13') < versionRank('42.20'))
assert.ok(versionRank('42.9') < versionRank('42.13'), 'version compare must be numeric, not lexical')

// The real inventory from 2026-09-11, trimmed to the cases that mattered.
const INVENTORY = [
  // Healthy: Workshop publishes exactly what Mods= asks for.
  { folder: 'Bandits', source: 'workshop', workshopId: '3268487204', ids: ['Bandits'], preferredId: 'Bandits' },
  { folder: 'Bandits', source: 'local', workshopId: null, ids: ['Bandits'], preferredId: 'Bandits' },

  // The typo fix. Both builds byte-identical; only the id moved.
  { folder: '76chevyKseriesExpanded', source: 'workshop', workshopId: '3161951724',
    ids: ['76chevyKseriesExpanded'], preferredId: '76chevyKseriesExpanded' },
  { folder: '76chevyKseriesExpanded', source: 'local', workshopId: null,
    ids: ['76chevyKserieseExpanded'], preferredId: '76chevyKserieseExpanded' },

  // The rename. Local is a whole build behind.
  { folder: 'GunsOfMarz', source: 'workshop', workshopId: '3722134990',
    ids: ['GunsOfMarz'], preferredId: 'GunsOfMarz' },
  { folder: 'GunsOfMarz', source: 'local', workshopId: null, ids: ['MarzGuns'], preferredId: 'MarzGuns' },

  // Version-folder rename: root still says the old id, 42.13 says the new one. preferredId is
  // what the running build actually registers.
  { folder: 'SpongieCharacterCustomisation', source: 'workshop', workshopId: '3415451174',
    ids: ['SpnCharCustom', 'SPNCC'], preferredId: 'SPNCC' },

  // Local-only: no Workshop item ships this folder at all.
  { folder: 'HandmadeThing', source: 'local', workshopId: null, ids: ['HandmadeThing'], preferredId: 'HandmadeThing' },
]

// --- the live bug. Both ids load fine server-side, so the boot-log check sees nothing; both are
// unobtainable by clients, which is what actually blocked the join.
let a = analyzeModDrift({
  enabled: ['Bandits', '76chevyKserieseExpanded', 'MarzGuns'],
  inventory: INVENTORY,
})
assert.deepStrictEqual(a.ok, ['Bandits'])
assert.deepStrictEqual(a.issues.map(i => [i.id, i.kind, i.suggest[0]]), [
  ['76chevyKserieseExpanded', 'clientBlocked', '76chevyKseriesExpanded'],
  ['MarzGuns', 'clientBlocked', 'GunsOfMarz'],
])
assert.strictEqual(a.issues[1].workshopId, '3722134990')

// --- the id is matched by FOLDER, not by name similarity: MarzGuns and GunsOfMarz share no
// substring, and the typo pair differs by one letter. Only the folder links them.
assert.strictEqual(a.issues[1].folder, 'GunsOfMarz')

// --- an id the Workshop publishes only in an older version folder is still fine: the client
// downloads the item, and `ids` covers every folder in it.
assert.deepStrictEqual(
  analyzeModDrift({ enabled: ['SpnCharCustom'], inventory: INVENTORY }).issues, [])

// --- a mod that exists nowhere is an orphan, not a drift, and gets no rename target.
let orphan = analyzeModDrift({ enabled: ['NoSuchMod'], inventory: INVENTORY }).issues[0]
assert.strictEqual(orphan.kind, 'orphan')
assert.deepStrictEqual(orphan.suggest, [])

// --- a local-only mod cannot be renamed into existence; clients can never obtain it.
let lonely = analyzeModDrift({ enabled: ['HandmadeThing'], inventory: INVENTORY }).issues[0]
assert.strictEqual(lonely.kind, 'localOnly')
assert.deepStrictEqual(lonely.suggest, [])

// --- repair renames in place: same length, same position, load order untouched.
const MODS = ['Bandits', '76chevyKserieseExpanded', 'MarzGuns', 'CVI']
a = analyzeModDrift({ enabled: MODS, inventory: INVENTORY })
let p = planRepair(a, MODS, [{ from: '76chevyKserieseExpanded', to: '76chevyKseriesExpanded' }])
assert.deepStrictEqual(p.mods, ['Bandits', '76chevyKseriesExpanded', 'MarzGuns', 'CVI'])
assert.deepStrictEqual(p.applied, [{ from: '76chevyKserieseExpanded', to: '76chevyKseriesExpanded', position: 1 }])
assert.strictEqual(p.mods.length, MODS.length, 'repair must never change the mod count')

// --- a caller may not invent a target, rename something that was not reported, or smuggle in a
// removal. These are the edits that lose items, so they are refused, not sanitised.
for (const bad of [
  { from: '76chevyKserieseExpanded', to: 'SomethingElse' },
  { from: 'Bandits', to: 'GunsOfMarz' },
  { from: 'NotEnabledAtAll', to: 'GunsOfMarz' },
]) {
  const r = planRepair(a, MODS, [bad])
  assert.deepStrictEqual(r.applied, [], 'must refuse ' + JSON.stringify(bad))
  assert.strictEqual(r.rejected.length, 1)
  assert.deepStrictEqual(r.mods, MODS)
}

// --- an orphan has no target, so repairing it is refused rather than silently dropping the entry.
assert.strictEqual(planRepair(
  analyzeModDrift({ enabled: ['NoSuchMod'], inventory: INVENTORY }),
  ['NoSuchMod'], [{ from: 'NoSuchMod', to: 'anything' }]).applied.length, 0)

// --- renaming onto an id that is already enabled would load the mod twice; refused.
const DUP = ['MarzGuns', 'GunsOfMarz']
assert.strictEqual(planRepair(
  analyzeModDrift({ enabled: DUP, inventory: INVENTORY }),
  DUP, [{ from: 'MarzGuns', to: 'GunsOfMarz' }]).rejected[0].reason, 'GunsOfMarz is already enabled')

// --- two Workshop items shipping a folder of the same name is ambiguous; never guess.
const AMBIG = [
  { folder: 'Dupe', source: 'local', workshopId: null, ids: ['OldId'], preferredId: 'OldId' },
  { folder: 'Dupe', source: 'workshop', workshopId: '111', ids: ['NewA'], preferredId: 'NewA' },
  { folder: 'Dupe', source: 'workshop', workshopId: '222', ids: ['NewB'], preferredId: 'NewB' },
]
const amb = analyzeModDrift({ enabled: ['OldId'], inventory: AMBIG })
assert.deepStrictEqual(amb.issues[0].suggest.sort(), ['NewA', 'NewB'])
assert.match(planRepair(amb, ['OldId'], [{ from: 'OldId', to: 'NewA' }]).rejected[0].reason, /ambiguous/)

console.log('moddrift: all assertions passed')
