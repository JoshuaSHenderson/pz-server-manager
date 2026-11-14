// Which servers exist, what they are called, and which one a request is about.
//
// Three inputs, merged in refreshServers():
//   1. auto-discovery  - every PZ-image container whose data dir this manager can actually read
//   2. servers.json    - user overrides (rename / connect / hide / default), keyed by CONTAINER
//   3. SEED_SERVERS    - bootstrap labels for a first run before anything is customised
//
// A server only reaches the picker if its container exists right now. That is the rule that stops
// removed servers lingering as unusable ghost entries.
//
// The registry's mutable state is private to this module. It used to be four top-level `let`s in
// server.js that any of seventy handlers could reassign; now it changes in exactly one place
// (refreshServers) and is read through accessors.

const { getIniValue } = require('../domain/ini')
const fs = require('fs')
const docker = require('../infra/docker')

/** @typedef {import('../paths').Server} Server */

// ===== SERVER REGISTRY =====
// A managed PZ server is a Docker container plus the data/workshop paths this manager has
// mounted for it. Three inputs, merged in refreshServers():
//   1. auto-discovery  — every PZ-image container whose data dir we can actually read
//   2. servers.json    — user overrides (rename / connect / hide / default), keyed by CONTAINER
//   3. SEED_SERVERS    — bootstrap labels for a first run before anything is customised
// A server only reaches the picker if its container exists *right now*. That is the rule that
// stops removed servers (e.g. the old zomboid42 sandbox) lingering as unusable ghost entries.
// Deliberately carries no `name`: a hardcoded label here outlives whatever the container actually
// runs (the original 'Build 41' seed was still being applied to a container running B42), and it
// would override the server's own PublicName. serverLabel() resolves the display name instead —
// user override first, then the live PublicName, then the container name.
const SEED_SERVERS = {
  zomboid: { id: 'b41', data: '/pz-data', workshop: '/workshop', connect: '192.168.1.20:16261' },
}
const PZ_IMAGE = 'danixu86/project-zomboid-dedicated-server'
const SERVERS_JSON = '/pz-data/servers.json'

// Overrides are keyed by container name, not by id: the container is the stable real-world
// identity, while an id is just a label the user is allowed to change.
function readServerConfig() {
  let raw
  try { raw = JSON.parse(fs.readFileSync(SERVERS_JSON, 'utf8')) }
  catch { return { overrides: {}, hidden: [], default: '' } }
  if (raw && raw.overrides) {
    return { overrides: raw.overrides || {}, hidden: raw.hidden || [], default: raw.default || '' }
  }
  // Legacy shape: a flat { id: {container, ...} } map written before overrides/hidden existed.
  const overrides = {}
  for (const [id, s] of Object.entries(raw || {})) {
    if (s && s.container) overrides[s.container] = Object.assign({}, s, { id })
  }
  return { overrides, hidden: [], default: '' }
}
function writeServerConfig(cfg) {
  fs.writeFileSync(SERVERS_JSON, JSON.stringify({
    overrides: cfg.overrides || {},
    hidden: cfg.hidden || [],
    default: cfg.default || '',
  }, null, 2))
}

// Every container on the box right now, name -> state. Returns null (not an empty map) if
// docker can't be reached, so a transient failure never prunes the whole registry.
function liveContainers() {
  const all = docker.psAll()
  return all ? new Map(Object.entries(all)) : null
}

// This container's own bind mounts, so we know which host-side paths we can actually read.
function ownMounts() {
  const id = docker.ownId()
  return id ? docker.mounts(id) : []
}

// Auto-detects any running/stopped PZ dedicated-server container this manager can actually
// see the data for (i.e. its /home/steam/Zomboid mount matches one of our own mounted paths).
// Lets a newly added PZ server show up without a manual servers.json/code edit — the only
// thing still required is giving mod-manager a matching volume mount in docker-compose.yml.
function discoverServers() {
  const mine = ownMounts()
  const dataMounts = mine.filter(m => /^\/pz-data\d*$/.test(m.Destination))
  const workshopMounts = mine.filter(m => /^\/workshop\d*$/.test(m.Destination))
  // The server's force_install_dir. Optional: a manager without this mount still manages the
  // server, it just can't reinstall — see installContent().
  const installMounts = mine.filter(m => /^\/pz-install\d*$/.test(m.Destination))
  const names = docker.psByImage(PZ_IMAGE)

  const found = {}
  for (const name of names) {
    try {
      const mounts = docker.mounts(name)
      const dataMount = mounts.find(m => m.Destination === '/home/steam/Zomboid')
      if (!dataMount) continue
      const ourData = dataMounts.find(m => m.Source === dataMount.Source)
      if (!ourData) continue // this manager can't see that server's files — nothing to manage yet

      const suffix = ourData.Destination.replace('/pz-data', '')
      const workshopMount = mounts.find(m => m.Destination.endsWith('/workshop'))
      const ourWorkshop = workshopMounts.find(m => m.Destination === '/workshop' + suffix)
        || (workshopMount && workshopMounts.find(m => m.Source === workshopMount.Source))
        || workshopMounts[0]

      // Matched by mount source, never by convention: this is the tree the game actually loads
      // from, and pointing a purge at the wrong server's copy is not a recoverable mistake.
      const installMount = mounts.find(m => m.Destination === '/home/steam/pz-dedicated')
      const ourInstall = (installMount && installMounts.find(m => m.Source === installMount.Source))
        || installMounts.find(m => m.Destination === '/pz-install' + suffix)

      found[name] = {
        id: name,
        name: name,
        container: name,
        data: ourData.Destination,
        workshop: ourWorkshop ? ourWorkshop.Destination : '/workshop',
        install: ourInstall ? ourInstall.Destination : '',
        connect: ''
      }
    } catch (e) { console.error('[discover] ' + name + ':', e.message) }
  }
  return found
}

// Discovery is authoritative about what *exists*; config is authoritative about what it's
// *called* and whether it's shown. Everything is keyed by container while merging so a rename
// can't fork one server into two entries.
function refreshServers() {
  const cfg = readServerConfig()
  const live = liveContainers()
  const discovered = discoverServers()
  const byContainer = {}

  for (const s of Object.values(discovered)) {
    byContainer[s.container] = Object.assign({}, s, { discovered: true })
  }

  // Seeds/overrides only get added if discovery missed them AND their container really exists.
  // (Discovery misses a server whose data dir this manager has no matching mount for — still
  // worth listing so start/stop/logs work, even though file-level features won't.)
  const seeds = {}
  for (const [container, s] of Object.entries(SEED_SERVERS)) seeds[container] = Object.assign({ container }, s)
  for (const [container, s] of Object.entries(cfg.overrides)) {
    seeds[container] = Object.assign({}, seeds[container], s, { container })
  }
  for (const [container, s] of Object.entries(seeds)) {
    if (byContainer[container]) continue
    if (live && !live.has(container)) continue // ghost — container is gone, don't list it
    byContainer[container] = Object.assign({ id: container, name: container, data: '', workshop: '', install: '' }, s, { discovered: false })
  }

  // Apply labels (seed defaults, then user overrides on top) to whatever survived — including
  // discovered entries, which know the paths but not what the server should be called.
  for (const [container, o] of Object.entries(seeds)) {
    const t = byContainer[container]
    if (!t) continue
    if (o.id) t.id = o.id
    if (o.name) t.name = o.name
    if (o.connect !== undefined) t.connect = o.connect
    if (o.data) t.data = o.data
    if (o.workshop) t.workshop = o.workshop
    // Only ever set from servers.json, never from SEED_SERVERS — discovery's value is verified
    // against the container's own mount and must win over any hardcoded guess.
    if (o.install) t.install = o.install
  }

  const hidden = new Set(cfg.hidden || [])
  const shown = {}
  const hiddenList = []
  for (const s of Object.values(byContainer)) {
    s.state = live ? (live.get(s.container) || 'unknown') : 'unknown'
    if (hidden.has(s.container)) hiddenList.push(s)
    else shown[s.id] = s
  }

  SERVERS = shown
  HIDDEN_SERVERS = hiddenList
  // Configured entries whose container no longer exists. Surfaced in the UI (not silently
  // dropped) so a server that disappeared is an explicit "forget this" decision.
  STALE_SERVERS = live
    ? Object.entries(seeds)
        .filter(([container]) => !live.has(container))
        .map(([container, s]) => Object.assign({ container, state: 'missing' }, s))
    : []
  SERVER_DEFAULT = SERVERS[cfg.default] ? cfg.default : Object.keys(SERVERS)[0] || ''
}
let SERVERS = {}
let HIDDEN_SERVERS = []
let STALE_SERVERS = []
let SERVER_DEFAULT = ''

// ===== SERVERS LIST =====

// A server's display name: the user's override wins, else the server's own live PublicName,
// else the container name. Never blank.
function serverLabel(s) {
  const cfg = readServerConfig()
  const override = (cfg.overrides[s.container] || {}).name
  if (override) return override
  try { return getIniValue(s, 'PublicName') || s.name || s.container } catch { return s.name || s.container }
}
function serverRow(s, extra) {
  return Object.assign({
    id: s.id,
    name: serverLabel(s),
    container: s.container,
    connect: s.connect || '',
    state: s.state || 'unknown',
    discovered: !!s.discovered,
    managed: !!s.data, // false = container visible but its data dir isn't mounted here
    reinstallable: !!s.install, // false = force_install_dir not mounted here, so no clean reinstall
  }, extra)
}

// --- registry state -------------------------------------------------------------------------
// Private on purpose: refreshServers() above is the only writer.

/** Every selectable server. @returns {Server[]} */
function all() { return Object.values(SERVERS) }

/** @param {string} id @returns {Server|undefined} */
function byId(id) { return SERVERS[id] }

/** @returns {Server[]} */
function hidden() { return HIDDEN_SERVERS }

/** @returns {any[]} */
function stale() { return STALE_SERVERS }

/** @returns {string} */
function defaultId() { return SERVER_DEFAULT }

/**
 * A server by id across shown, hidden and stale - you manage exactly the ones that are not
 * currently selectable, so the admin endpoints cannot use byId() alone.
 * @param {string} id
 */
function anyById(id) {
  return SERVERS[id]
    || HIDDEN_SERVERS.find(s => s.id === id)
    || STALE_SERVERS.find(s => (s.id || s.container) === id)
}

/**
 * The server a request targets (?server=b42), falling back to the default.
 *
 * An id that does not resolve never silently falls through to another server: the guard below
 * rejects it first, so a stale bookmark or localStorage entry cannot write one server's config
 * into another.
 * @param {import('express').Request} req
 * @returns {Server}
 */
function srv(req) {
  return SERVERS[String((req.query && req.query.server) || '')] || SERVERS[SERVER_DEFAULT]
}

/**
 * Single guard for every per-server endpoint. /api/servers* is exempt so the UI can always re-read
 * the list and repair itself.
 * @type {import('express').RequestHandler}
 */
function guard(req, res, next) {
  const id = String((req.query && req.query.server) || '')
  if (!id || req.path.startsWith('/servers')) return next()
  if (SERVERS[id]) return next()
  refreshServers() // it may have appeared since the last 60s scan
  if (SERVERS[id]) return next()
  res.status(404).json({ error: 'Unknown server "' + id + '" — it may have been removed.', code: 'UNKNOWN_SERVER' })
}

module.exports = {
  readServerConfig, writeServerConfig, liveContainers, ownMounts, discoverServers, refreshServers,
  serverLabel, serverRow, all, byId, anyById, hidden, stale, defaultId, srv, guard,
  SEED_SERVERS, PZ_IMAGE, SERVERS_JSON,
}
