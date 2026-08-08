// Run: node test_ready.js
const assert = require('assert')
const { readyCheck, formatWait } = require('./ready')

const MARKER = 'LOG  : Network      f:0 st:614,688,031> *** SERVER STARTED ****'
const started = '2026-08-05T15:48:11.81686724Z'
const startedMs = Date.parse(started)

// --- the bug: a restart was issued, the container has not come back, and the log still holds the
// previous run's marker. Announcing here is what produced "ready after 153m 8s" 11s into a restart.
assert.deepStrictEqual(
  readyCheck({
    startedAt: '2026-08-05T13:00:00Z',              // still the run being replaced
    readyMinStart: Date.parse('2026-08-05T15:48:00Z'),
    markerLine: '2026-08-05T13:03:00.000000000Z ' + MARKER,
  }),
  { wait: 'container has not come back up yet' }
)

// --- once docker reports the new run, the marker counts and the wait is measured to the moment it
// was printed rather than to whenever the 20s poll noticed.
let r = readyCheck({
  startedAt: started,
  readyMinStart: Date.parse('2026-08-05T15:48:00Z'),
  markerLine: '2026-08-05T15:51:13.371671685Z ' + MARKER,
  now: startedMs + 900 * 1000,                       // poll lands 15 minutes late; irrelevant
})
assert.strictEqual(r.ready, true)
assert.strictEqual(r.seconds, 182)
assert.strictEqual(r.took, '3m 2s')

// --- a container that was already up when we started watching (crash monitor) has no floor.
r = readyCheck({
  startedAt: started,
  readyMinStart: 0,
  markerLine: '2026-08-05T15:48:41.000000000Z ' + MARKER,
})
assert.deepStrictEqual([r.ready, r.took], [true, '29s'])

// --- no marker yet is the normal case on most polls, and must not fire.
assert.deepStrictEqual(
  readyCheck({ startedAt: started, readyMinStart: 0, markerLine: '' }),
  { wait: 'no ready marker yet' }
)
assert.deepStrictEqual(readyCheck({ startedAt: '', readyMinStart: 0 }), { wait: 'no container start time' })
assert.deepStrictEqual(readyCheck(), { wait: 'no container start time' })

// --- an untimestamped or junk marker line still reports, timed to now rather than not at all.
r = readyCheck({ startedAt: started, readyMinStart: 0, markerLine: MARKER, now: startedMs + 60000 })
assert.deepStrictEqual([r.ready, r.took], [true, '1m 0s'])

// --- clock skew must not produce a negative wait.
r = readyCheck({
  startedAt: started, readyMinStart: 0,
  markerLine: '2026-08-05T15:48:00.000000000Z ' + MARKER,
})
assert.strictEqual(r.seconds, 0)

assert.strictEqual(formatWait(59), '59s')
assert.strictEqual(formatWait(60), '1m 0s')
assert.strictEqual(formatWait(3601), '60m 1s')

console.log('ready: all assertions passed')
