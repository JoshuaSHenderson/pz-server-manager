// Run: node test_save.js
const assert = require('assert')
const { saveThenGoDown, SAVE_SETTLE_MS } = require('./save')

const run = (rcon) => {
  const logs = []
  const waits = []
  let downs = 0
  saveThenGoDown({
    rcon,
    wait: (ms, cb) => { waits.push(ms); cb() },
    log: (m) => logs.push(m),
  }, () => downs++)
  return { logs, waits, downs }
}

// --- the happy path: save first, then wait out the write window, then go down.
let r = run((cmd, cb) => { assert.strictEqual(cmd, 'save'); cb(null, 'World saved.') })
assert.deepStrictEqual(r.waits, [SAVE_SETTLE_MS])
assert.strictEqual(r.downs, 1)
assert.deepStrictEqual(r.logs, ['world saved: World saved.'])

// --- the rule that matters most: RCON being down must not strand the server. It still goes
// down, and it goes down immediately — there is nothing to wait for.
r = run((cmd, cb) => cb(new Error('RCON not configured')))
assert.strictEqual(r.downs, 1)
assert.deepStrictEqual(r.waits, [])
assert.deepStrictEqual(r.logs, ['pre-shutdown save skipped: RCON not configured'])

r = run((cmd, cb) => cb(new Error('RCON timeout')))
assert.strictEqual(r.downs, 1)
assert.deepStrictEqual(r.waits, [])

// --- a server mid-boot answers nothing useful; that is a save we did not get, not a reason to stay up.
r = run((cmd, cb) => cb(null, ''))
assert.strictEqual(r.downs, 1)
assert.deepStrictEqual(r.logs, ['world saved'])

// --- an RCON client that calls back twice must not restart the server twice.
r = run((cmd, cb) => { cb(null, 'World saved.'); cb(new Error('late error')) })
assert.strictEqual(r.downs, 1)

// --- and neither must one that answers after the settle has already fired.
let late
r = run((cmd, cb) => { late = cb; cb(null, 'ok') })
late(new Error('way late'))
assert.strictEqual(r.downs, 1)

console.log('save: all assertions passed')
