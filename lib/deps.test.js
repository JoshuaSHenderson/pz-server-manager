// Run: node test_deps.js
const assert = require('assert')
const { parseDepList, analyzeDependencies, sortIssues } = require('./deps')

// --- parseDepList: the real shapes seen in mod.info on the server ---
assert.deepStrictEqual(parseDepList('tsarslib,amclub'), ['tsarslib', 'amclub'])
assert.deepStrictEqual(parseDepList('\\VanillaVehiclesAnimated,\\StandardizedVehicleUpgrades3V'),
  ['VanillaVehiclesAnimated', 'StandardizedVehicleUpgrades3V'])
assert.deepStrictEqual(parseDepList('\\ChuckleberryFinnAlertSystem,'), ['ChuckleberryFinnAlertSystem'])
assert.deepStrictEqual(parseDepList(''), [])
assert.deepStrictEqual(parseDepList(undefined), [])
assert.deepStrictEqual(parseDepList('  A ,, B  '), ['A', 'B'])

const meta = {
  Truck: { require: ['tsarslib'] },
  Radio: { require: ['MissingLib'] },
  AZLite: { incompatible: ['AZCurrent'] },
  Late: { loadModAfter: ['Early'] }
}

// Requirement satisfied by an enabled mod -> silence.
assert.deepStrictEqual(
  analyzeDependencies({ enabled: ['Truck', 'tsarslib'], installed: ['Truck', 'tsarslib'], meta }), [])

// Installed but not enabled -> 'disabled' (one-click fix), not 'missing'.
let r = analyzeDependencies({ enabled: ['Truck'], installed: ['Truck', 'tsarslib'], meta })
assert.strictEqual(r.length, 1)
assert.strictEqual(r[0].type, 'disabled')
assert.strictEqual(r[0].dependency, 'tsarslib')

// Not installed at all -> 'missing'.
r = analyzeDependencies({ enabled: ['Radio'], installed: ['Radio'], meta })
assert.strictEqual(r[0].type, 'missing')

// A mod that isn't loaded is not analysed — its needs are irrelevant.
assert.deepStrictEqual(analyzeDependencies({ enabled: [], installed: ['Radio'], meta }), [])

// Case-only differences are not treated as missing.
assert.deepStrictEqual(
  analyzeDependencies({ enabled: ['Truck', 'TSARSLIB'], installed: ['Truck', 'TSARSLIB'], meta }), [])

// Incompatible only fires when BOTH are enabled.
assert.deepStrictEqual(analyzeDependencies({ enabled: ['AZLite'], installed: ['AZLite', 'AZCurrent'], meta }), [])
r = analyzeDependencies({ enabled: ['AZLite', 'AZCurrent'], installed: ['AZLite', 'AZCurrent'], meta })
assert.strictEqual(r[0].type, 'incompatible')

// loadModAfter: correct order is silent, wrong order reports.
assert.deepStrictEqual(analyzeDependencies({ enabled: ['Early', 'Late'], installed: ['Early', 'Late'], meta }), [])
r = analyzeDependencies({ enabled: ['Late', 'Early'], installed: ['Late', 'Early'], meta })
assert.strictEqual(r[0].type, 'order')
assert.strictEqual(r[0].modIndex, 0)
assert.strictEqual(r[0].dependencyIndex, 1)

// Order is not reported when the other mod isn't loaded at all.
assert.deepStrictEqual(analyzeDependencies({ enabled: ['Late'], installed: ['Late'], meta }), [])

// Ignores suppress exactly one dependent>dependency pair and nothing else.
r = analyzeDependencies({ enabled: ['Radio'], installed: ['Radio'], meta, ignores: ['Radio>MissingLib'] })
assert.deepStrictEqual(r, [])
r = analyzeDependencies({ enabled: ['Radio'], installed: ['Radio'], meta, ignores: ['Other>MissingLib'] })
assert.strictEqual(r.length, 1)
// Ignores are matched case-insensitively, like ids everywhere else.
r = analyzeDependencies({ enabled: ['Radio'], installed: ['Radio'], meta, ignores: ['radio>missinglib'] })
assert.deepStrictEqual(r, [])

// A mod with no metadata at all must not throw.
assert.deepStrictEqual(analyzeDependencies({ enabled: ['Unknown'], installed: ['Unknown'], meta: {} }), [])
assert.deepStrictEqual(analyzeDependencies({}), [])

// Worst-first ordering.
const sorted = sortIssues([
  { type: 'order', modId: 'a' }, { type: 'missing', modId: 'b' },
  { type: 'incompatible', modId: 'c' }, { type: 'disabled', modId: 'd' }
]).map(function (i) { return i.type })
assert.deepStrictEqual(sorted, ['incompatible', 'missing', 'disabled', 'order'])

console.log('deps: all assertions passed')
