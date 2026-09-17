// Pushover notifications, and the configuration behind them.
//
// Configuration is global rather than per-server: one Pushover account fronts the whole box, and
// the per-server part is only the label each message is tagged with.
//
// Credentials come from the environment. Two live ones were previously hardcoded here with
// enabled:true, so a fresh deploy immediately pushed to whoever owned them.

const https = require('https')
const querystring = require('querystring')
const { readJson, writeJson } = require('../util/fsx')
const registry = require('../registry/servers')
const { logFor } = require('../log')

/** @typedef {import('../paths').Server} Server */

// Notifications config stays global (one Pushover account for the whole box)
const NOTIF_PATH = '/pz-data/notifications.json'




// --- Notification helpers ---
// Credentials come from the environment, never from this file. The two that used to sit here were
// a live Pushover app token and user key, committed and pushed — so they are also in git history
// and must be rotated at Pushover, not merely moved.
//
// `enabled` now follows the credentials: shipping enabled:true with a default token meant any
// fresh deploy immediately pushed to whoever owned it.
const DEFAULT_NOTIF = {
  enabled: !!(process.env.PUSHOVER_TOKEN && process.env.PUSHOVER_USER_KEY),
  token: process.env.PUSHOVER_TOKEN || '',
  userKey: process.env.PUSHOVER_USER_KEY || '',
  events: {
    serverStart: true,
    serverStop: true,
    serverCrash: true,
    lowDisk: true,
    downloadComplete: true,
    playerJoin: true,
    playerLeave: false,
    playerDied: true,
    playerKicked: true
  },
  lowDiskThresholdGB: 5,
  discord: {
    enabled: false,
    webhookUrl: '',
    messageId: '',
    richCard: false,
    template: 'Project Zomboid Server: <ZomboidServerStats> | Last updated: <LastUpdated>'
  }
}

function readNotifConfig() {
  try {
    const saved = readJson(NOTIF_PATH, null)
    if (!saved) throw new Error('no saved config')
    const merged = Object.assign({}, DEFAULT_NOTIF, saved, {
      events: Object.assign({}, DEFAULT_NOTIF.events, saved.events || {}),
      discord: Object.assign({}, DEFAULT_NOTIF.discord, saved.discord || {})
    })
    // A saved blank must not shadow a credential supplied by the environment: a config file
    // written before PUSHOVER_TOKEN was set carries token:'' and would otherwise silently disable
    // notifications that are correctly configured in docker-compose.
    if (!merged.token) merged.token = DEFAULT_NOTIF.token
    if (!merged.userKey) merged.userKey = DEFAULT_NOTIF.userKey
    return merged
  } catch { return Object.assign({}, DEFAULT_NOTIF) }
}

// The config minus the secrets. The UI needs to know whether credentials are set, never what they
// are — and this response used to carry a live Pushover token and user key to any caller.
function publicNotifConfig() {
  const cfg = readNotifConfig()
  const { token, userKey, ...rest } = cfg
  return Object.assign(rest, {
    tokenSet: !!token,
    userKeySet: !!userKey,
    discord: Object.assign({}, cfg.discord, {
      webhookUrl: undefined,
      webhookUrlSet: !!(cfg.discord && cfg.discord.webhookUrl)
    })
  })
}
function writeNotifConfig(cfg) {
  writeJson(NOTIF_PATH, cfg)
}
// Operator-visible activity log. Anything this manager does that changes state gets a line, so
// the Manager Logs pane answers "what did it just do?" without anyone reading the source.
// Docker adds the timestamps (the log stream is requested with --timestamps), so none here.


function pushover(title, message) {
  const cfg = readNotifConfig()
  if (!cfg.enabled || !cfg.token || !cfg.userKey) return
  const data = querystring.stringify({ token: cfg.token, user: cfg.userKey, title, message })
  const req = https.request({
    hostname: 'api.pushover.net', path: '/1/messages.json', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
  }, r => r.resume())
  req.on('error', () => {})
  req.write(data); req.end()
}
// Server-tagged notification, e.g. "[DAS HOMIES] PZ Server Started".
// Uses serverLabel(), not s.name: s.name is whatever SEED_SERVERS/discovery last labelled the
// container ("Build 41" for a container that now runs B42), so notifications used to carry a
// stale hardcoded name. serverLabel() resolves the user's override, then the server's live
// PublicName, and only falls back to s.name / the container name.
function pushoverFor(s, title, message) {
  logFor(s, 'notify: ' + title + ' - ' + message)
  pushover('[' + registry.serverLabel(s) + '] ' + title, message)
}

// Workshop URLs for the collections this server tracks. Used in the Discord status so players can

/**
 * Accepts only the Discord keys this manager knows about, and only at the right types. A blank
 * webhook keeps the saved one, for the same reason a blank token does: the UI never round-trips a
 * secret through the browser, so "unchanged" has to be expressible.
 *
 * @param {any} incoming
 * @param {any} cur
 */
function sanitizeDiscord(incoming, cur) {
  const d = incoming || {}
  /** @type {Record<string, any>} */
  const out = {}
  if (typeof d.enabled === 'boolean') out.enabled = d.enabled
  if (typeof d.richCard === 'boolean') out.richCard = d.richCard
  if (typeof d.template === 'string') out.template = d.template
  if (typeof d.iconUrl === 'string') out.iconUrl = d.iconUrl
  if (typeof d.messageId === 'string') out.messageId = d.messageId
  if (typeof d.webhookUrl === 'string' && d.webhookUrl) out.webhookUrl = d.webhookUrl
  else out.webhookUrl = cur.webhookUrl
  return out
}

module.exports = {
  readNotifConfig, writeNotifConfig, publicNotifConfig, sanitizeDiscord,
  pushover, pushoverFor, DEFAULT_NOTIF, NOTIF_PATH,
}
