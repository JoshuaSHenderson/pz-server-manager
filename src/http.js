// Small request/response helpers shared by every route.

/**
 * One query-string value as a string.
 *
 * Express parses `?name=a&name=b` into an array and `?name[x]=1` into an object, so any handler
 * that reached straight for `req.query.name` and called a string method on it threw a TypeError —
 * which, with no error handler installed, returned an HTML 500 that the UI's `.json()` rejected
 * into a dead spinner. `/api/backups/peek` and the upload endpoint both did exactly that.
 *
 * Arrays collapse to their first entry (what a user who double-submitted a form meant); anything
 * else becomes ''.
 *
 * @param {unknown} v
 * @returns {string}
 */
function qs(v) {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return qs(v[0])
  return ''
}

/**
 * One header value as a string. Node gives arrays for repeatable headers.
 * @param {import('express').Request} req
 * @param {string} name
 * @returns {string}
 */
function header(req, name) {
  const v = req.headers[name.toLowerCase()]
  return Array.isArray(v) ? String(v[0] || '') : String(v || '')
}

/**
 * Installs the last-resort error handler.
 *
 * Without it, a throw inside a synchronous handler produced Express's default HTML error page with
 * a stack trace in it, and the browser showed nothing at all because the SPA parses every response
 * as JSON. Registered after all routes — Express only treats a 4-argument middleware as an error
 * handler, and only reaches it for what was registered before.
 *
 * @param {import('express').Express} app
 */
function installErrorHandler(app) {
  app.use((/** @type {any} */ err, /** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ _next) => {
    console.error('[http] ' + req.method + ' ' + req.originalUrl + ' failed:', err && err.stack || err)
    if (res.headersSent) return res.end()
    // express.json() rejects a malformed body with a 400-flavoured error; everything else is ours.
    const status = err && (err.status || err.statusCode) || 500
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: (err && err.message) || 'Internal error'
    })
  })
}

/**
 * Keeps the process alive when something rejects with nobody listening.
 *
 * This matters more here than in an ordinary web app: the manager owns eleven interval-driven
 * monitors and a reinstall state machine that takes the game server down partway through. A crash
 * restarts the container, which resets `markAwaitingReady`'s floor and abandons any reinstall
 * mid-flight — with the container it was holding still stopped.
 */
function installProcessGuards() {
  process.on('unhandledRejection', reason => {
    console.error('[process] unhandled rejection:', reason instanceof Error ? reason.stack : reason)
  })
  process.on('uncaughtException', err => {
    console.error('[process] uncaught exception:', err && err.stack || err)
  })
}

module.exports = { qs, header, installErrorHandler, installProcessGuards }
