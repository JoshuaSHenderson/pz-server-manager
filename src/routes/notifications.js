// Pushover settings, the test notification, and the Discord status card.
//
// GET never returns a credential - only whether each one is set. They used to be served to any
// caller, and the UI has no reason to hold them.

const https = require('https')
const querystring = require('querystring')
const registry = require('../registry/servers')
const { srv, serverLabel } = registry
const { getIniValue } = require('../domain/ini')
const {
  readNotifConfig, writeNotifConfig, publicNotifConfig, sanitizeDiscord, DEFAULT_NOTIF,
} = require('../services/notify')
const { updateDiscordStatus } = require('../services/discord')
const { getExternalIp } = require('../infra/net')
const { getServerVersion } = require('../services/version')

const router = require('express').Router()

router.get('/api/notifications', (req, res) => {
  res.json(publicNotifConfig())
})

// Merged over what is already saved, not swapped for it: the previous version wrote req.body
// straight to disk, so a partial payload from any client silently erased the Discord settings and
// every event toggle it did not happen to mention.
//
// A blank secret means "leave it alone", which is what lets the UI render a
// "configured — leave blank to keep" field instead of round-tripping the token through the browser.
router.put('/api/notifications', (req, res) => {
  const body = req.body || {}
  if (typeof body.enabled !== 'boolean') return res.status(400).json({ error: 'Invalid config' })

  const cur = readNotifConfig()
  const cfg = Object.assign({}, cur, {
    enabled: body.enabled,
    token: typeof body.token === 'string' && body.token ? body.token : cur.token,
    userKey: typeof body.userKey === 'string' && body.userKey ? body.userKey : cur.userKey,
    lowDiskThresholdGB: Number.isFinite(body.lowDiskThresholdGB) ? body.lowDiskThresholdGB : cur.lowDiskThresholdGB,
    // Only keys this manager actually knows about, and only booleans. Stops an arbitrary blob
    // reaching the file, and stops a typo'd event name accumulating there forever.
    events: Object.fromEntries(Object.keys(DEFAULT_NOTIF.events).map(k => [
      k, typeof (body.events || {})[k] === 'boolean' ? body.events[k] : cur.events[k]
    ])),
    discord: Object.assign({}, cur.discord, sanitizeDiscord(body.discord, cur.discord))
  })
  writeNotifConfig(cfg)
  res.json({ success: true })
})

router.post('/api/notifications/test', (req, res) => {
  const cfg = readNotifConfig()
  if (!cfg.token || !cfg.userKey) return res.status(400).json({ error: 'No credentials configured' })
  // Title is built the same way real alerts are, so the test actually proves what a live
  // notification will say — including which server it came from.
  const label = serverLabel(srv(req))
  const data = querystring.stringify({
    token: cfg.token, user: cfg.userKey,
    title: '[' + label + '] PZ Server Manager',
    message: 'Test notification from PZ Server Manager for "' + label + '".'
  })
  const request = https.request({
    hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
  }, r => {
    let body = ''
    r.on('data', c => body += c)
    r.on('end', () => res.json({ success: r.statusCode === 200, status: r.statusCode, body }))
  })
  request.on('error', e => res.status(500).json({ error: e.message }))
  request.write(data); request.end()
})

router.post('/api/discord/update', (req, res) => {
  updateDiscordStatus((err, data) => res.json({ success: !err, data, error: err ? err.message : null }))
})

// What the Discord card will actually show for "connect" + version — surfaced in the UI
// so it's clear these are auto-detected, not manually entered.
router.get('/api/discord/detected', (req, res) => {
  const s = srv(req)
  getExternalIp(ip => {
    getServerVersion(s, version => {
      let port = ''
      try { port = getIniValue(s, 'DefaultPort', '') } catch {}
      res.json({ externalIp: ip, port, version })
    })
  })
})

module.exports = router
