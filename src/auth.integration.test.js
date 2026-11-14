// Run: node --test src/
//
// The unit test covers the session crypto. This covers the wiring, which is where the actual
// security property lives: that a route registered after install() is unreachable without a token,
// by either presentation, and that the login exchange works end to end.
const assert = require('assert')
const express = require('express')
const auth = require('./auth')

process.env.MANAGER_TOKEN = 'integration-test-token-0123456789'

const app = express()
app.use(express.json())
// Stands in for the SPA shell: registered before install(), so it must stay public.
app.get('/', (_req, res) => res.send('shell'))
const { token, source } = auth.install(app)
// Stands in for every /api route, all of which are registered after install().
app.get('/api/secret', (_req, res) => res.json({ ok: true }))

assert.strictEqual(source, 'env')
assert.strictEqual(token, 'integration-test-token-0123456789')

const server = app.listen(0)
const base = () => 'http://127.0.0.1:' + /** @type {import('net').AddressInfo} */ (server.address()).port

async function main() {
  // The shell loads without credentials, or there would be nowhere to type them.
  assert.strictEqual((await fetch(base() + '/')).status, 200)

  // A protected route does not.
  const anon = await fetch(base() + '/api/secret')
  assert.strictEqual(anon.status, 401)
  assert.strictEqual(/** @type {any} */ (await anon.json()).error, 'UNAUTHENTICATED')

  // A wrong token does not either.
  assert.strictEqual((await fetch(base() + '/api/secret', { headers: { 'X-Manager-Token': 'nope' } })).status, 401)
  // Nor does a token that is merely a prefix of the real one.
  assert.strictEqual((await fetch(base() + '/api/secret', { headers: { 'X-Manager-Token': token.slice(0, -1) } })).status, 401)

  // The header works, for curl and scripts.
  const viaHeader = await fetch(base() + '/api/secret', { headers: { 'X-Manager-Token': token } })
  assert.strictEqual(viaHeader.status, 200)
  assert.deepStrictEqual(await viaHeader.json(), { ok: true })

  // A bad login is refused and sets no cookie.
  const badLogin = await fetch(base() + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' })
  })
  assert.strictEqual(badLogin.status, 401)
  assert.strictEqual(badLogin.headers.get('set-cookie'), null)

  // A good login issues a session cookie, hardened the way a session cookie should be.
  const login = await fetch(base() + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token })
  })
  assert.strictEqual(login.status, 200)
  const setCookie = login.headers.get('set-cookie')
  assert.ok(setCookie, 'login must set a cookie')
  assert.match(setCookie, /^pzmgr=/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  // The cookie must not be the token itself — that is the point of signing an issue time instead.
  assert.ok(!setCookie.includes(token), 'the cookie must not carry the token')

  // And that cookie authenticates, which is what makes the SSE log panes work at all.
  const cookie = setCookie.split(';')[0]
  const viaCookie = await fetch(base() + '/api/secret', { headers: { Cookie: cookie } })
  assert.strictEqual(viaCookie.status, 200)

  // A tampered cookie does not.
  const tampered = cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a')
  assert.strictEqual((await fetch(base() + '/api/secret', { headers: { Cookie: tampered } })).status, 401)

  // /api/auth is reachable either way, so the SPA can choose between the login form and the app.
  assert.deepStrictEqual(await (await fetch(base() + '/api/auth')).json(), { authenticated: false })
  assert.deepStrictEqual(await (await fetch(base() + '/api/auth', { headers: { Cookie: cookie } })).json(), { authenticated: true })

  console.log('auth wiring: all assertions passed')
}

main().then(() => server.close(), e => { server.close(); throw e })
