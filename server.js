const express = require('express')
const { exec, execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')
const querystring = require('querystring')
const crypto = require('crypto')
const net = require('net')

const app = express()
app.use(express.json())
app.use(express.static('public'))

// ===== SERVER REGISTRY =====
// Each managed PZ server: container name + mounted data/workshop paths.
// Override/extend by dropping a servers.json next to this default list.
const DEFAULT_SERVERS = {
  b41: { id: 'b41', name: 'Build 41', container: 'zomboid',   data: '/pz-data',   workshop: '/workshop',   connect: '192.168.1.20:16261' },
  b42: { id: 'b42', name: 'Build 42', container: 'zomboid42', data: '/pz-data42', workshop: '/workshop42', connect: '192.168.1.20:16271' },
}
const PZ_IMAGE = 'danixu86/project-zomboid-dedicated-server'
const SERVERS_JSON = '/pz-data/servers.json'
function loadServers() {
  try {
    const saved = JSON.parse(fs.readFileSync(SERVERS_JSON, 'utf8'))
    const out = {}
    for (const [id, s] of Object.entries(saved)) out[id] = Object.assign({ id }, s)
    return Object.keys(out).length ? out : DEFAULT_SERVERS
  } catch { return DEFAULT_SERVERS }
}

// This container's own bind mounts, so we know which host-side paths we can actually read.
function ownMounts() {
  try {
    const id = execSync('hostname').toString().trim()
    return JSON.parse(execSync('docker inspect ' + id + ' --format "{{json .Mounts}}"', { maxBuffer: 4 * 1024 * 1024 }).toString())
  } catch { return [] }
}

// Auto-detects any running/stopped PZ dedicated-server container this manager can actually
// see the data for (i.e. its /home/steam/Zomboid mount matches one of our own mounted paths).
// Lets a newly added PZ server show up without a manual servers.json/code edit — the only
// thing still required is giving mod-manager a matching volume mount in docker-compose.yml.
function discoverServers() {
  const mine = ownMounts()
  const dataMounts = mine.filter(m => /^\/pz-data\d*$/.test(m.Destination))
  const workshopMounts = mine.filter(m => /^\/workshop\d*$/.test(m.Destination))
  let names = []
  try {
    names = execSync('docker ps -a --filter ancestor=' + PZ_IMAGE + ' --format "{{.Names}}"').toString().trim().split('\n').filter(Boolean)
  } catch { return {} }

  const found = {}
  for (const name of names) {
    try {
      const mounts = JSON.parse(execSync('docker inspect ' + name + ' --format "{{json .Mounts}}"', { maxBuffer: 4 * 1024 * 1024 }).toString())
      const dataMount = mounts.find(m => m.Destination === '/home/steam/Zomboid')
      if (!dataMount) continue
      const ourData = dataMounts.find(m => m.Source === dataMount.Source)
      if (!ourData) continue // this manager can't see that server's files — nothing to manage yet

      const suffix = ourData.Destination.replace('/pz-data', '')
      const workshopMount = mounts.find(m => m.Destination.endsWith('/workshop'))
      const ourWorkshop = workshopMounts.find(m => m.Destination === '/workshop' + suffix)
        || (workshopMount && workshopMounts.find(m => m.Source === workshopMount.Source))
        || workshopMounts[0]

      found[name] = {
        id: name,
        name: name,
        container: name,
        data: ourData.Destination,
        workshop: ourWorkshop ? ourWorkshop.Destination : '/workshop',
        connect: ''
      }
    } catch (e) { console.error('[discover] ' + name + ':', e.message) }
  }
  return found
}

// Configured servers (servers.json / DEFAULT_SERVERS) always win — auto-discovery only adds
// servers whose *container* isn't already covered by a configured entry (dedupe by container,
// not by id, since a discovered entry's id defaults to the container name and would otherwise
// slip past an id-keyed merge as a duplicate of an already-configured server).
function refreshServers() {
  const configured = loadServers()
  const discovered = discoverServers()
  const configuredContainers = new Set(Object.values(configured).map(s => s.container))
  const merged = Object.assign({}, configured)
  for (const [id, s] of Object.entries(discovered)) {
    if (!configuredContainers.has(s.container)) merged[id] = s
  }
  SERVERS = merged
}
let SERVERS = {}
refreshServers()
setInterval(refreshServers, 60000)
const DEFAULT_SERVER = Object.keys(SERVERS)[0]

// Resolve the server a request targets (?server=b42); falls back to the first.
function srv(req) {
  return SERVERS[(req.query && req.query.server) || ''] || SERVERS[DEFAULT_SERVER]
}
function allServers() { return Object.values(SERVERS) }

// Per-server derived paths
function iniPath(s)   { return s.data + '/Server/servertest.ini' }
function modsDir(s)   { return s.data + '/mods' }
function dbPath(s)    { return s.data + '/db/servertest.db' }
function logDir(s)    { return s.data + '/Logs' }
function schedPath(s) { return s.data + '/schedule.json' }
function workshopContent(s) { return s.workshop + '/content/108600' }
function backupDirs(s) {
  return {
    startup: s.data + '/backups/startup',
    version: s.data + '/backups/version',
    manual:  s.data + '/backups/manual',
  }
}

// Notifications config stays global (one Pushover account for the whole box)
const NOTIF_PATH = '/pz-data/notifications.json'

// --- INI helpers ---
function readIni(s) { return fs.readFileSync(iniPath(s), 'utf8') }
function getIniList(s, key) {
  const m = readIni(s).match(new RegExp(`^${key}=(.*)$`, 'm'))
  return m ? m[1].split(';').filter(Boolean) : []
}
function setIniList(s, key, values) {
  const ini = readIni(s).replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${values.join(';')}`)
  fs.writeFileSync(iniPath(s), ini)
}

// --- INI single-value helpers ---
function getIniValue(s, key, def) {
  const m = readIni(s).match(new RegExp('^' + key + '=(.*)$', 'm'))
  return m ? m[1].trim() : (def !== undefined ? def : '')
}
function setIniValue(s, key, value) {
  const ini = readIni(s)
  const re = new RegExp('^' + key + '=.*$', 'm')
  const line = key + "=" + value
  fs.writeFileSync(iniPath(s), re.test(ini) ? ini.replace(re, line) : ini + "\n" + line)
}

// --- Workshop helpers ---
function findModInfo(modFolder) {
  const direct = path.join(modFolder, 'mod.info')
  if (fs.existsSync(direct)) return direct
  try {
    for (const sub of fs.readdirSync(modFolder)) {
      const p = path.join(modFolder, sub, 'mod.info')
      if (fs.existsSync(p)) return p
    }
  } catch {}
  return null
}
function modFolders(s, workshopId) {
  const dir = path.join(workshopContent(s), workshopId, 'mods')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => !/^\d+\.\d+$/.test(f) && findModInfo(path.join(dir, f)))
}
function modIdsFromWorkshop(s, workshopId) {
  const dir = path.join(workshopContent(s), workshopId, 'mods')
  const ids = []
  for (const folder of modFolders(s, workshopId)) {
    const info = findModInfo(path.join(dir, folder))
    if (info) {
      const m = fs.readFileSync(info, 'utf8').match(/^id=(.+)$/m)
      if (m) ids.push(m[1].trim())
    }
  }
  return ids
}
function modNamesFromWorkshop(s, workshopId) { return modFolders(s, workshopId) }

// --- DB helpers ---
function dbAll(s, sql) {
  try {
    const out = execSync('sqlite3 -json "' + dbPath(s) + '" ' + JSON.stringify(sql))
    return JSON.parse(out.toString().trim() || '[]')
  } catch { return [] }
}
function dbRun(s, sql) {
  execSync('sqlite3 "' + dbPath(s) + '" ' + JSON.stringify(sql))
}
function sanitizeUsername(u) { return u && /^[\w. -]{1,50}$/.test(u) }
const ACCESS_LEVELS = ['none', 'observer', 'gm', 'overseer', 'moderator', 'admin']

// B42 replaced the flat admin/moderator/banned/accesslevel columns with a role table
const B42_ROLE = { none: 2, user: 2, observer: 4, gm: 5, overseer: 5, moderator: 6, admin: 7, banned: 1 }
function isB42Db(s) {
  return dbAll(s, "SELECT 1 FROM pragma_table_info('whitelist') WHERE name='role'").length > 0
}

// --- Notification helpers ---
const DEFAULT_NOTIF = {
  enabled: true,
  token: 'adw4ispss264iinsd755kh6jwrd1bz',
  userKey: 'umjbifuguvki59qzz1kf9a633g7pt5',
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
    const saved = JSON.parse(fs.readFileSync(NOTIF_PATH, 'utf8'))
    return Object.assign({}, DEFAULT_NOTIF, saved, {
      events: Object.assign({}, DEFAULT_NOTIF.events, saved.events || {}),
      discord: Object.assign({}, DEFAULT_NOTIF.discord, saved.discord || {})
    })
  } catch { return Object.assign({}, DEFAULT_NOTIF) }
}
function writeNotifConfig(cfg) {
  fs.writeFileSync(NOTIF_PATH, JSON.stringify(cfg, null, 2))
}
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
// Server-tagged notification, e.g. "[Build 42] PZ Server Started"
function pushoverFor(s, title, message) { pushover('[' + s.name + '] ' + title, message) }

// --- Discord Status helpers ---
function discordRequest(method, urlPath, body, cb) {
  const data = body ? JSON.stringify(body) : null
  const opts = {
    hostname: 'discord.com', path: '/api/v10' + urlPath, method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'PZServerManager/1.0' }
  }
  if (data) opts.headers['Content-Length'] = Buffer.byteLength(data)
  const req = https.request(opts, r => {
    let out = ''
    r.on('data', c => out += c)
    r.on('end', () => { try { cb(null, JSON.parse(out), r.statusCode) } catch { cb(null, out, r.statusCode) } })
  })
  req.on('error', e => cb(e))
  if (data) req.write(data)
  req.end()
}

function parseWebhookUrl(url) {
  const m = (url || '').match(/webhooks\/(\d+)\/([^/?#\s]+)/)
  return m ? { id: m[1], token: m[2] } : null
}

// --- External IP detection (cached — this box's WAN IP rarely changes) ---
let externalIpCache = { ip: '', at: 0 }
const EXTERNAL_IP_TTL = 15 * 60 * 1000
function getExternalIp(cb) {
  if (externalIpCache.ip && Date.now() - externalIpCache.at < EXTERNAL_IP_TTL) return cb(externalIpCache.ip)
  const req = https.request({ hostname: 'api.ipify.org', path: '/', method: 'GET' }, r => {
    let out = ''
    r.on('data', c => out += c)
    r.on('end', () => {
      const ip = out.trim()
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) externalIpCache = { ip, at: Date.now() }
      cb(externalIpCache.ip)
    })
  })
  req.on('error', () => cb(externalIpCache.ip)) // fall back to last-known value on error
  req.end()
}

// --- Running game version (cached per server — parsed from the server's own startup log) ---
const versionCache = {} // [serverId] = { version, at }
const VERSION_TTL = 5 * 60 * 1000
function getServerVersion(s, cb) {
  const cached = versionCache[s.id]
  if (cached && Date.now() - cached.at < VERSION_TTL) return cb(cached.version)
  exec('docker logs ' + s.container + ' --tail 3000 2>&1', { maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
    const m = (out || '').match(/\bversion=(\S+)/)
    const version = m ? m[1] : (cached ? cached.version : '')
    versionCache[s.id] = { version, at: Date.now() }
    cb(version)
  })
}

// Discord card shows every managed server's status. External IP and each server's game
// version are auto-detected (cached) rather than requiring manual entry.
function updateDiscordStatus(cb) {
  const cfg = readNotifConfig()
  if (!cfg.discord || !cfg.discord.enabled || !cfg.discord.webhookUrl) return cb && cb()
  const wh = parseWebhookUrl(cfg.discord.webhookUrl)
  if (!wh) return cb && cb()
  const servers = allServers()
  const names = servers.map(s => s.container).join(' ')
  getExternalIp(externalIp => {
    exec('docker inspect ' + names + ' --format "{{.Name}}|{{.State.Status}}|{{.State.StartedAt}}"', (err, out) => {
      const states = {}
      for (const line of (out || '').trim().split('\n')) {
        const [name, status, startedAt] = line.replace(/^\//, '').split('|')
        states[name] = { status, startedAt }
      }
      const anyOnline = servers.some(s => (states[s.container] || {}).status === 'running')

      let pending = servers.length || 1
      const versions = {}
      const done = () => sendCard(versions)
      if (!servers.length) return done()
      for (const s of servers) {
        getServerVersion(s, v => { versions[s.id] = v; if (--pending <= 0) done() })
      }

      function sendCard(versions) {
        let body
        if (cfg.discord.richCard) {
          const fields = []
          for (const s of servers) {
            const st = states[s.container] || {}
            const isOnline = st.status === 'running'
            let uptime = '—'
            if (isOnline && st.startedAt) {
              const ms = Date.now() - new Date(st.startedAt).getTime()
              const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000)
              uptime = h > 0 ? h + 'h ' + m + 'm' : m + 'm'
            }
            let title = s.name, modCount = '—', port = ''
            try {
              title = getIniValue(s, 'PublicName') || s.name
              modCount = String(getIniList(s, 'WorkshopItems').length)
              port = getIniValue(s, 'DefaultPort', '')
            } catch {}
            const players = isOnline ? onlinePlayersFor(s) : []
            const version = versions[s.id]
            let value = (isOnline ? '🟢 **Online**' : '🔴 **Offline**') + ' · Uptime ' + uptime + ' · ' + modCount + ' mods'
            if (version) value += ' · v' + version
            if (externalIp && port) value += '\n🔌 `' + externalIp + ':' + port + '`'
            value += '\n👥 ' + players.length + ' online' + (players.length ? ': ' + players.slice(0, 15).join(', ') + (players.length > 15 ? ', …' : '') : '')
            fields.push({ name: title, value, inline: false })
          }
          body = { embeds: [{ title: 'Project Zomboid Servers', color: anyOnline ? 5763719 : 15548997, fields, timestamp: new Date().toISOString() }] }
        } else {
          const stats = servers.map(s => {
            const isOnline = (states[s.container] || {}).status === 'running'
            const n = isOnline ? onlinePlayersFor(s).length : 0
            const version = versions[s.id]
            return s.name + (version ? ' v' + version : '') + ' ' + (isOnline ? '🟢 ' + n + ' online' : '🔴')
          }).join(' | ')
          const template = cfg.discord.template || 'Project Zomboid Server: <ZomboidServerStats>'
          const content = template
            .replace('<ZomboidServerStats>', stats)
            .replace('<LastUpdated>', new Date().toUTCString())
          body = { content }
        }
        const save = id => { cfg.discord.messageId = id; writeNotifConfig(cfg) }
        if (cfg.discord.messageId) {
          discordRequest('PATCH', '/webhooks/' + wh.id + '/' + wh.token + '/messages/' + cfg.discord.messageId, body, (e, data, status) => {
            if (status === 404) { save(''); updateDiscordStatus(cb) }
            else cb && cb(null, data)
          })
        } else {
          discordRequest('POST', '/webhooks/' + wh.id + '/' + wh.token + '?wait=true', body, (e, data, status) => {
            if (data && data.id) save(data.id)
            cb && cb(null, data)
          })
        }
      }
    })
  })
}

setInterval(updateDiscordStatus, 5 * 60 * 1000)

// --- Download state parser ---
function parseDownloads(lines) {
  const state = {}
  for (const line of lines) {
    let m = line.match(/Workshop: download (\d+)\/(\d+) ID=(\d+)/)
    if (m) { state[m[3]] = { status: 'downloading', downloaded: parseInt(m[1]), total: parseInt(m[2]) }; continue }
    m = line.match(/onItemDownloaded.*ID=(\d+)/)
    if (m) { state[m[1]] = { status: 'done' }; continue }
    m = line.match(/CheckItemState\s*->\s*Ready.*ID=(\d+)/)
    if (m) { state[m[1]] = { status: 'ready' }; continue }
    m = line.match(/ID=(\d+).*=\s*(NeedsUpdate|None)\b/)
    if (m && !state[m[1]]) { state[m[1]] = { status: 'pending' }; continue }
    m = line.match(/GetItemState\(\).*ID=(\d+).*=\s*(NeedsUpdate|None)\b/)
    if (m && !state[m[1]]) { state[m[1]] = { status: 'pending' }; continue }
  }
  return Object.entries(state)
    .filter(([, s]) => s.status === 'downloading' || s.status === 'pending')
    .map(([id, s]) => ({
      workshopId: id, status: s.status,
      downloaded: s.downloaded || 0, total: s.total || 0,
      pct: s.total ? Math.round(s.downloaded / s.total * 100) : 0
    }))
}

// --- Background monitors (all per-server) ---
const monitorState = {} // [serverId] = { lastKnownStatus, intentionalStop, wasDownloading, userLogPath, userLogPos }
function mstate(s) {
  if (!monitorState[s.id]) monitorState[s.id] = { lastKnownStatus: null, intentionalStop: false, wasDownloading: false, userLogPath: null, userLogPos: 0 }
  return monitorState[s.id]
}

// Crash monitor
setInterval(() => {
  for (const s of allServers()) {
    exec('docker inspect ' + s.container + ' --format "{{.State.Status}}"', (err, out) => {
      const status = (out || '').trim()
      const st = mstate(s)
      const cfg = readNotifConfig()
      if (st.lastKnownStatus === 'running' && status !== 'running' && !st.intentionalStop) {
        if (cfg.enabled && cfg.events && cfg.events.serverCrash) {
          pushoverFor(s, 'PZ Server Crashed', 'Server stopped unexpectedly. Container status: ' + status)
        }
      }
      st.intentionalStop = false
      st.lastKnownStatus = status
    })
  }
}, 60000)

// Low disk monitor (shared filesystem — one check, one alert)
let lowDiskAlerted = false
setInterval(() => {
  const cfg = readNotifConfig()
  if (!cfg.enabled || !cfg.events || !cfg.events.lowDisk) return
  exec('df -hP /workshop 2>/dev/null | tail -1', (err, out) => {
    const cols = (out || '').trim().split(/\s+/)
    const availStr = cols[3] || ''
    const val = parseFloat(availStr)
    const unit = availStr.replace(/[\d.]/g, '').toUpperCase()
    const availGB = unit === 'G' ? val : unit === 'M' ? val / 1024 : unit === 'T' ? val * 1024 : 0
    const threshold = cfg.lowDiskThresholdGB || 5
    if (availGB > 0 && availGB < threshold && !lowDiskAlerted) {
      lowDiskAlerted = true
      pushover('PZ Server: Low Disk Space', availStr + ' remaining on server (' + (cols[4] || '') + ' used). Free up space before it fills.')
    } else if (availGB >= threshold) {
      lowDiskAlerted = false
    }
  })
}, 300000)

// Workshop download completion monitor
setInterval(() => {
  const cfg = readNotifConfig()
  for (const s of allServers()) {
    const st = mstate(s)
    if (!cfg.enabled || !cfg.events || !cfg.events.downloadComplete) { st.wasDownloading = false; continue }
    exec('docker logs ' + s.container + ' --tail 500 2>&1', { maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      const active = parseDownloads((out || '').split('\n'))
      const isDownloading = active.length > 0
      if (st.wasDownloading && !isDownloading) {
        pushoverFor(s, 'PZ Mods Updated', 'All Workshop downloads complete. Restart server to apply mod updates.')
      }
      st.wasDownloading = isDownloading
    })
  }
}, 30000)

// Online players parsed from the user event log (shared by API + Discord)
function onlinePlayersFor(s) {
  const logFile = findLatestUserLog(s)
  if (!logFile) return []
  try {
    const content = fs.readFileSync(logFile, 'utf8')
    const online = new Set()
    for (const line of content.split('\n')) {
      let m
      if ((m = line.match(/"([^"]+)" fully connected/))) online.add(m[1])
      else if ((m = line.match(/"([^"]+)" disconnected player/)) || (m = line.match(/"([^"]+)" removed connection/))) online.delete(m[1])
    }
    return Array.from(online)
  } catch { return [] }
}

// Player event log monitor
function findLatestUserLog(s) {
  try {
    return fs.readdirSync(logDir(s))
      .filter(f => f.endsWith('_user.txt'))
      .map(f => path.join(logDir(s), f))
      .sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime)[0] || null
  } catch { return null }
}

function pollUserLog(s) {
  const cfg = readNotifConfig()
  if (!cfg.enabled || !cfg.events) return
  const ev = cfg.events
  if (!ev.playerJoin && !ev.playerLeave && !ev.playerDied && !ev.playerKicked) return

  const latest = findLatestUserLog(s)
  if (!latest) return
  const st = mstate(s)

  try {
    const size = fs.statSync(latest).size
    if (latest !== st.userLogPath) {
      st.userLogPath = latest
      st.userLogPos = size
      return
    }
    if (size <= st.userLogPos) return

    const fd = fs.openSync(latest, 'r')
    const buf = Buffer.allocUnsafe(size - st.userLogPos)
    fs.readSync(fd, buf, 0, buf.length, st.userLogPos)
    fs.closeSync(fd)
    st.userLogPos = size

    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      let m
      if (ev.playerJoin && (m = line.match(/"([^"]+)" fully connected/))) {
        pushoverFor(s, 'Player Joined', m[1] + ' joined the server'); continue
      }
      if (ev.playerLeave && (m = line.match(/"([^"]+)" disconnected player/))) {
        pushoverFor(s, 'Player Left', m[1] + ' left the server'); continue
      }
      if (ev.playerDied && (m = line.match(/user (\S+) died at/))) {
        pushoverFor(s, 'Player Died', m[1] + ' has died'); continue
      }
      if (ev.playerKicked) {
        m = line.match(/"([^"]+)" kicked/) || line.match(/kicking "?(\S+?)"? from server/i)
        if (m) { pushoverFor(s, 'Player Kicked', m[1] + ' was kicked from the server'); continue }
      }
    }
  } catch {}
}

setInterval(() => { for (const s of allServers()) pollUserLog(s) }, 10000)

// ===== STARTUP TASKS (per server) =====

for (const s of allServers()) {
  // Skip servers whose data dir isn't mounted/provisioned yet
  if (!fs.existsSync(iniPath(s))) { console.log('[startup] ' + s.name + ': no ini yet, skipping fixes'); continue }

  try { fs.mkdirSync(backupDirs(s).manual, { recursive: true }) } catch {}

  // Ensure periodic in-game backups are enabled (60 min interval, keep 10)
  try {
    const period = parseInt(getIniValue(s, 'BackupsPeriod', '0')) || 0
    const count = parseInt(getIniValue(s, 'BackupsCount', '5')) || 5
    if (period < 60) setIniValue(s, 'BackupsPeriod', '60')
    if (count < 10) setIniValue(s, 'BackupsCount', '10')
  } catch (e) { console.error('[startup] ' + s.name + ' BackupsPeriod fix failed:', e.message) }

  // Auto-configure RCON password if not set (takes effect after next server restart)
  try {
    const pass = getIniValue(s, 'RCONPassword', '')
    if (!pass) {
      const newPass = crypto.randomBytes(12).toString('hex')
      setIniValue(s, 'RCONPassword', newPass)
      console.log('[RCON] ' + s.name + ': auto-set password. Restart PZ server to activate in-game warnings.')
    }
  } catch (e) { console.error('[startup] ' + s.name + ' RCON setup failed:', e.message) }
}

// ===== RCON =====

function rconCommand(s, command, cb) {
  const pass = getIniValue(s, 'RCONPassword', '')
  const port = parseInt(getIniValue(s, 'RCONPort', '27015')) || 27015
  if (!pass) return cb && cb(new Error('RCON not configured'))

  const client = net.createConnection(port, s.container)
  let buf = Buffer.alloc(0)
  let authed = false
  let done = false
  let responseBody = ''

  const finish = (err) => {
    if (done) return
    done = true
    try { client.destroy() } catch {}
    if (cb) cb(err || null, responseBody)
  }

  const makePacket = (id, type, body) => {
    const bodyBuf = Buffer.from(body, 'utf8')
    const size = 4 + 4 + bodyBuf.length + 1 + 1
    const pkt = Buffer.alloc(4 + size)
    pkt.writeInt32LE(size, 0)
    pkt.writeInt32LE(id, 4)
    pkt.writeInt32LE(type, 8)
    bodyBuf.copy(pkt, 12)
    return pkt
  }

  client.setTimeout(5000, () => finish(new Error('RCON timeout')))
  client.on('error', finish)
  client.on('connect', () => client.write(makePacket(1, 3, pass)))
  client.on('data', (data) => {
    buf = Buffer.concat([buf, data])
    while (buf.length >= 12) {
      const size = buf.readInt32LE(0)
      if (buf.length < 4 + size) break
      const id = buf.readInt32LE(4)
      const bodyLen = Math.max(0, size - 10)
      const pktBody = buf.slice(12, 12 + bodyLen).toString('utf8')
      buf = buf.slice(4 + size)
      if (!authed) {
        if (id === -1) return finish(new Error('RCON auth failed'))
        authed = true
        client.write(makePacket(2, 2, command))
      } else {
        responseBody += pktBody
        finish(null)
      }
    }
  })
}

function sendIngameMsg(s, msg) {
  const safe = msg.replace(/"/g, "'")
  rconCommand(s, 'servermsg "' + safe + '"', (err) => {
    if (err) console.log('[RCON] ' + s.name + ' message failed (not active yet?):', err.message)
    else console.log('[RCON] ' + s.name + ' sent:', msg)
  })
}

// ===== SCHEDULE (per server) =====

const INTERVAL_CHOICES = [2, 6, 12, 24]

function readSchedule(s) {
  try { return Object.assign({ mode: 'daily', intervalHours: 24 }, JSON.parse(fs.readFileSync(schedPath(s), 'utf8'))) }
  catch { return { enabled: false, mode: 'daily', hour: 4, minute: 0, intervalHours: 24 } }
}

// Minutes until the next scheduled restart occurrence.
// daily: once a day at hour:minute. interval: every N hours at :minute,
// anchored so hour is one of the occurrences (e.g. hour=4, N=6 → 4,10,16,22).
function minutesUntilRestart(sched, totalNow) {
  const m = parseInt(sched.minute) || 0
  if (sched.mode === 'interval') {
    const iv = INTERVAL_CHOICES.includes(parseInt(sched.intervalHours)) ? parseInt(sched.intervalHours) : 24
    const anchor = ((parseInt(sched.hour) || 0) % iv + iv) % iv
    let best = Infinity
    for (let h = anchor; h < 24; h += iv) {
      const d = ((h * 60 + m - totalNow) + 1440) % 1440
      if (d < best) best = d
    }
    return best
  }
  const target = ((parseInt(sched.hour) || 4) * 60 + m)
  return ((target - totalNow) + 1440) % 1440
}
function writeSchedule(s, sched) { fs.writeFileSync(schedPath(s), JSON.stringify(sched, null, 2)) }

const lastRestartMinute = {} // [serverId] = minute

// Check every minute for scheduled restarts
setInterval(() => {
  const now = new Date()
  const totalNow = now.getHours() * 60 + now.getMinutes()
  for (const s of allServers()) {
    const sched = readSchedule(s)
    if (!sched.enabled) continue

    const minutesBefore = minutesUntilRestart(sched, totalNow)

    if (minutesBefore === 0 && lastRestartMinute[s.id] !== totalNow) {
      lastRestartMinute[s.id] = totalNow
      console.log('[Schedule] ' + s.name + ' scheduled restart triggered at', now.toLocaleTimeString())
      mstate(s).intentionalStop = true
      exec('docker restart ' + s.container, { timeout: 90000 }, (err) => {
        if (err) return console.error('[Schedule] ' + s.name + ' restart failed:', err.message)
        const desc = sched.mode === 'interval'
          ? 'Server restarted on schedule (every ' + sched.intervalHours + 'h).'
          : 'Server restarted on schedule at ' + (parseInt(sched.hour) || 4) + ':' + String(parseInt(sched.minute) || 0).padStart(2, '0')
        pushoverFor(s, 'PZ Scheduled Restart', desc)
      })
    } else if ([10, 5, 1].includes(minutesBefore)) {
      sendIngameMsg(s, 'Server restarting in ' + minutesBefore + ' minute' + (minutesBefore > 1 ? 's' : '') + '!')
    }
  }
}, 60000)

// ===== BACKUP HELPERS =====

function listBackupDir(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.zip') || f.endsWith('.tar.gz'))
      .map(f => {
        const stat = fs.statSync(path.join(dir, f))
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() }
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
  } catch { return [] }
}

function validBackupPath(s, type, name) {
  const dir = backupDirs(s)[type]
  if (!dir) return null
  if (!name || /[/\\]/.test(name) || name.startsWith('.')) return null
  if (!name.endsWith('.zip') && !name.endsWith('.tar.gz')) return null
  const p = path.join(dir, name)
  if (!fs.existsSync(p)) return null
  return p
}

// ===== SERVERS LIST =====

app.get('/api/servers', (req, res) => {
  res.json({
    default: DEFAULT_SERVER,
    servers: allServers().map(s => {
      let liveName = s.name
      try { liveName = getIniValue(s, 'PublicName') || s.name || s.container } catch { liveName = s.name || s.container }
      return { id: s.id, name: liveName, container: s.container, connect: s.connect || '' }
    })
  })
})

// Manually re-scans for PZ containers (in case one was added since the last 60s auto-refresh).
app.post('/api/servers/refresh', (req, res) => {
  refreshServers()
  res.json({ success: true, count: allServers().length })
})

// ===== SERVER CONTROL =====

app.get('/api/status', (req, res) => {
  const s = srv(req)
  exec('docker inspect ' + s.container + ' --format "{{.State.Status}}|{{.State.StartedAt}}"', (err, out) => {
    if (err) return res.json({ status: 'unknown' })
    const [status, startedAt] = out.trim().split('|')
    res.json({ status, startedAt, server: s.id })
  })
})

app.post('/api/server/start', (req, res) => {
  const s = srv(req)
  exec('docker start ' + s.container, { timeout: 30000 }, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStart) pushoverFor(s, 'PZ Server Started', 'Project Zomboid server is starting up.')
    }
    res.json({ success: ok, error: err?.message })
  })
})

app.post('/api/server/stop', (req, res) => {
  const s = srv(req)
  mstate(s).intentionalStop = true
  exec('docker stop ' + s.container, { timeout: 60000 }, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStop) pushoverFor(s, 'PZ Server Stopped', 'Project Zomboid server has been stopped.')
    }
    res.json({ success: ok, error: err?.message })
  })
})

app.post('/api/server/restart', (req, res) => {
  const s = srv(req)
  mstate(s).intentionalStop = true
  exec('docker restart ' + s.container, { timeout: 60000 }, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStart) pushoverFor(s, 'PZ Server Restarted', 'Project Zomboid server has been restarted.')
    }
    res.json({ success: ok, error: err?.message })
  })
})

// Warned restart: send in-game countdown messages then restart
app.post('/api/server/warned-restart', (req, res) => {
  const s = srv(req)
  const delayMin = Math.max(1, Math.min(60, parseInt((req.body || {}).delayMinutes) || 10))
  res.json({ success: true, message: 'Restart scheduled in ' + delayMin + ' minute(s).' })
  sendIngameMsg(s, 'Server restarting in ' + delayMin + ' minute' + (delayMin > 1 ? 's' : '') + '!')
  const warnings = [10, 5, 1].filter(w => w < delayMin)
  warnings.forEach(w => {
    setTimeout(() => sendIngameMsg(s, 'Server restarting in ' + w + ' minute' + (w > 1 ? 's' : '') + '!'),
      (delayMin - w) * 60000)
  })
  setTimeout(() => {
    mstate(s).intentionalStop = true
    exec('docker restart ' + s.container, { timeout: 90000 }, () => {})
  }, delayMin * 60000)
})

// ===== LOGS =====

app.get('/api/logs', (req, res) => {
  const s = srv(req)
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const tail = Math.min(parseInt(req.query.tail) || 300, 2000)
  const child = spawn('docker', ['logs', s.container, '--tail', String(tail), '--follow', '--timestamps'])
  const send = l => { if (l.trim()) res.write('data: ' + JSON.stringify(l) + '\n\n') }
  child.stdout.on('data', d => d.toString().split('\n').forEach(send))
  child.stderr.on('data', d => d.toString().split('\n').forEach(send))
  child.on('close', () => res.end())
  req.on('close', () => child.kill())
})

// ===== PLAYERS / WHITELIST =====

app.get('/api/players', (req, res) => {
  const s = srv(req)
  const players = isB42Db(s)
    ? dbAll(s, "SELECT w.username, COALESCE(r.name,'user') AS accesslevel, (COALESCE(r.name,'')='admin') AS admin, (COALESCE(r.name,'')='moderator') AS moderator, (COALESCE(r.name,'')='banned') AS banned, w.lastConnection, w.displayName FROM whitelist w LEFT JOIN role r ON r.id = w.role ORDER BY w.lastConnection DESC")
    : dbAll(s, 'SELECT username, accesslevel, admin, moderator, banned, lastConnection, displayName FROM whitelist ORDER BY lastConnection DESC')
  res.json({ players })
})

app.post('/api/players', (req, res) => {
  const s = srv(req)
  const { username, accesslevel = 'none' } = req.body
  if (!sanitizeUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  if (!ACCESS_LEVELS.includes(accesslevel)) return res.status(400).json({ error: 'Invalid accesslevel' })
  const u = username.replace(/'/g, "''")
  const isAdmin = accesslevel === 'admin' ? 1 : 0
  const isMod = accesslevel === 'moderator' ? 1 : 0
  try {
    if (isB42Db(s)) {
      dbRun(s, 'INSERT OR IGNORE INTO whitelist (username, role, world) VALUES (\'' + u + '\', ' + (B42_ROLE[accesslevel] || 2) + ', \'servertest\')')
    } else {
      dbRun(s, 'INSERT OR IGNORE INTO whitelist (username, accesslevel, admin, moderator, banned, world) VALUES (\'' + u + '\', \'' + accesslevel + '\', ' + isAdmin + ', ' + isMod + ', 0, \'servertest\')')
    }
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/players/:username', (req, res) => {
  const s = srv(req)
  const { username } = req.params
  if (!sanitizeUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  const { accesslevel, banned } = req.body
  const u = username.replace(/'/g, "''")
  if (isB42Db(s)) {
    // B42: bans and access levels are both roles
    let role
    if (banned !== undefined) role = banned ? B42_ROLE.banned : B42_ROLE.none
    if (accesslevel !== undefined) {
      if (!ACCESS_LEVELS.includes(accesslevel)) return res.status(400).json({ error: 'Invalid accesslevel' })
      role = B42_ROLE[accesslevel] || B42_ROLE.none
    }
    if (role === undefined) return res.status(400).json({ error: 'Nothing to update' })
    try {
      dbRun(s, 'UPDATE whitelist SET role=' + role + ' WHERE username=\'' + u + '\'')
      return res.json({ success: true })
    } catch (e) { return res.status(500).json({ error: e.message }) }
  }
  const fields = []
  if (accesslevel !== undefined) {
    if (!ACCESS_LEVELS.includes(accesslevel)) return res.status(400).json({ error: 'Invalid accesslevel' })
    fields.push('accesslevel=\'' + accesslevel + '\'', 'admin=' + (accesslevel === 'admin' ? 1 : 0), 'moderator=' + (accesslevel === 'moderator' ? 1 : 0))
  }
  if (banned !== undefined) fields.push('banned=' + (banned ? 1 : 0))
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' })
  try {
    dbRun(s, 'UPDATE whitelist SET ' + fields.join(', ') + ' WHERE username=\'' + u + '\'')
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/players/:username', (req, res) => {
  const s = srv(req)
  const { username } = req.params
  if (!sanitizeUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  const u = username.replace(/'/g, "''")
  try {
    dbRun(s, 'DELETE FROM whitelist WHERE username=\'' + u + '\'')
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ===== MODS =====

// --- Steam Workshop API ---
// Both endpoints below are public and need no API key.

// Titles (and file size) for arbitrary Workshop item IDs. Batched; Steam accepts many per call.
function steamFileDetails(ids, cb) {
  if (!ids.length) return cb(null, {})
  const form = { itemcount: ids.length }
  ids.forEach((id, i) => { form['publishedfileids[' + i + ']'] = id })
  const data = querystring.stringify(form)
  const req = https.request({
    hostname: 'api.steampowered.com',
    path: '/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
  }, r => {
    let out = ''
    r.on('data', c => out += c)
    r.on('end', () => {
      try {
        const files = (JSON.parse(out).response || {}).publishedfiledetails || []
        const map = {}
        for (const f of files) {
          if (f.publishedfileid) map[f.publishedfileid] = { title: f.title || '', fileSize: parseInt(f.file_size) || 0, ok: f.result === 1 }
        }
        cb(null, map)
      } catch (e) { cb(e) }
    })
  })
  req.on('error', cb)
  req.write(data); req.end()
}

// Child item IDs for one or more collections. Returns { collectionId: [childIds] } and only
// includes entries that are genuinely collections (result 1 with children) — this is also how
// we detect that a "mod" ID is really a nested collection.
function steamCollectionDetails(ids, cb) {
  if (!ids.length) return cb(null, {})
  const form = { collectioncount: ids.length }
  ids.forEach((id, i) => { form['publishedfileids[' + i + ']'] = id })
  const data = querystring.stringify(form)
  const req = https.request({
    hostname: 'api.steampowered.com',
    path: '/ISteamRemoteStorage/GetCollectionDetails/v1/',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
  }, r => {
    let out = ''
    r.on('data', c => out += c)
    r.on('end', () => {
      try {
        const details = (JSON.parse(out).response || {}).collectiondetails || []
        const map = {}
        for (const c of details) {
          const kids = (c.children || []).map(k => k.publishedfileid)
          if (c.result === 1 && kids.length) map[c.publishedfileid] = kids
        }
        cb(null, map)
      } catch (e) { cb(e) }
    })
  })
  req.on('error', cb)
  req.write(data); req.end()
}

function getCollectionChildren(collectionId, cb) {
  steamCollectionDetails([collectionId], (err, map) => {
    if (err) return cb(err)
    const kids = map[collectionId]
    if (!kids) return cb(new Error('Not a collection, or collection is empty'))
    cb(null, kids)
  })
}

// Recursively resolves a collection to its leaf (non-collection) Workshop item IDs.
// A PZ collection frequently contains other collections — installing those IDs directly is
// what previously produced "mods" that were really collection stubs with no game content.
function resolveCollectionLeaves(collectionId, cb) {
  const leaves = new Set()
  const seen = new Set()
  const nested = []
  function walk(ids, depth, done) {
    const todo = ids.filter(id => !seen.has(id))
    todo.forEach(id => seen.add(id))
    if (!todo.length || depth > 4) return done()
    steamCollectionDetails(todo, (err, map) => {
      if (err) return done(err)
      const childIds = []
      for (const id of todo) {
        if (map[id]) { nested.push(id); childIds.push(...map[id]) }
        else leaves.add(id)
      }
      if (!childIds.length) return done()
      walk(childIds, depth + 1, done)
    })
  }
  steamCollectionDetails([collectionId], (err, map) => {
    if (err) return cb(err)
    const top = map[collectionId]
    if (!top) return cb(new Error('Not a collection, or collection is empty'))
    seen.add(collectionId)
    walk(top, 1, (e) => e ? cb(e) : cb(null, Array.from(leaves), nested))
  })
}

// --- Workshop title cache (avoids re-hitting Steam on every page load) ---
const titleCache = {} // id -> { title, at }
const TITLE_TTL = 6 * 60 * 60 * 1000
function getTitles(ids, cb) {
  const now = Date.now()
  const missing = ids.filter(id => !titleCache[id] || now - titleCache[id].at > TITLE_TTL)
  const out = () => {
    const map = {}
    for (const id of ids) map[id] = (titleCache[id] || {}).title || ''
    cb(map)
  }
  if (!missing.length) return out()
  let pending = 0
  const chunks = []
  for (let i = 0; i < missing.length; i += 50) chunks.push(missing.slice(i, i + 50))
  pending = chunks.length
  for (const chunk of chunks) {
    steamFileDetails(chunk, (err, map) => {
      if (!err) for (const [id, d] of Object.entries(map)) titleCache[id] = { title: d.title, at: Date.now() }
      if (--pending <= 0) out()
    })
  }
}

// --- Collections registry (persisted per server) ---
// Tracks which collections were installed here so they can be listed, re-synced (to pick up
// items added to the collection upstream), and removed.
function collectionsPath(s) { return s.data + '/collections.json' }
function readCollections(s) {
  try { return JSON.parse(fs.readFileSync(collectionsPath(s), 'utf8')) } catch { return [] }
}
function writeCollections(s, list) {
  try { fs.writeFileSync(collectionsPath(s), JSON.stringify(list, null, 2)) }
  catch (e) { console.error('[collections] write failed:', e.message) }
}
function upsertCollection(s, entry) {
  const list = readCollections(s)
  const i = list.findIndex(c => c.id === entry.id)
  if (i >= 0) list[i] = Object.assign(list[i], entry)
  else list.push(entry)
  writeCollections(s, list)
}

// --- Download queue (persisted — survives a mod-manager container restart) ---
// One JSON array per server: { id, source, collectionId, status: 'queued'|'installed'|'failed',
// queuedAt, updatedAt, error, modIds, copiedFolders }
function queuePath(s) { return s.data + '/download-queue.json' }
function readQueue(s) {
  try { return JSON.parse(fs.readFileSync(queuePath(s), 'utf8')) } catch { return [] }
}
function writeQueue(s, queue) {
  try { fs.writeFileSync(queuePath(s), JSON.stringify(queue.slice(-300), null, 2)) }
  catch (e) { console.error('[queue] write failed:', e.message) }
}
function queueAdd(s, workshopIds, source, collectionId) {
  const queue = readQueue(s)
  const now = new Date().toISOString()
  // Drop any prior terminal record for the same id so re-installs don't stack up duplicates.
  const kept = queue.filter(e => !(workshopIds.includes(e.id) && e.status !== 'queued'))
  for (const id of workshopIds) {
    if (kept.some(e => e.id === id && e.status === 'queued')) continue
    kept.push({ id, source, collectionId: collectionId || null, status: 'queued', queuedAt: now, updatedAt: now })
  }
  writeQueue(s, kept)
}

// True when this Workshop item has real, loadable mod content on disk.
function hasModContent(s, workshopId) {
  return modFolders(s, workshopId).length > 0
}

// Post-download bookkeeping for one Workshop item. Only registers the item in the server ini
// if it actually produced loadable mod folders — registering empty/failed downloads is what
// previously polluted WorkshopItems with entries the game can't load.
function registerInstalledMod(s, workshopId) {
  try {
    execSync('docker exec ' + s.container + ' sh -c ' + JSON.stringify(
      'cp -rn /home/steam/pz-dedicated/steamapps/workshop/content/108600/' + workshopId +
      ' /home/steam/Steam/steamapps/workshop/content/108600/ 2>/dev/null; true'
    ), { timeout: 30000 })
  } catch (e) {}
  const dir = path.join(workshopContent(s), workshopId, 'mods')
  const copiedFolders = []
  if (fs.existsSync(dir)) {
    for (const folder of fs.readdirSync(dir)) {
      if (/^\d+\.\d+$/.test(folder)) continue
      const src = path.join(dir, folder)
      const dest = path.join(modsDir(s), folder)
      try { if (!fs.existsSync(dest)) { execSync('cp -r "' + src + '" "' + dest + '"'); copiedFolders.push(folder) } } catch {}
    }
  }
  const newModIds = modIdsFromWorkshop(s, workshopId)
  if (!newModIds.length) return { status: 'empty', modIds: [], copiedFolders }
  setIniList(s, 'WorkshopItems', [...new Set([...getIniList(s, 'WorkshopItems'), workshopId])])
  setIniList(s, 'Mods', [...new Set([...getIniList(s, 'Mods'), ...newModIds])])
  return { status: 'installed', modIds: newModIds, copiedFolders }
}

// Kicks off a SteamCMD download and returns immediately — runs via a *detached* `docker exec -d`
// inside the PZ server container, so the download survives a restart of this manager.
// Completion is detected by reconcileDownloads() below, not by a callback on this process.
function steamcmdDownload(s, workshopIds, source, collectionId) {
  if (!workshopIds.length) return
  queueAdd(s, workshopIds, source, collectionId)
  const items = workshopIds.map(id => '+workshop_download_item 108600 ' + id).join(' ')
  const cmd = 'docker exec -d ' + s.container + ' /home/steam/steamcmd/steamcmd.sh +force_install_dir /home/steam/pz-dedicated +login anonymous ' + items + ' +quit'
  exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[download] failed to start for ' + s.name + ':', stderr || err.message)
      const queue = readQueue(s)
      for (const e of queue) {
        if (workshopIds.includes(e.id) && e.status === 'queued') {
          e.status = 'failed'; e.error = 'Could not start SteamCMD'; e.updatedAt = new Date().toISOString()
        }
      }
      writeQueue(s, queue)
    }
  })
}

// Reconciles the persisted queue against reality on an interval.
//
// An item leaves "queued" only once it is no longer actively downloading AND we've confirmed
// what actually landed on disk. Absence from the active-download log is NOT treated as success
// on its own — that assumption previously marked never-downloaded mods as "installed" and wrote
// them into servertest.ini. Items that produce no mod content are marked failed with a reason,
// and nested collections are detected and expanded into their child items.
const QUEUE_GRACE_MS = 90 * 1000
function reconcileDownloads(s) {
  const queue = readQueue(s)
  const pending = queue.filter(e => e.status === 'queued')
  if (!pending.length) return
  exec('docker logs ' + s.container + ' --tail 1500 2>&1', { maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
    const activeIds = new Set(parseDownloads((out || '').split('\n')).map(a => a.workshopId))
    const settled = []
    for (const entry of pending) {
      if (activeIds.has(entry.id)) continue
      // Give a just-queued item time to actually appear in the log before judging it.
      if (Date.now() - new Date(entry.queuedAt).getTime() < QUEUE_GRACE_MS) continue
      settled.push(entry)
    }
    if (!settled.length) return

    // Anything with no content might be a nested collection rather than a failed mod — ask Steam.
    const empties = settled.filter(e => !hasModContent(s, e.id)).map(e => e.id)
    steamCollectionDetails(empties, (cErr, collMap) => {
      const nowIso = new Date().toISOString()
      const expand = []
      for (const entry of settled) {
        const kids = collMap && collMap[entry.id]
        if (kids && kids.length) {
          entry.status = 'collection'
          entry.error = null
          entry.childCount = kids.length
          entry.updatedAt = nowIso
          // Pull the collection out of the mod list — it isn't a loadable mod — and queue its children.
          setIniList(s, 'WorkshopItems', getIniList(s, 'WorkshopItems').filter(id => id !== entry.id))
          expand.push({ parent: entry.id, kids })
          continue
        }
        try {
          const r = registerInstalledMod(s, entry.id)
          if (r.status === 'installed') {
            entry.status = 'installed'
            entry.modIds = r.modIds
            entry.copiedFolders = r.copiedFolders
            entry.error = null
          } else {
            entry.status = 'failed'
            entry.error = 'Downloaded nothing usable (no mod folders found)'
          }
        } catch (e) {
          entry.status = 'failed'
          entry.error = e.message
        }
        entry.updatedAt = nowIso
      }
      writeQueue(s, queue)
      for (const x of expand) {
        const fresh = x.kids.filter(k => !getIniList(s, 'WorkshopItems').includes(k))
        if (fresh.length) {
          console.log('[collection] ' + x.parent + ' is a nested collection — queueing ' + fresh.length + ' child item(s)')
          steamcmdDownload(s, fresh, 'collection', x.parent)
        }
      }
    })
  })
}
setInterval(() => { for (const s of allServers()) reconcileDownloads(s) }, 15000)

// --- Mods list ---

app.get('/api/mods', (req, res) => {
  const s = srv(req)
  const workshopIds = getIniList(s, 'WorkshopItems')
  const queue = readQueue(s)
  const qById = {}
  for (const e of queue) qById[e.id] = e

  // Which collection(s) each mod came from. The registry is authoritative (it's re-resolved on
  // every sync); the queue's collectionId is a fallback for mods installed before a collection
  // was tracked. A mod can legitimately belong to more than one collection.
  const collections = readCollections(s)
  const byMod = {}
  for (const c of collections) {
    for (const item of (c.items || [])) {
      if (!byMod[item]) byMod[item] = []
      if (!byMod[item].some(x => x.id === c.id)) byMod[item].push({ id: c.id, title: c.title || '' })
    }
  }
  for (const [wid, q] of Object.entries(qById)) {
    if (!q.collectionId) continue
    if (!byMod[wid]) byMod[wid] = []
    if (!byMod[wid].some(x => x.id === q.collectionId)) byMod[wid].push({ id: q.collectionId, title: '' })
  }

  const base = workshopIds.map(wid => {
    const modIds = modIdsFromWorkshop(s, wid)
    const folders = modNamesFromWorkshop(s, wid)
    const q = qById[wid]
    let status = 'ok'
    if (!modIds.length) status = (q && q.status === 'collection') ? 'collection' : 'missing'
    return {
      workshopId: wid, modIds, modFolders: folders, status,
      error: (q && q.error) || null,
      collections: byMod[wid] || []
    }
  })

  // Resolve titles for the mods and for any collection we don't already have a name for.
  const needTitles = workshopIds.concat(
    base.reduce((acc, m) => acc.concat(m.collections.filter(c => !c.title).map(c => c.id)), [])
  )
  getTitles([...new Set(needTitles)], titles => {
    res.json({
      mods: base.map(m => Object.assign(m, {
        title: titles[m.workshopId] || '',
        collections: m.collections.map(c => ({ id: c.id, title: c.title || titles[c.id] || '' }))
      }))
    })
  })
})

app.post('/api/mods/install', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.body
  if (!workshopId || !/^\d+$/.test(workshopId)) return res.status(400).json({ error: 'Invalid workshopId' })
  steamcmdDownload(s, [workshopId], 'single', null)
  res.json({ success: true, workshopId, queued: true })
})

app.post('/api/mods/retry', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.body
  if (!workshopId || !/^\d+$/.test(workshopId)) return res.status(400).json({ error: 'Invalid workshopId' })
  steamcmdDownload(s, [workshopId], 'single', null)
  res.json({ success: true, workshopId, queued: true })
})

// Re-queues every mod currently registered but missing its files, and drops stale ini entries
// for anything Steam says is actually a collection.
app.post('/api/mods/repair', (req, res) => {
  const s = srv(req)
  const broken = getIniList(s, 'WorkshopItems').filter(id => !hasModContent(s, id))
  if (!broken.length) return res.json({ success: true, repaired: 0, collections: 0 })
  steamCollectionDetails(broken, (err, collMap) => {
    const colls = Object.keys(collMap || {})
    const retryable = broken.filter(id => !colls.includes(id))
    // Collections aren't mods: unregister them and install their children instead.
    if (colls.length) {
      setIniList(s, 'WorkshopItems', getIniList(s, 'WorkshopItems').filter(id => !colls.includes(id)))
      for (const cid of colls) {
        const kids = collMap[cid].filter(k => !getIniList(s, 'WorkshopItems').includes(k))
        if (kids.length) steamcmdDownload(s, kids, 'collection', cid)
      }
    }
    if (retryable.length) steamcmdDownload(s, retryable, 'single', null)
    res.json({ success: true, repaired: retryable.length, collections: colls.length })
  })
})

app.delete('/api/mods/:workshopId', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.params
  const removedIds = modIdsFromWorkshop(s, workshopId)
  const removedFolders = modNamesFromWorkshop(s, workshopId)
  for (const folder of removedFolders) {
    const dest = path.join(modsDir(s), folder)
    if (fs.existsSync(dest)) try { execSync('rm -rf "' + dest + '"') } catch {}
  }
  setIniList(s, 'WorkshopItems', getIniList(s, 'WorkshopItems').filter(id => id !== workshopId))
  setIniList(s, 'Mods', getIniList(s, 'Mods').filter(id => !removedIds.includes(id)))
  writeQueue(s, readQueue(s).filter(e => e.id !== workshopId))
  res.json({ success: true, workshopId, removedIds, removedFolders })
})

// --- Collections ---

app.get('/api/collections', (req, res) => {
  const s = srv(req)
  const list = readCollections(s)
  const installed = new Set(getIniList(s, 'WorkshopItems'))
  const out = list.map(c => {
    const items = c.items || []
    const have = items.filter(id => installed.has(id) && hasModContent(s, id)).length
    return Object.assign({}, c, { itemCount: items.length, installedCount: have, missingCount: items.length - have })
  })
  getTitles(list.map(c => c.id), titles => {
    res.json({ collections: out.map(c => Object.assign(c, { title: c.title || titles[c.id] || '' })) })
  })
})

// Install (or re-install) a collection: resolves nested collections down to real mod items,
// records it in the registry, and queues anything not already present.
function installCollection(s, collectionId, cb) {
  resolveCollectionLeaves(collectionId, (err, leaves, nested) => {
    if (err) return cb(err)
    getTitles([collectionId], titles => {
      const have = new Set(getIniList(s, 'WorkshopItems'))
      const todo = leaves.filter(id => !have.has(id) || !hasModContent(s, id))
      upsertCollection(s, {
        id: collectionId,
        title: titles[collectionId] || '',
        items: leaves,
        nestedCollections: nested || [],
        lastSynced: new Date().toISOString()
      })
      if (todo.length) steamcmdDownload(s, todo, 'collection', collectionId)
      cb(null, { total: leaves.length, queued: todo.length, nested: (nested || []).length })
    })
  })
}

app.post('/api/collections', (req, res) => {
  const s = srv(req)
  const { collectionId } = req.body || {}
  if (!collectionId || !/^\d+$/.test(collectionId)) return res.status(400).json({ error: 'Invalid collectionId' })
  installCollection(s, collectionId, (err, r) => {
    if (err) return res.status(502).json({ error: 'Could not read collection', detail: err.message })
    res.json(Object.assign({ success: true, collectionId }, r))
  })
})

// Re-check a tracked collection against Steam and pull in anything new or missing.
app.post('/api/collections/:id/sync', (req, res) => {
  const s = srv(req)
  const { id } = req.params
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid collection id' })
  installCollection(s, id, (err, r) => {
    if (err) return res.status(502).json({ error: 'Sync failed', detail: err.message })
    res.json(Object.assign({ success: true, collectionId: id }, r))
  })
})

// Stop tracking a collection. Mods it installed are left in place unless removeMods is set.
app.delete('/api/collections/:id', (req, res) => {
  const s = srv(req)
  const { id } = req.params
  const removeMods = String(req.query.removeMods) === 'true'
  const list = readCollections(s)
  const entry = list.find(c => c.id === id)
  writeCollections(s, list.filter(c => c.id !== id))
  let removed = 0
  if (removeMods && entry) {
    // Only remove items this collection uniquely owns — never yank a mod another tracked
    // collection still depends on.
    const othersOwn = new Set()
    for (const c of list) if (c.id !== id) for (const i of (c.items || [])) othersOwn.add(i)
    for (const wid of (entry.items || [])) {
      if (othersOwn.has(wid)) continue
      const ids = modIdsFromWorkshop(s, wid)
      for (const folder of modNamesFromWorkshop(s, wid)) {
        const dest = path.join(modsDir(s), folder)
        if (fs.existsSync(dest)) try { execSync('rm -rf "' + dest + '"') } catch {}
      }
      setIniList(s, 'WorkshopItems', getIniList(s, 'WorkshopItems').filter(x => x !== wid))
      setIniList(s, 'Mods', getIniList(s, 'Mods').filter(x => !ids.includes(x)))
      removed++
    }
  }
  res.json({ success: true, removedMods: removed })
})

// --- Scheduled collection auto-sync ---
// Config lives alongside the registry so it survives restarts. Off by default.
function autoSyncPath(s) { return s.data + '/collection-autosync.json' }
function readAutoSync(s) {
  try { return Object.assign({ enabled: false, intervalHours: 24 }, JSON.parse(fs.readFileSync(autoSyncPath(s), 'utf8'))) }
  catch { return { enabled: false, intervalHours: 24, lastRun: null } }
}
function writeAutoSync(s, cfg) {
  try { fs.writeFileSync(autoSyncPath(s), JSON.stringify(cfg, null, 2)) } catch (e) {}
}

app.get('/api/collections/autosync', (req, res) => res.json(readAutoSync(srv(req))))

app.put('/api/collections/autosync', (req, res) => {
  const s = srv(req)
  const { enabled, intervalHours } = req.body || {}
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Invalid' })
  const iv = parseInt(intervalHours)
  if (![6, 12, 24, 48, 168].includes(iv)) return res.status(400).json({ error: 'Interval must be 6, 12, 24, 48 or 168 hours' })
  const cur = readAutoSync(s)
  writeAutoSync(s, Object.assign(cur, { enabled, intervalHours: iv }))
  res.json({ success: true })
})

setInterval(() => {
  for (const s of allServers()) {
    const cfg = readAutoSync(s)
    if (!cfg.enabled) continue
    const due = !cfg.lastRun || (Date.now() - new Date(cfg.lastRun).getTime()) >= cfg.intervalHours * 3600000
    if (!due) continue
    const list = readCollections(s)
    if (!list.length) continue
    cfg.lastRun = new Date().toISOString()
    writeAutoSync(s, cfg)
    console.log('[autosync] ' + s.name + ': syncing ' + list.length + ' collection(s)')
    let queuedTotal = 0
    let pending = list.length
    for (const c of list) {
      installCollection(s, c.id, (err, r) => {
        if (!err && r) queuedTotal += r.queued
        if (--pending <= 0 && queuedTotal > 0) {
          pushoverFor(s, 'PZ Collection Sync', 'Auto-sync queued ' + queuedTotal + ' new/missing mod(s) from tracked collections.')
        }
      })
    }
  }
}, 10 * 60 * 1000)

// ===== SERVER CONFIG =====

// Curated fields shown as dedicated controls in the UI; everything else the ini actually
// contains still round-trips through the "Advanced Options" section below (see getFullIni).
const CONFIG_FIELDS = [
  'PublicName','Password','MaxPlayers','PVP','SafetySystem','Open','Public',
  'PauseEmpty','GlobalChat','VoiceEnable','HoursForLootRespawn','SaveWorldEveryMinutes'
]

// Every key=value pair actually present in servertest.ini — lets the UI expose the full
// option set without this file needing to enumerate every possible PZ ini key up front.
function getFullIni(s) {
  const cfg = {}
  for (const line of readIni(s).split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) cfg[m[1]] = m[2]
  }
  return cfg
}

const INI_KEY_RE = /^\w+$/

app.get('/api/config', (req, res) => {
  const s = srv(req)
  res.json(getFullIni(s))
})

app.put('/api/config', (req, res) => {
  const s = srv(req)
  const updates = req.body || {}
  for (const [k, v] of Object.entries(updates)) {
    if (INI_KEY_RE.test(k) && typeof v === 'string') setIniValue(s, k, v)
  }
  res.json({ success: true })
})

// Sandbox / mod options (servertest_SandboxVars.lua) — this is where B41/B42 sandbox settings
// and most mods' own configurable options actually live. It's a Lua table, not an ini, so this
// exposes it as raw text rather than attempting to parse and re-serialize Lua safely.
function sandboxPath(s) { return s.data + '/Server/servertest_SandboxVars.lua' }

app.get('/api/config/sandbox', (req, res) => {
  const s = srv(req)
  try { res.json({ content: fs.readFileSync(sandboxPath(s), 'utf8') }) }
  catch (e) { res.status(404).json({ error: 'SandboxVars file not found', detail: e.message }) }
})

app.put('/api/config/sandbox', (req, res) => {
  const s = srv(req)
  const { content } = req.body || {}
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'Empty content' })
  try {
    fs.copyFileSync(sandboxPath(s), sandboxPath(s) + '.bak')
    fs.writeFileSync(sandboxPath(s), content)
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ===== SYSTEM STATS =====

app.get('/api/sysinfo', (req, res) => {
  const s = srv(req)
  exec('docker stats ' + s.container + ' --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"', (err, out) => {
    const parts = (out || '').trim().split('|')
    const cpu = parts[0] || '—'
    const mem = parts[1] || '—'
    const memPct = parts[2] || '—'
    exec('df -hP /workshop 2>/dev/null | tail -1', (err2, diskOut) => {
      const cols = (diskOut || '').trim().split(/\s+/)
      res.json({ cpu, mem, memPct, disk: { size: cols[1] || '—', used: cols[2] || '—', avail: cols[3] || '—', pct: cols[4] || '—' } })
    })
  })
})

// Server local time (for schedule display)
app.get('/api/servertime', (req, res) => {
  const now = new Date()
  res.json({
    hour: now.getHours(),
    minute: now.getMinutes(),
    display: now.toLocaleString()
  })
})

// ===== WORKSHOP DOWNLOAD STATUS =====

// `active` = live per-item progress parsed from the current log tail (byte-level %, while
// still downloading). `queue` = the persisted record of everything ever requested for this
// server (queued/installed/failed with timestamps) — this is what survives a manager restart
// and is what the "Queued for Download" UI section actually renders from.
app.get('/api/downloads', (req, res) => {
  const s = srv(req)
  exec('docker logs ' + s.container + ' --tail 2000', { maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => {
    const lines = ((out || '') + '\n' + (stderr || '')).split('\n')
    res.json({ active: parseDownloads(lines), queue: readQueue(s).slice().reverse() })
  })
})

// ===== NOTIFICATIONS =====

app.get('/api/notifications', (req, res) => {
  res.json(readNotifConfig())
})

app.put('/api/notifications', (req, res) => {
  const cfg = req.body
  if (typeof cfg.enabled !== 'boolean') return res.status(400).json({ error: 'Invalid config' })
  writeNotifConfig(cfg)
  res.json({ success: true })
})

app.post('/api/notifications/test', (req, res) => {
  const cfg = readNotifConfig()
  if (!cfg.token || !cfg.userKey) return res.status(400).json({ error: 'No credentials configured' })
  const data = querystring.stringify({ token: cfg.token, user: cfg.userKey, title: 'PZ Server Manager', message: 'Test notification from PZ Server Manager.' })
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

app.post('/api/discord/update', (req, res) => {
  updateDiscordStatus((err, data) => res.json({ success: !err, data, error: err ? err.message : null }))
})

// What the Discord card will actually show for "connect" + version — surfaced in the UI
// so it's clear these are auto-detected, not manually entered.
app.get('/api/discord/detected', (req, res) => {
  const s = srv(req)
  getExternalIp(ip => {
    getServerVersion(s, version => {
      let port = ''
      try { port = getIniValue(s, 'DefaultPort', '') } catch {}
      res.json({ externalIp: ip, port, version })
    })
  })
})

// ===== SCHEDULE =====

app.get('/api/schedule', (req, res) => res.json(readSchedule(srv(req))))

app.put('/api/schedule', (req, res) => {
  const s = srv(req)
  const { enabled, hour, minute, mode, intervalHours } = req.body
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Invalid' })
  const h = parseInt(hour)
  const m = parseInt(minute)
  if (isNaN(h) || h < 0 || h > 23) return res.status(400).json({ error: 'Invalid hour' })
  if (isNaN(m) || m < 0 || m > 59) return res.status(400).json({ error: 'Invalid minute' })
  const md = mode === 'interval' ? 'interval' : 'daily'
  const iv = parseInt(intervalHours)
  if (md === 'interval' && !INTERVAL_CHOICES.includes(iv)) return res.status(400).json({ error: 'Interval must be 2, 6, 12 or 24 hours' })
  writeSchedule(s, { enabled, mode: md, hour: h, minute: m, intervalHours: md === 'interval' ? iv : 24 })
  res.json({ success: true })
})

// ===== BACKUPS =====

app.get('/api/backups', (req, res) => {
  const s = srv(req)
  const dirs = backupDirs(s)
  try { fs.mkdirSync(dirs.manual, { recursive: true }) } catch {}
  res.json({
    startup: listBackupDir(dirs.startup),
    version: listBackupDir(dirs.version),
    manual: listBackupDir(dirs.manual)
  })
})

// Stream a fresh tar.gz backup to the client
app.get('/api/backups/create', (req, res) => {
  const s = srv(req)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = 'pz-backup-' + s.id + '-' + ts + '.tar.gz'
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"')
  res.setHeader('Content-Type', 'application/gzip')

  // Archive: world saves + player DB + all server config files.
  // Saves dir may not exist before first world gen — include what's there.
  const entries = ['db/servertest.db', 'Server']
  if (fs.existsSync(s.data + '/Saves/Multiplayer/servertest')) entries.unshift('Saves/Multiplayer/servertest')
  const tar = spawn('tar', ['-czf', '-', '-C', s.data, ...entries])

  tar.stdout.pipe(res)
  tar.stderr.on('data', d => console.error('[tar]', d.toString().trim()))
  tar.on('error', (e) => { console.error('[tar error]', e.message); if (!res.headersSent) res.status(500).end() })
  req.on('close', () => { try { tar.kill() } catch {} })
})

// Download an existing server backup zip/tar.gz
app.get('/api/backups/download', (req, res) => {
  const p = validBackupPath(srv(req), req.query.type, req.query.name)
  if (!p) return res.status(404).json({ error: 'Backup not found' })
  res.download(p)
})

// List contents of an existing backup (for inspection)
app.get('/api/backups/peek', (req, res) => {
  const p = validBackupPath(srv(req), req.query.type, req.query.name)
  if (!p) return res.status(404).json({ error: 'Backup not found' })
  const name = req.query.name
  const cmd = name.endsWith('.tar.gz')
    ? 'tar -tzf "' + p + '" 2>&1 | head -50'
    : 'unzip -l "' + p + '" 2>&1 | head -50'
  exec(cmd, { timeout: 30000 }, (err, stdout) => {
    res.json({ contents: stdout || '(empty)' })
  })
})

// Restore from an existing server backup
app.post('/api/backups/restore', (req, res) => {
  const s = srv(req)
  const { type, name } = req.body || {}
  const p = validBackupPath(s, type, name)
  if (!p) return res.status(404).json({ error: 'Backup not found' })

  const cmd = name.endsWith('.tar.gz')
    ? 'tar -xzf "' + p + '" -C ' + s.data + '/'
    : 'unzip -o "' + p + '" -d ' + s.data + '/'

  exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: err.message, detail: (stderr || '').slice(0, 500) })
    res.json({ success: true })
  })
})

// Upload a backup file and restore from it
// Accepts raw application/octet-stream body; client sets X-Backup-Ext header to 'zip' or 'tar.gz'
app.post('/api/backups/upload', (req, res) => {
  const s = srv(req)
  const rawExt = (req.headers['x-backup-ext'] || 'zip').toLowerCase().replace(/[^a-z.]/g, '')
  const ext = rawExt === 'tar.gz' ? 'tar.gz' : 'zip'
  const tempPath = '/tmp/pz-restore-upload-' + s.id + '.' + (ext === 'tar.gz' ? 'tar_gz' : 'zip')
  const ws = fs.createWriteStream(tempPath)

  req.pipe(ws)

  ws.on('finish', () => {
    const cmd = ext === 'tar.gz'
      ? 'tar -xzf "' + tempPath + '" -C ' + s.data + '/'
      : 'unzip -o "' + tempPath + '" -d ' + s.data + '/'

    exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
      fs.unlink(tempPath, () => {})
      if (err) return res.status(500).json({ error: err.message, detail: (stderr || '').slice(0, 500) })
      res.json({ success: true })
    })
  })

  ws.on('error', (e) => res.status(500).json({ error: e.message }))
  req.on('error', (e) => { ws.destroy(); res.status(500).json({ error: e.message }) })
})


// ===== ONLINE PLAYERS =====

app.get('/api/players/online', (req, res) => {
  const players = onlinePlayersFor(srv(req))
  res.json({ online: players.length, players })
})

app.listen(7777, () => console.log('PZ Server Manager on :7777 — servers: ' + allServers().map(s => s.id).join(', ')))
