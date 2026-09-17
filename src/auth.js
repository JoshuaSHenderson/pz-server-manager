// Authentication for the whole manager.
//
// Until this existed, every endpoint was open: anything that could reach the published port could
// stop containers, rewrite servertest.ini, extract an uploaded archive over the data dir, delete
// mod folders and edit the whitelist DB. There was no token, no session, no check of any kind.
//
// One shared secret, because there is one operator. Two ways to present it:
//
//   X-Manager-Token: <token>     scripts and curl
//   Cookie: pzmgr=<iat>.<mac>    the browser, set by POST /api/login
//
// The cookie is required for EventSource: the log panes stream over SSE and the browser's
// EventSource cannot set request headers, so header-only auth would have left the two log views
// permanently broken. The cookie carries no secret — only an issue time and an HMAC of it keyed by
// the token — so a stolen cookie cannot be replayed anywhere else, and it expires on its own.
//
// ponytail: one shared token, no user accounts. Per-user logins matter when you need to know which
// operator did what; add them then, and the audit log is the reason, not the auth.

const crypto = require('crypto')
const fs = require('fs')

const COOKIE = 'pzmgr'
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// Where a generated token is kept so it survives a restart of this container. Alongside
// notifications.json, on the same volume, for the same reason: /pz-data is the only path here that
// outlives the container.
const TOKEN_PATH = '/pz-data/manager-token'

// Every path served before a caller is known. The SPA shell has to load so it can show the login
// form, and the login endpoint itself obviously cannot require a session.
const PUBLIC_PATHS = new Set(['/api/login', '/api/auth'])

/**
 * The token this manager will accept.
 *
 * MANAGER_TOKEN wins, so an operator can pin it in docker-compose and know it ahead of time.
 * Failing that, a generated one is persisted and reused; only a first run on a fresh volume mints
 * a new one. Regenerating on every boot would invalidate every session on every restart, and this
 * container restarts whenever the image is rebuilt.
 *
 * @returns {{ token: string, source: 'env'|'file'|'generated' }}
 */
function resolveToken() {
  const fromEnv = (process.env.MANAGER_TOKEN || '').trim()
  if (fromEnv) return { token: fromEnv, source: 'env' }

  try {
    const saved = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
    if (saved) return { token: saved, source: 'file' }
  } catch {}

  const token = crypto.randomBytes(24).toString('base64url')
  try {
    fs.writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 })
  } catch (e) {
    // A read-only or unmounted /pz-data means the token cannot be persisted. Still usable — it is
    // printed at startup — but it changes on every restart, so say so rather than failing to boot.
    console.error('[auth] could not persist the manager token to ' + TOKEN_PATH + ': ' + e.message)
    console.error('[auth] it will change on every restart until MANAGER_TOKEN is set or that path is writable')
  }
  return { token, source: 'generated' }
}

/** @param {string} token @param {string|number} iat */
function macFor(token, iat) {
  return crypto.createHmac('sha256', token).update('session:' + iat).digest('hex')
}

/**
 * Constant-time string compare. A plain `===` on a MAC leaks how much of it matched through
 * timing, which is the whole reason timingSafeEqual exists.
 * @param {string} a @param {string} b
 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  // timingSafeEqual throws on a length mismatch, which is itself a (harmless) length oracle.
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

/** @param {string|undefined} header @returns {Record<string,string>} */
function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/** @param {string} token @param {string} value @param {number} now */
function sessionValid(token, value, now) {
  const [iat, mac] = String(value || '').split('.')
  if (!iat || !mac) return false
  const issued = Number(iat)
  if (!Number.isFinite(issued)) return false
  if (now - issued > SESSION_MAX_AGE_MS) return false
  // A clock that has gone backwards must not mint eternal sessions either.
  if (issued - now > 60 * 1000) return false
  return safeEqual(mac, macFor(token, iat))
}

/** @param {string} token @param {number} now */
function newSession(token, now) {
  return now + '.' + macFor(token, now)
}

/**
 * Wires up authentication. Returns the token so the caller can print it at startup — the operator
 * reads it out of `docker logs` on a first run.
 *
 * @param {import('express').Express} app
 * @param {{ now?: () => number }} [opts]
 */
function install(app, opts) {
  const now = (opts && opts.now) || Date.now
  const { token, source } = resolveToken()

  const secureCookie = String(process.env.MANAGER_COOKIE_SECURE || '').toLowerCase() === 'true'
  const cookieAttrs = [
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=' + Math.floor(SESSION_MAX_AGE_MS / 1000)
  ]
  // Off by default: this is served over plain HTTP on a LAN, and a Secure cookie would simply
  // never be stored, locking the operator out of their own manager with no error worth reading.
  if (secureCookie) cookieAttrs.push('Secure')

  /** @param {import('express').Request} req */
  const authed = req => {
    const presented = req.headers['x-manager-token']
    if (typeof presented === 'string' && presented && safeEqual(presented, token)) return true
    const cookie = parseCookies(req.headers.cookie)[COOKIE]
    return !!cookie && sessionValid(token, cookie, now())
  }

  // Exchange the token for a session cookie.
  app.post('/api/login', (req, res) => {
    const presented = (req.body && req.body.token) || ''
    if (typeof presented !== 'string' || !presented || !safeEqual(presented, token)) {
      // Deliberately vague, and deliberately slow enough that guessing over a network is hopeless
      // against a 192-bit secret without needing a rate limiter to say so.
      return setTimeout(() => res.status(401).json({ error: 'Invalid token' }), 400)
    }
    res.setHeader('Set-Cookie', COOKIE + '=' + newSession(token, now()) + '; ' + cookieAttrs.join('; '))
    res.json({ success: true })
  })

  app.post('/api/logout', (req, res) => {
    res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0')
    res.json({ success: true })
  })

  // Lets the SPA decide between the login form and the app without first firing a request that
  // fails. Says nothing a caller could not learn by trying.
  app.get('/api/auth', (req, res) => res.json({ authenticated: authed(req) }))

  app.use((req, res, next) => {
    if (PUBLIC_PATHS.has(req.path)) return next()
    if (authed(req)) return next()
    // JSON for the API, so the SPA's fetch wrapper can react; the SPA shell itself is static and
    // is served before this middleware runs.
    res.status(401).json({ error: 'UNAUTHENTICATED', detail: 'Present X-Manager-Token, or POST /api/login to start a session.' })
  })

  return { token, source }
}

module.exports = { install, resolveToken, parseCookies, sessionValid, newSession, macFor, safeEqual, SESSION_MAX_AGE_MS, COOKIE }
