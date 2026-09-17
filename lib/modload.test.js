// Run: node test_modload.js
const assert = require('assert')
const { reconcileMods, loadedModIds } = require('./modload')

// Real lines, copied from 2026-09-12_02-10_DebugLog-server.txt.
const LOG = [
  '[12-09-26 02:12:44.196] LOG  : Mod          f:0 st:454,756,414> loading GanydeBielovzki\'s Frockin Splendor!.',
  '[12-09-26 02:12:44.236] LOG  : Mod          f:0 st:454,756,453> loading GanydeBielovzki\'s Frockin Splendor! Vol.2.',
  '[12-09-26 02:12:47.953] LOG  : Mod          f:0 st:454,760,170> loading CVI.',
  '[12-09-26 02:12:47.955] LOG  : Mod          f:0 st:454,760,172> mod "CVI" overrides media/fileguidtable.xml.',
  '[12-09-26 02:12:44.182] WARN : Mod          f:0 st:454,756,399 at ZomboidFileSystem.loadModAndRequired> required mod "SpnCharCustom" not found.',
  '[12-09-26 02:12:48.100] LOG  : Mod          f:0 st:454,760,300> loading HBVCEFb42.',
].join('\n')

// --- ids with spaces, apostrophes, "!" and an embedded "." (Vol.2) all survive; the "overrides"
// and "not found" lines are not load events and must not be mistaken for them.
assert.deepStrictEqual(loadedModIds(LOG), new Set([
  "GanydeBielovzki's Frockin Splendor!",
  "GanydeBielovzki's Frockin Splendor! Vol.2",
  'CVI',
  'HBVCEFb42',
]))

// --- the live bug. SpnCharCustom is a real id in 42.0/mod.info, so every disk check passes it,
// but the running build loads 42.13 which renamed it to SPNCC. Only the log shows it dead.
let r = reconcileMods(["GanydeBielovzki's Frockin Splendor!", 'CVI', 'SpnCharCustom'], LOG)
assert.strictEqual(r.known, true)
assert.deepStrictEqual(r.dead, ['SpnCharCustom'])

// --- a dependency the game pulled in itself is reported separately, never as a problem.
assert.deepStrictEqual(r.extra.sort(), ["GanydeBielovzki's Frockin Splendor! Vol.2", 'HBVCEFb42'])

// --- the alert this must never fire: an empty or truncated grep is no information, not 171 dead
// mods. known:false keeps the caller quiet.
for (const empty of ['', null, undefined, 'LOG  : General  f:0> nothing to do here']) {
  const q = reconcileMods(['CVI', 'SpnCharCustom'], empty)
  assert.strictEqual(q.known, false, 'empty log must not accuse')
  assert.deepStrictEqual(q.dead, [])
}

// --- a clean server: everything enabled loaded, nothing to say.
assert.deepStrictEqual(reconcileMods(['CVI'], LOG).dead, [])

// --- duplicates and stray whitespace in Mods= are not two findings.
assert.deepStrictEqual(reconcileMods([' SpnCharCustom ', 'SpnCharCustom', ''], LOG).dead, ['SpnCharCustom'])

// --- the other shape of the same event. docker logs carries no "[stamp]" and no trailing period;
// reportDeadMods reads exactly this, and a regex tuned to the file form matches none of it.
// Real lines, copied from `docker logs zomboid`.
const STDOUT_LOG = [
  "LOG  : Mod          f:0 st:907,558,156> loading GanydeBielovzki's Frockin Splendor!",
  "LOG  : Mod          f:0 st:907,558,176> loading GanydeBielovzki's Frockin Splendor! Vol.2",
  'LOG  : Mod          f:0 st:907,558,200> loading CVI',
].join('\n')

assert.deepStrictEqual(loadedModIds(STDOUT_LOG), new Set([
  "GanydeBielovzki's Frockin Splendor!",
  "GanydeBielovzki's Frockin Splendor! Vol.2",
  'CVI',
]))

// --- both shapes must yield the same ids, or the check depends on which log it was handed.
const fromFile = loadedModIds(LOG)
for (const id of loadedModIds(STDOUT_LOG)) assert.ok(fromFile.has(id), 'shape mismatch: ' + id)

// --- an id ending in a digit-dot ("Vol.2") keeps its dot in both shapes; only a *trailing*
// sentence period is stripped.
assert.ok(loadedModIds('LOG  : Mod  f:0> loading Some Mod Vol.2.').has('Some Mod Vol.2'))
assert.ok(loadedModIds('LOG  : Mod  f:0> loading Some Mod Vol.2').has('Some Mod Vol.2'))

console.log('modload: all assertions passed')
