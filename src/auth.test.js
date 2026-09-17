// Run: node --test src/
const assert = require('assert')
const { parseCookies, sessionValid, newSession, macFor, safeEqual, SESSION_MAX_AGE_MS } = require('./auth')

const TOKEN = 'a-test-token-that-is-long-enough'
const NOW = 1_700_000_000_000

// --- a session this server issued is accepted ---
assert.strictEqual(sessionValid(TOKEN, newSession(TOKEN, NOW), NOW), true)
assert.strictEqual(sessionValid(TOKEN, newSession(TOKEN, NOW), NOW + 60_000), true)

// --- and nothing else is ---
assert.strictEqual(sessionValid(TOKEN, '', NOW), false)
assert.strictEqual(sessionValid(TOKEN, 'garbage', NOW), false)
assert.strictEqual(sessionValid(TOKEN, NOW + '.', NOW), false)
assert.strictEqual(sessionValid(TOKEN, NOW + '.' + 'f'.repeat(64), NOW), false)
// A MAC minted with a different token must not validate — this is the whole point.
assert.strictEqual(sessionValid(TOKEN, newSession('other-token', NOW), NOW), false)
// The issue time is inside the MAC, so it cannot be moved to extend a session.
assert.strictEqual(sessionValid(TOKEN, (NOW + 1) + '.' + macFor(TOKEN, NOW), NOW), false)

// --- expiry ---
assert.strictEqual(sessionValid(TOKEN, newSession(TOKEN, NOW), NOW + SESSION_MAX_AGE_MS - 1), true)
assert.strictEqual(sessionValid(TOKEN, newSession(TOKEN, NOW), NOW + SESSION_MAX_AGE_MS + 1), false)
// A cookie issued in the future is a clock that went backwards, not an eternal session.
assert.strictEqual(sessionValid(TOKEN, newSession(TOKEN, NOW + 600_000), NOW), false)

// --- safeEqual behaves like === for the cases that matter, including length mismatch ---
assert.strictEqual(safeEqual('abc', 'abc'), true)
assert.strictEqual(safeEqual('abc', 'abd'), false)
assert.strictEqual(safeEqual('abc', 'abcd'), false)
assert.strictEqual(safeEqual('', ''), true)

// --- cookie parsing: the shapes a browser actually sends ---
assert.deepStrictEqual(parseCookies('pzmgr=abc'), { pzmgr: 'abc' })
assert.deepStrictEqual(parseCookies('a=1; pzmgr=abc; b=2'), { a: '1', pzmgr: 'abc', b: '2' })
assert.deepStrictEqual(parseCookies(''), {})
assert.deepStrictEqual(parseCookies(undefined), {})
// A value containing '=' (base64 padding) must survive; only the first '=' separates.
assert.deepStrictEqual(parseCookies('pzmgr=ab=='), { pzmgr: 'ab==' })

console.log('auth: all assertions passed')
