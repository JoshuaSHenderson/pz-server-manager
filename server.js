const express = require('express')
const { exec, execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')
const querystring = require('querystring')

const app = express()
app.use(express.json())
app.use(express.static('public'))

const INI_PATH = '/pz-data/Server/servertest.ini'
const MODS_DIR = '/pz-data/mods'
const WORKSHOP_DIR = '/workshop/content/108600'
const DB_PATH = '/pz-data/db/servertest.db'
const NOTIF_PATH = '/pz-data/notifications.json'

// --- INI helpers ---
function readIni() { return fs.readFileSync(INI_PATH, 'utf8') }
function getIniList(key) {
  const m = readIni().match(new RegExp(`^${key}=(.*)$`, 'm'))
  return m ? m[1].split(';').filter(Boolean) : []
}
function setIniList(key, values) {
  const ini = readIni().replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${values.join(';')}`)
  fs.writeFileSync(INI_PATH, ini)
}

// --- INI single-value helpers ---
function getIniValue(key, def) {
  const m = readIni().match(new RegExp('^' + key + '=(.*)$', 'm'))
  return m ? m[1].trim() : (def !== undefined ? def : '')
}
function setIniValue(key, value) {
  const ini = readIni()
  const re = new RegExp('^' + key + '=.*$', 'm')
  const line = key + "=" + value
  fs.writeFileSync(INI_PATH, re.test(ini) ? ini.replace(re, line) : ini + "\n" + line)
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
function modFolders(workshopId) {
  const modsDir = path.join(WORKSHOP_DIR, workshopId, 'mods')
  if (!fs.existsSync(modsDir)) return []
  return fs.readdirSync(modsDir).filter(f => !/^\d+\.\d+$/.test(f) && findModInfo(path.join(modsDir, f)))
}
function modIdsFromWorkshop(workshopId) {
  const modsDir = path.join(WORKSHOP_DIR, workshopId, 'mods')
  const ids = []
  for (const folder of modFolders(workshopId)) {
    const info = findModInfo(path.join(modsDir, folder))
    if (info) {
      const m = fs.readFileSync(info, 'utf8').match(/^id=(.+)$/m)
      if (m) ids.push(m[1].trim())
    }
  }
  return ids
}
function modNamesFromWorkshop(workshopId) { return modFolders(workshopId) }

// --- DB helpers ---
function dbAll(sql) {
  try {
    const out = execSync('sqlite3 -json "' + DB_PATH + '" ' + JSON.stringify(sql))
    return JSON.parse(out.toString().trim() || '[]')
  } catch { return [] }
}
function dbRun(sql) {
  execSync('sqlite3 "' + DB_PATH + '" ' + JSON.stringify(sql))
}
function sanitizeUsername(u) { return u && /^[\w. -]{1,50}$/.test(u) }
const ACCESS_LEVELS = ['none', 'observer', 'gm', 'overseer', 'moderator', 'admin']

// --- Notification helpers ---
const DEFAULT_NOTIF = {
  enabled: false,
  token: '',
  userKey: '',
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
    serverIp: '',
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

function updateDiscordStatus(cb) {
  const cfg = readNotifConfig()
  if (!cfg.discord || !cfg.discord.enabled || !cfg.discord.webhookUrl) return cb && cb()
  const wh = parseWebhookUrl(cfg.discord.webhookUrl)
  if (!wh) return cb && cb()
  exec('docker inspect zomboid --format "{{.State.Status}}|{{.State.StartedAt}}"', (err, out) => {
    const parts = (out || '').trim().split('|')
    const isOnline = parts[0] === 'running'
    let body
    if (cfg.discord.richCard) {
      const serverName = getIniValue('PublicName') || getIniValue('ServerName') || 'Project Zomboid'
      const modCount = getIniList('WorkshopItems').length
      let uptime = '—'
      if (isOnline && parts[1]) {
        const ms = Date.now() - new Date(parts[1]).getTime()
        const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000)
        uptime = h > 0 ? h + 'h ' + m + 'm' : m + 'm'
      }
      const fields = [
        { name: 'Status', value: isOnline ? '🟢 **Online**' : '🔴 **Offline**', inline: true },
        { name: 'Uptime', value: uptime, inline: true },
        { name: 'Mods', value: String(modCount), inline: true }
      ]
      if (cfg.discord.serverIp) fields.push({ name: 'Connect', value: '`' + cfg.discord.serverIp + '`', inline: false })
      body = { embeds: [{ title: serverName, color: isOnline ? 5763719 : 15548997, fields, timestamp: new Date().toISOString() }] }
    } else {
      const template = cfg.discord.template || 'Project Zomboid Server: <ZomboidServerStats>'
      const content = template
        .replace('<ZomboidServerStats>', isOnline ? '🟢 Online' : '🔴 Offline')
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
  })
}

setInterval(updateDiscordStatus, 5 * 60 * 1000)

// --- Download state parser (shared by endpoint + background checker) ---
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

// --- Background monitors ---
let lastKnownStatus = null
let intentionalStop = false

// Crash detection: every 60s
setInterval(() => {
  exec('docker inspect zomboid --format "{{.State.Status}}"', (err, out) => {
    const status = (out || '').trim()
    const cfg = readNotifConfig()
    if (lastKnownStatus === 'running' && status !== 'running' && !intentionalStop) {
      if (cfg.enabled && cfg.events && cfg.events.serverCrash) {
        pushover('PZ Server Crashed', 'Server stopped unexpectedly. Container status: ' + status)
      }
    }
    intentionalStop = false
    lastKnownStatus = status
  })
}, 60000)

// Low disk: every 5 min
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

// Download complete: every 30s
let wasDownloading = false
setInterval(() => {
  const cfg = readNotifConfig()
  if (!cfg.enabled || !cfg.events || !cfg.events.downloadComplete) { wasDownloading = false; return }
  exec('docker logs zomboid --tail 500 2>&1', { maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
    const active = parseDownloads((out || '').split('\n'))
    const isDownloading = active.length > 0
    if (wasDownloading && !isDownloading) {
      pushover('PZ Mods Updated', 'All Workshop downloads complete. Restart server to apply mod updates.')
    }
    wasDownloading = isDownloading
  })
}, 30000)

// Player events: tail pz-data/Logs/*_user.txt (byte-position tracked, no spurious startup alerts)
// Patterns confirmed from live log: join=[fully-connected], leave=[disconnected player], death=[user X died at]
// Kick pattern: "X" kicked (follows same user.txt style as join/leave)
const PZ_LOG_DIR = '/pz-data/Logs'
let userLogPath = null
let userLogPos = 0

function findLatestUserLog() {
  try {
    return fs.readdirSync(PZ_LOG_DIR)
      .filter(f => f.endsWith('_user.txt'))
      .map(f => path.join(PZ_LOG_DIR, f))
      .sort((a, b) => fs.statSync(b).mtime - fs.statSync(a).mtime)[0] || null
  } catch { return null }
}

function pollUserLog() {
  const cfg = readNotifConfig()
  if (!cfg.enabled || !cfg.events) return
  const ev = cfg.events
  if (!ev.playerJoin && !ev.playerLeave && !ev.playerDied && !ev.playerKicked) return

  const latest = findLatestUserLog()
  if (!latest) return

  try {
    const size = fs.statSync(latest).size
    if (latest !== userLogPath) {
      // New file (server restarted) — seek to end, don't replay old events
      userLogPath = latest
      userLogPos = size
      return
    }
    if (size <= userLogPos) return

    const fd = fs.openSync(latest, 'r')
    const buf = Buffer.allocUnsafe(size - userLogPos)
    fs.readSync(fd, buf, 0, buf.length, userLogPos)
    fs.closeSync(fd)
    userLogPos = size

    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      let m
      // Join: [timestamp] STEAMID "Name" fully connected (x,y,z).
      if (ev.playerJoin && (m = line.match(/"([^"]+)" fully connected/))) {
        pushover('Player Joined', m[1] + ' joined the server'); continue
      }
      // Leave: [timestamp] STEAMID "Name" disconnected player (x,y,z).
      if (ev.playerLeave && (m = line.match(/"([^"]+)" disconnected player/))) {
        pushover('Player Left', m[1] + ' left the server'); continue
      }
      // Death: [timestamp] user Name died at (x,y,z) (pvp|non pvp).
      if (ev.playerDied && (m = line.match(/user (\S+) died at/))) {
        pushover('Player Died', m[1] + ' has died'); continue
      }
      // Kick: [timestamp] STEAMID "Name" kicked  OR  kicking Name from server
      if (ev.playerKicked) {
        m = line.match(/"([^"]+)" kicked/) || line.match(/kicking "?(\S+?)"? from server/i)
        if (m) { pushover('Player Kicked', m[1] + ' was kicked from the server'); continue }
      }
    }
  } catch {}
}

setInterval(pollUserLog, 10000)

// ===== SERVER CONTROL =====

app.get('/api/status', (req, res) => {
  exec('docker inspect zomboid --format "{{.State.Status}}|{{.State.StartedAt}}"', (err, out) => {
    if (err) return res.json({ status: 'unknown' })
    const [status, startedAt] = out.trim().split('|')
    res.json({ status, startedAt })
  })
})

app.post('/api/server/start', (req, res) => {
  exec('docker start zomboid', { timeout: 30000 }, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStart) pushover('PZ Server Started', 'Project Zomboid server is starting up.')
    }
    res.json({ success: ok, error: err?.message })
  })
})

app.post('/api/server/stop', (req, res) => {
  intentionalStop = true
  exec('docker stop zomboid', { timeout: 60000 }, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStop) pushover('PZ Server Stopped', 'Project Zomboid server has been stopped.')
    }
    res.json({ success: ok, error: err?.message })
  })
})

app.post('/api/server/restart', (req, res) => {
  intentionalStop = true
  exec('docker restart zomboid', { timeout: 60000 }, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStart) pushover('PZ Server Restarted', 'Project Zomboid server has been restarted.')
    }
    res.json({ success: ok, error: err?.message })
  })
})

// ===== LOGS =====

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const tail = Math.min(parseInt(req.query.tail) || 300, 2000)
  const child = spawn('docker', ['logs', 'zomboid', '--tail', String(tail), '--follow', '--timestamps'])
  const send = l => { if (l.trim()) res.write('data: ' + JSON.stringify(l) + '\n\n') }
  child.stdout.on('data', d => d.toString().split('\n').forEach(send))
  child.stderr.on('data', d => d.toString().split('\n').forEach(send))
  child.on('close', () => res.end())
  req.on('close', () => child.kill())
})

// ===== PLAYERS / WHITELIST =====

app.get('/api/players', (req, res) => {
  const players = dbAll('SELECT username, accesslevel, admin, moderator, banned, lastConnection, displayName FROM whitelist ORDER BY lastConnection DESC')
  res.json({ players })
})

app.post('/api/players', (req, res) => {
  const { username, accesslevel = 'none' } = req.body
  if (!sanitizeUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  if (!ACCESS_LEVELS.includes(accesslevel)) return res.status(400).json({ error: 'Invalid accesslevel' })
  const u = username.replace(/'/g, "''")
  const isAdmin = accesslevel === 'admin' ? 1 : 0
  const isMod = accesslevel === 'moderator' ? 1 : 0
  try {
    dbRun('INSERT OR IGNORE INTO whitelist (username, accesslevel, admin, moderator, banned, world) VALUES (\'' + u + '\', \'' + accesslevel + '\', ' + isAdmin + ', ' + isMod + ', 0, \'servertest\')')
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/players/:username', (req, res) => {
  const { username } = req.params
  if (!sanitizeUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  const { accesslevel, banned } = req.body
  const fields = []
  if (accesslevel !== undefined) {
    if (!ACCESS_LEVELS.includes(accesslevel)) return res.status(400).json({ error: 'Invalid accesslevel' })
    fields.push('accesslevel=\'' + accesslevel + '\'', 'admin=' + (accesslevel === 'admin' ? 1 : 0), 'moderator=' + (accesslevel === 'moderator' ? 1 : 0))
  }
  if (banned !== undefined) fields.push('banned=' + (banned ? 1 : 0))
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' })
  const u = username.replace(/'/g, "''")
  try {
    dbRun('UPDATE whitelist SET ' + fields.join(', ') + ' WHERE username=\'' + u + '\'')
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/players/:username', (req, res) => {
  const { username } = req.params
  if (!sanitizeUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  const u = username.replace(/'/g, "''")
  try {
    dbRun('DELETE FROM whitelist WHERE username=\'' + u + '\'')
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ===== MODS =====

app.get('/api/mods', (req, res) => {
  const workshopIds = getIniList('WorkshopItems')
  const mods = workshopIds.map(wid => ({
    workshopId: wid,
    modIds: modIdsFromWorkshop(wid),
    modFolders: modNamesFromWorkshop(wid),
  }))
  res.json({ mods })
})

app.post('/api/mods/install', (req, res) => {
  const { workshopId } = req.body
  if (!workshopId || !/^\d+$/.test(workshopId)) return res.status(400).json({ error: 'Invalid workshopId' })
  const cmd = 'docker exec zomboid /home/steam/steamcmd/steamcmd.sh +force_install_dir /home/steam/pz-dedicated +login anonymous +workshop_download_item 108600 ' + workshopId + ' +quit'
  exec(cmd, { timeout: 300000 }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: 'SteamCMD failed', detail: stderr })
    // +force_install_dir puts workshop files in pz-dedicated, not the mounted Steam path — copy over
    try {
      execSync('docker exec zomboid sh -c ' + JSON.stringify(
        'cp -rn /home/steam/pz-dedicated/steamapps/workshop/content/108600/' + workshopId +
        ' /home/steam/Steam/steamapps/workshop/content/108600/ 2>/dev/null; true'
      ), { timeout: 30000 })
    } catch(e) {}
    const modsDir = path.join(WORKSHOP_DIR, workshopId, 'mods')
    const copiedFolders = []
    if (fs.existsSync(modsDir)) {
      for (const folder of fs.readdirSync(modsDir)) {
        if (/^\d+\.\d+$/.test(folder)) continue
        const src = path.join(modsDir, folder)
        const dest = path.join(MODS_DIR, folder)
        try { if (!fs.existsSync(dest)) { execSync('cp -r "' + src + '" "' + dest + '"'); copiedFolders.push(folder) } } catch {}
      }
    }
    const newModIds = modIdsFromWorkshop(workshopId)
    setIniList('WorkshopItems', [...new Set([...getIniList('WorkshopItems'), workshopId])])
    setIniList('Mods', [...new Set([...getIniList('Mods'), ...newModIds])])
    res.json({ success: true, workshopId, modIds: newModIds, copiedFolders })
  })
})

app.delete('/api/mods/:workshopId', (req, res) => {
  const { workshopId } = req.params
  const removedIds = modIdsFromWorkshop(workshopId)
  const removedFolders = modNamesFromWorkshop(workshopId)
  for (const folder of removedFolders) {
    const dest = path.join(MODS_DIR, folder)
    if (fs.existsSync(dest)) try { execSync('rm -rf "' + dest + '"') } catch {}
  }
  setIniList('WorkshopItems', getIniList('WorkshopItems').filter(id => id !== workshopId))
  setIniList('Mods', getIniList('Mods').filter(id => !removedIds.includes(id)))
  res.json({ success: true, workshopId, removedIds, removedFolders })
})

// ===== SERVER CONFIG =====

const CONFIG_FIELDS = [
  'PublicName','Password','MaxPlayers','PVP','SafetySystem','Open','Public',
  'PauseEmpty','GlobalChat','VoiceEnable','HoursForLootRespawn','SaveWorldEveryMinutes'
]

app.get('/api/config', (req, res) => {
  const cfg = {}
  for (const k of CONFIG_FIELDS) cfg[k] = getIniValue(k)
  res.json(cfg)
})

app.put('/api/config', (req, res) => {
  const updates = req.body
  for (const k of CONFIG_FIELDS) {
    if (updates[k] !== undefined) setIniValue(k, updates[k])
  }
  res.json({ success: true })
})

// ===== SYSTEM STATS =====

app.get('/api/sysinfo', (req, res) => {
  exec('docker stats zomboid --no-stream --format "{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}"', (err, out) => {
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

// ===== WORKSHOP DOWNLOAD STATUS =====

app.get('/api/downloads', (req, res) => {
  exec('docker logs zomboid --tail 2000', { maxBuffer: 8 * 1024 * 1024 }, (err, out, stderr) => {
    const lines = ((out || '') + '\n' + (stderr || '')).split('\n')
    res.json({ active: parseDownloads(lines) })
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

app.listen(7777, () => console.log('PZ Server Manager on :7777'))
