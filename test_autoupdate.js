// Run: node test_autoupdate.js
const assert = require('assert')
const { outdatedItems, seedState, dueForCheck, shouldRestart } = require('./autoupdate')

// --- outdatedItems ---
// The rule that stops enabling the feature from re-downloading every installed mod: an id we have
// never seen is seeded, not reported.
assert.deepStrictEqual(outdatedItems({}, { a: 100, b: 200 }), [])
assert.deepStrictEqual(outdatedItems(undefined, { a: 100 }), [])

// A later stamp is an update; an equal or older one is not.
assert.deepStrictEqual(outdatedItems({ a: 100 }, { a: 150 }), ['a'])
assert.deepStrictEqual(outdatedItems({ a: 100 }, { a: 100 }), [])
assert.deepStrictEqual(outdatedItems({ a: 100 }, { a: 50 }), [])

// Mixed: only the changed one, and a newly-seen id stays quiet.
assert.deepStrictEqual(outdatedItems({ a: 100, b: 200 }, { a: 100, b: 250, c: 300 }), ['b'])

// Steam returning 0/undefined for an item must never look like an update.
assert.deepStrictEqual(outdatedItems({ a: 100 }, { a: 0 }), [])
assert.deepStrictEqual(outdatedItems({ a: 100 }, {}), [])
assert.deepStrictEqual(outdatedItems({}, {}), [])

// --- seedState ---
assert.deepStrictEqual(seedState({}, { a: 1, b: 2 }), { a: 1, b: 2 })
assert.deepStrictEqual(seedState({ a: 1 }, { a: 5 }), { a: 5 })
// Zero stamps are ignored rather than overwriting a good one with nothing.
assert.deepStrictEqual(seedState({ a: 1 }, { a: 0 }), { a: 1 })
// Ids Steam did not answer for are retained.
assert.deepStrictEqual(seedState({ a: 1, b: 2 }, { a: 9 }), { a: 9, b: 2 })

// --- dueForCheck ---
const now = Date.now()
const HOUR = 3600000
assert.strictEqual(dueForCheck(now, null, HOUR), true)
assert.strictEqual(dueForCheck(now, new Date(now - 2 * HOUR).toISOString(), HOUR), true)
assert.strictEqual(dueForCheck(now, new Date(now - 10000).toISOString(), HOUR), false)

// --- shouldRestart: the safety rules ---
const base = { enabled: true, restartWhenEmpty: true, pending: ['a'], activeDownloads: 0, playersOnline: 0 }
assert.strictEqual(shouldRestart(base).restart, true)

// Every one of these must block a restart.
assert.strictEqual(shouldRestart(Object.assign({}, base, { enabled: false })).restart, false)
assert.strictEqual(shouldRestart(Object.assign({}, base, { restartWhenEmpty: false })).restart, false)
assert.strictEqual(shouldRestart(Object.assign({}, base, { pending: [] })).restart, false)
assert.strictEqual(shouldRestart(Object.assign({}, base, { activeDownloads: 2 })).restart, false)
assert.strictEqual(shouldRestart(Object.assign({}, base, { playersOnline: 1 })).restart, false)

// The one that matters most: an unknown player count must never be read as "empty".
assert.strictEqual(shouldRestart(Object.assign({}, base, { playersOnline: null })).restart, false)
assert.strictEqual(shouldRestart(Object.assign({}, base, { playersOnline: undefined })).restart, false)
assert.match(shouldRestart(Object.assign({}, base, { playersOnline: null })).reason, /unknown/)

// Reasons are reported so the UI and log can say why nothing happened.
assert.match(shouldRestart(Object.assign({}, base, { playersOnline: 3 })).reason, /3 player\(s\) online/)
assert.match(shouldRestart(Object.assign({}, base, { activeDownloads: 1 })).reason, /downloads still running/)

// Empty input must not throw.
assert.strictEqual(shouldRestart().restart, false)
assert.strictEqual(shouldRestart({}).restart, false)

console.log('autoupdate: all assertions passed')
