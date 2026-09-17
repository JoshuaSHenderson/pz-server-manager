const express = require('express')
const { exec, execSync, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const https = require('https')
const querystring = require('querystring')
const crypto = require('crypto')
const net = require('net')
const { droppedItems } = require('./lib/prune')
const { parseDepList, analyzeDependencies, sortIssues } = require('./lib/deps')
const { validateReorder, moveItem } = require('./lib/order')
const { outdatedItems, seedState, dueForCheck, shouldRestart, shouldDownload } = require('./lib/autoupdate')
const { readyCheck } = require('./lib/ready')
const { reconcileMods } = require('./lib/modload')
const { analyzeModDrift, planRepair, versionRank } = require('./lib/moddrift')
const { allExcludes, addExclude, removeExclude, isExcluded, removalTargets, validFolder, validWorkshopId } = require('./lib/excludes')
const { saveThenGoDown } = require('./lib/save')
const { makeState: makePlayerState, applyLine: applyPlayerLine, replay: replayPlayerLog, onlineNames: playerNames, parseConnectedCount } = require('./lib/players')
const auth = require('./src/auth')
const archive = require('./src/services/archive')
const { qs, header, installErrorHandler, installProcessGuards } = require('./src/http')
const docker = require('./src/infra/docker')
const disk = require('./src/infra/disk')
const db = require('./src/infra/db')
const { humanBytes } = disk
const { ACCESS_LEVELS } = db
const whitelist = require('./src/services/whitelist')
const { rconCommand } = require('./src/infra/rcon')
const { logFor } = require('./src/log')
const reinstallState = require('./src/services/reinstall-state')
const { QUARANTINE_KEEP: REINSTALL_QUARANTINE_KEEP, DOWNLOAD_TIMEOUT_MS: REINSTALL_DOWNLOAD_TIMEOUT_MS } = reinstallState
const registry = require('./src/registry/servers')
const { readCollections, writeCollections, upsertCollection } = require('./src/services/collections')
const { readExcludes, writeExcludes, folderProviders, applyExcludes } = require('./src/services/excludes')
const { updateDiscordStatus, discordRequest, parseWebhookUrl, collectionLinks } = require('./src/services/discord')
const { getExternalIp } = require('./src/infra/net')
const { getServerVersion } = require('./src/services/version')
const { onlinePlayersFor, playerCountFor, pollUserLog } = require('./src/services/playerlog')
const {
  readNotifConfig, writeNotifConfig, publicNotifConfig, sanitizeDiscord, pushover, pushoverFor,
  DEFAULT_NOTIF,
} = require('./src/services/notify')
const {
  readQueue, writeQueue, queueAdd, hasModContent, registerInstalledMod, steamcmdDownload,
  stripAnsi, explainDownloadFailure, reconcileDownloads, parseDownloads,
} = require('./src/services/downloads')
const { refreshServers, serverLabel, serverRow, srv, readServerConfig, writeServerConfig } = registry
const allServers = registry.all
const {
  steamFileDetails, steamCollectionDetails, getCollectionChildren, resolveCollectionLeaves,
  getTitles, getCachedTags, fetchWorkshopTimes,
} = require('./src/infra/steam')
const {
  parseSandbox, validateSandboxValue, formatSandboxValue, sandboxStructureOk, SANDBOX_KEY_RE,
} = require('./src/domain/sandbox')
const {
  buildModInventory, buildsIdentical, staleLocalCopies, modDriftReport,
  itemHasContent, loadableModIds, missingProviders,
} = require('./src/domain/inventory')
const {
  findModInfo, preferredModInfo, itemModsRoot, modFolders, modIdsFromWorkshop,
  modNamesFromWorkshop, modIdsByFolder, duplicateModIds, installedModMeta,
  serverBuildRank, folderIds,
} = require('./src/domain/modinfo')
const {
  readIni, getIniList, setIniList, getIniValue, setIniValue, getFullIni, CONFIG_FIELDS, INI_KEY_RE,
} = require('./src/domain/ini')
const {
  iniPath, modsDir, dbPath, logDir, schedPath, workshopContent, installContent, backupDirs,
  collectionsPath, queuePath, excludesPath, reinstallDir, modOrderBackupDir, depIgnorePath,
  autoUpdatePath, autoSyncPath, sandboxPath,
} = require('./src/paths')

installProcessGuards()

const app = express()
app.use(express.json())

// The built SPA, served before authentication so the login form can load at all. It carries no
// secrets — every byte of state it renders comes from an /api call that is authenticated.
// WEB_DIST exists so `npm run dev` can point this at Vite's output while iterating.
const WEB_DIST = process.env.WEB_DIST || 'dist'
app.use(express.static(WEB_DIST))

// Must be installed before any route below it: Express runs middleware in registration order, so
// anything registered above this line would be reachable without a token.
const MANAGER_AUTH = auth.install(app)

refreshServers()
setInterval(refreshServers, 60000)

app.use('/api', registry.guard)



setInterval(updateDiscordStatus, 5 * 60 * 1000)

// --- Background monitors (all per-server) ---
const monitorState = {} // [serverId] = { lastKnownStatus, intentionalStop, wasDownloading, userLogPath, userLogPos }
function mstate(s) {
  if (!monitorState[s.id]) monitorState[s.id] = { lastKnownStatus: null, intentionalStop: false, wasDownloading: false, userLogPath: null, userLogPos: 0 }
  return monitorState[s.id]
}

// "Started" only means the container is up. PZ then loads assets, mods and the world for a long
// while — on this server, minutes — and rejects connections until it prints this. That is the
// moment worth telling people about, not the container transition.
const SERVER_READY_MARKER = '*** SERVER STARTED ***'
const READY_WAIT_MS = 45 * 60 * 1000

// Start waiting for the readiness marker of the run that is about to begin.
//
// The run must have started *after* this instant. Callers issue their `docker restart` on the very
// next line, and a restart takes a few seconds to come back — so for those seconds `docker inspect`
// still reports the *old* run's StartedAt, and `docker logs --since <that>` still contains the old
// run's marker. Watching without this floor announced "ready" within seconds of every restart, and
// measured the wait from the previous boot: on this server that read as 153m 8s.
//
// alreadyRunning=true is for the crash monitor, which notices a container that is already back up.
// There the current run *is* the one to watch, so no floor applies.
function markAwaitingReady(s, alreadyRunning) {
  const st = mstate(s)
  st.awaitingReady = true
  st.awaitingSince = Date.now()
  st.readyMinStart = alreadyRunning ? 0 : Date.now()
}

// Crash monitor
setInterval(() => {
  for (const s of allServers()) {
    docker.inspect(s.container, '{{.State.Status}}', (err, out) => {
      const status = (out || '').trim()
      const st = mstate(s)
      const cfg = readNotifConfig()
      if (st.lastKnownStatus === 'running' && status !== 'running' && !st.intentionalStop && !reinstallState.busy(s)) {
        if (cfg.enabled && cfg.events && cfg.events.serverCrash) {
          pushoverFor(s, 'PZ Server Crashed', 'Server stopped unexpectedly. Container status: ' + status)
        }
      }
      // Any transition into running — ours or a crash-restart — starts the wait for readiness.
      // Skipped on the manager's first observation so restarting the manager alone can't fire it.
      if (st.lastKnownStatus && st.lastKnownStatus !== 'running' && status === 'running') markAwaitingReady(s, true)
      st.intentionalStop = false
      st.lastKnownStatus = status
    })
  }
}, 60000)

// Watches for the readiness marker after a start/restart. Only looks at logs written since the
// container came up, so the previous run's marker can never be mistaken for this one's.
setInterval(() => {
  for (const s of allServers()) {
    const st = mstate(s)
    if (!st.awaitingReady) continue
    if (Date.now() - (st.awaitingSince || 0) > READY_WAIT_MS) {
      st.awaitingReady = false
      console.log('[ready] ' + serverLabel(s) + ': gave up waiting for the ready marker')
      continue
    }
    docker.inspect(s.container, '{{.State.StartedAt}}', (e1, startedAt) => {
      const since = (startedAt || '').trim()
      if (!since) return
      // -t so the marker carries the moment it was printed — see ready.js. The match and the
      // "last one wins" are done on the text rather than by `| grep -F ... | tail -1`.
      docker.logsContaining(s.container, ['-t', '--since', since], SERVER_READY_MARKER,
        { maxBuffer: 4 * docker.MB }, (err, lines) => {
          const verdict = readyCheck({ startedAt: since, readyMinStart: st.readyMinStart, markerLine: lines[lines.length - 1] })
          if (!verdict.ready) return
          if (!st.awaitingReady) return   // another tick won the race
          st.awaitingReady = false
          console.log('[ready] ' + serverLabel(s) + ': accepting players after ' + verdict.took)
          const cfg = readNotifConfig()
          if (cfg.enabled && cfg.events && cfg.events.serverReady !== false) {
            pushoverFor(s, 'PZ Server Ready', 'Finished loading after ' + verdict.took + ' — accepting players now.')
          }
          reportDeadMods(s, since)
          reportModDrift(s)
        })
    })
  }
}, 20000)

// Enabled mods no client can download — see moddrift.js. Deliberately separate from
// reportDeadMods(): these load perfectly well on the server, so the boot log shows nothing wrong,
// and the first symptom is a player being told the mod "is not installed" with an empty
// WorkshopID. Checked at boot so it surfaces before someone tries to join, not after.
function reportModDrift(s) {
  let report
  try { report = modDriftReport(s) } catch (e) { return console.error('[drift]', e.message) }
  if (report.stale.length) {
    logFor(s, report.stale.length + ' local mod copy(ies) behind the Workshop: ' +
      report.stale.map(t => t.folder + ' ' + (t.local || 'none') + '->' + t.workshop).join(', '))
  }
  if (!report.issues.length) {
    console.log('[drift] ' + serverLabel(s) + ': all ' + report.ok.length + ' enabled mods are obtainable by clients')
    return
  }
  const list = report.issues.map(i => i.id + (i.suggest.length === 1 ? ' -> ' + i.suggest[0] : ' (' + i.kind + ')')).join(', ')
  logFor(s, 'clients cannot download ' + report.issues.length + ' enabled mod(s): ' + list)
  const cfg = readNotifConfig()
  if (cfg.enabled && cfg.events && cfg.events.modDrift !== false) {
    pushoverFor(s, 'PZ Mods Unobtainable',
      report.issues.length + ' enabled mod(s) cannot be downloaded by players: ' + list)
  }
}

// Mods that are enabled but never registered — see modload.js for why the disk cannot answer this
// and the boot log can. Runs once the ready marker is up, because by then the mod phase is over and
// the log is complete for this run.
//
// An empty result means "no information" to reconcileMods, not "every mod is dead", so a failed or
// truncated read stays silent instead of paging. That was true of `grep`'s exit 1 and stays true of
// filtering the text: both hand back nothing.
function reportDeadMods(s, since) {
  docker.logsContaining(s.container, ['--since', since], '> loading ',
    { maxBuffer: 8 * docker.MB }, (err, lines) => {
      const r = reconcileMods(getIniList(s, 'Mods'), lines.join('\n'))
      if (!r.known) return
      if (!r.dead.length) {
        console.log('[mods] ' + serverLabel(s) + ': all ' + r.loaded.length + ' enabled mods loaded')
        return
      }
      const list = r.dead.join(', ')
      logFor(s, 'enabled but did not load: ' + list)
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.modsNotLoaded !== false) {
        pushoverFor(s, 'PZ Mods Not Loaded',
          r.dead.length + ' enabled mod' + (r.dead.length > 1 ? 's' : '') + ' did not load: ' + list)
      }
    })
}

// Low disk monitor (shared filesystem — one check, one alert)
let lowDiskAlerted = false
setInterval(() => {
  const cfg = readNotifConfig()
  if (!cfg.enabled || !cfg.events || !cfg.events.lowDisk) return
  disk.df('/workshop', cols => {
    const availStr = cols.avail
    // The threshold comparison reads the real figure rather than re-parsing df's suffix. The old
    // parse understood only G, M and T, and answered 0 for anything else — so on a filesystem
    // reporting K or P the alert silently never fired, which is exactly when it would matter.
    const availGB = disk.freeBytes('/workshop') / (1024 * 1024 * 1024)
    const threshold = cfg.lowDiskThresholdGB || 5
    if (availGB > 0 && availGB < threshold && !lowDiskAlerted) {
      lowDiskAlerted = true
      pushover('PZ Server: Low Disk Space', availStr + ' remaining on server (' + cols.pct + ' used). Free up space before it fills.')
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
    docker.logs(s.container, ['--tail', '500'], { maxBuffer: 4 * docker.MB }, (err, out) => {
      const active = parseDownloads((out || '').split('\n'))
      const isDownloading = active.length > 0
      if (st.wasDownloading && !isDownloading) {
        pushoverFor(s, 'PZ Mods Updated', 'All Workshop downloads complete. Restart server to apply mod updates.')
      }
      st.wasDownloading = isDownloading
    })
  }
}, 30000)

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


// Every path that takes a container down goes through here — see save.js for why a plain
// `docker stop` never gets the world written.
function saveThen(s, next) {
  saveThenGoDown({
    rcon: (cmd, cb) => rconCommand(s, cmd, cb),
    wait: (ms, cb) => setTimeout(cb, ms),
    log: (m) => console.log('[RCON] ' + s.name + ' ' + m),
  }, next)
}

// Every path that brings a container up goes through here, the same way every path that takes one
// down goes through saveThen(). The sweep has to run on each boot, not once: Steam re-ships an
// excluded folder on every download, and the only moment it matters is when PZ scans for mods.
// A failed sweep must never block a restart — the server coming back up wins.
function bringUp(s, action, timeout, cb) {
  try { applyExcludes(s) }
  catch (e) { console.error('[excludes] sweep failed for ' + s.name + ':', e.message) }
  docker.control(action, s.container, timeout, cb)
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
    // A reinstall owns the container while it runs — it stops it, moves files, and starts it
    // again. A scheduled restart landing in that window would start the server mid-swap.
    if (reinstallState.busy(s)) { console.log('[Schedule] ' + s.name + ': skipped, a mod reinstall is in progress'); continue }

    const minutesBefore = minutesUntilRestart(sched, totalNow)

    if (minutesBefore === 0 && lastRestartMinute[s.id] !== totalNow) {
      lastRestartMinute[s.id] = totalNow
      console.log('[Schedule] ' + s.name + ' scheduled restart triggered at', now.toLocaleTimeString())
      mstate(s).intentionalStop = true
      saveThen(s, () => bringUp(s, 'restart', 90000, (err) => {
        if (err) return console.error('[Schedule] ' + s.name + ' restart failed:', err.message)
        const desc = sched.mode === 'interval'
          ? 'Server restarted on schedule (every ' + sched.intervalHours + 'h).'
          : 'Server restarted on schedule at ' + (parseInt(sched.hour) || 4) + ':' + String(parseInt(sched.minute) || 0).padStart(2, '0')
        pushoverFor(s, 'PZ Scheduled Restart', desc)
      }))
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
      .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
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

app.get('/api/servers', (req, res) => {
  res.json({
    default: registry.defaultId(),
    servers: allServers().map(s => serverRow(s)),
    hidden: registry.hidden().map(s => serverRow(s, { hidden: true })),
    stale: registry.stale().map(s => ({
      id: s.id || s.container, name: s.name || s.container, container: s.container,
      state: 'missing', discovered: false, managed: false,
    })),
  })
})

// Manually re-scans for PZ containers (in case one was added since the last 60s auto-refresh).
app.post('/api/servers/refresh', (req, res) => {
  refreshServers()
  res.json({ success: true, count: allServers().length })
})

const anyServerById = id => registry.anyById(id) || null

// Rename / set connect / hide / make default. One endpoint, all persisted to servers.json.
app.put('/api/servers/:id', (req, res) => {
  const target = anyServerById(req.params.id)
  if (!target) return res.status(404).json({ error: 'No such server: ' + req.params.id })
  const { name, connect, hidden, makeDefault, id: newId } = req.body || {}
  if (newId !== undefined && !/^[A-Za-z0-9._-]{1,40}$/.test(newId)) {
    return res.status(400).json({ error: 'Id must be 1-40 chars of letters, numbers, dot, dash or underscore.' })
  }
  if (newId && newId !== target.id && anyServerById(newId)) {
    return res.status(409).json({ error: 'Id "' + newId + '" is already in use.' })
  }

  const cfg = readServerConfig()
  const o = Object.assign({}, cfg.overrides[target.container])
  if (newId !== undefined) o.id = newId || target.container
  if (name !== undefined) o.name = name.trim()
  if (connect !== undefined) o.connect = connect.trim()
  cfg.overrides[target.container] = o

  const set = new Set(cfg.hidden || [])
  if (hidden === true) set.add(target.container)
  if (hidden === false) set.delete(target.container)
  cfg.hidden = [...set]

  if (makeDefault) cfg.default = o.id || target.id
  // Hiding the default would leave the picker pointing at nothing.
  if (cfg.hidden.includes(target.container) && cfg.default === (o.id || target.id)) cfg.default = ''

  writeServerConfig(cfg)
  refreshServers()
  res.json({ success: true, default: registry.defaultId(), servers: allServers().map(s => serverRow(s)) })
})

// Forget a server: drops its saved override and un-hides it. For a stale entry (container gone)
// this removes it for good; for a live one it just resets it back to auto-discovered defaults.
app.delete('/api/servers/:id', (req, res) => {
  const target = anyServerById(req.params.id)
  if (!target) return res.status(404).json({ error: 'No such server: ' + req.params.id })
  const cfg = readServerConfig()
  delete cfg.overrides[target.container]
  cfg.hidden = (cfg.hidden || []).filter(c => c !== target.container)
  if (cfg.default === target.id) cfg.default = ''
  writeServerConfig(cfg)
  refreshServers()
  const stillThere = !!anyServerById(target.id)
  res.json({ success: true, removed: !stillThere, default: registry.defaultId() })
})

// ===== SERVER CONTROL =====

app.get('/api/status', (req, res) => {
  const s = srv(req)
  docker.inspect(s.container, '{{.State.Status}}|{{.State.StartedAt}}', (err, out) => {
    if (err) return res.json({ status: 'unknown' })
    const [status, startedAt] = out.split('|')
    res.json({ status, startedAt, server: s.id })
  })
})

app.post('/api/server/start', (req, res) => {
  const s = srv(req)
  logFor(s, 'start requested via UI')
  markAwaitingReady(s)
  bringUp(s, 'start', 30000, (err) => {
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
  logFor(s, 'stop requested via UI')
  mstate(s).intentionalStop = true
  saveThen(s, () => docker.control('stop', s.container, 60000, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStop) pushoverFor(s, 'PZ Server Stopped', 'Project Zomboid server has been stopped.')
    }
    res.json({ success: ok, error: err?.message })
  }))
})

app.post('/api/server/restart', (req, res) => {
  const s = srv(req)
  logFor(s, 'restart requested via UI')
  mstate(s).intentionalStop = true
  markAwaitingReady(s)
  saveThen(s, () => bringUp(s, 'restart', 60000, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStart) pushoverFor(s, 'PZ Server Restarted', 'Project Zomboid server has been restarted.')
    }
    res.json({ success: ok, error: err?.message })
  }))
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
    saveThen(s, () => bringUp(s, 'restart', 90000, () => {}))
  }, delayMin * 60000)
})

// ===== LOGS =====

// Server-sent-events tail of any container's log. Shared by the PZ server log and this
// manager's own log so the two can't drift in behaviour.
function streamContainerLogs(res, container, tailArg) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const tail = Math.min(parseInt(tailArg) || 300, 2000)
  const child = docker.logStream(container, tail)
  const send = l => { if (l.trim()) res.write('data: ' + JSON.stringify(l) + '\n\n') }
  child.stdout.on('data', d => d.toString().split('\n').forEach(send))
  child.stderr.on('data', d => d.toString().split('\n').forEach(send))
  child.on('close', () => res.end())
  res.on('close', () => child.kill())
}

app.get('/api/logs', (req, res) => {
  streamContainerLogs(res, srv(req).container, req.query.tail)
})

// This manager's own container id. Inside Docker, `hostname` is the short container id, which
// `docker logs` accepts — the same trick ownMounts() uses to find our own bind mounts.
function ownContainerId() { return docker.ownId() }

// The manager's own output: Express request errors, SteamCMD launch failures, download
// reconciliation, collection auto-sync, RCON and schedule activity. Separate from the PZ server
// log because when a mod fails to install, the reason is almost always in here, not in the game
// server's log.
app.get('/api/manager-logs', (req, res) => {
  const id = ownContainerId()
  if (!id) return res.status(500).json({ error: 'Could not determine own container id' })
  streamContainerLogs(res, id, req.query.tail)
})

// ===== PLAYERS / WHITELIST =====

app.get('/api/players', (req, res) => {
  res.json({ players: whitelist.list(srv(req)) })
})

app.post('/api/players', (req, res) => {
  const s = srv(req)
  const { username, accesslevel = 'none' } = req.body || {}
  if (!db.validUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  if (!ACCESS_LEVELS.includes(accesslevel)) return res.status(400).json({ error: 'Invalid accesslevel' })
  try {
    whitelist.add(s, username, accesslevel)
    logFor(s, 'whitelisted "' + username + '" as ' + accesslevel)
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.patch('/api/players/:username', (req, res) => {
  const s = srv(req)
  const { username } = req.params
  if (!db.validUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  const { accesslevel, banned } = req.body || {}
  try {
    const r = whitelist.update(s, username, { accesslevel, banned })
    if (r.ok !== true) return res.status(400).json({ error: r.error })
    logFor(s, 'updated "' + username + '"' +
      (accesslevel !== undefined ? ' accesslevel=' + accesslevel : '') +
      (banned !== undefined ? (banned ? ' banned' : ' unbanned') : ''))
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.delete('/api/players/:username', (req, res) => {
  const s = srv(req)
  const { username } = req.params
  if (!db.validUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  try {
    whitelist.remove(s, username)
    logFor(s, 'removed "' + username + '" from the whitelist')
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

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

  // A Workshop item can ship several mod ids (Authentic Z packs Current/Lite/Backpacks+ into one),
  // and Mods= decides which of them the server actually loads. Report that per id so the UI can
  // toggle them individually instead of only offering to delete the whole item.
  const modsList = getIniList(s, 'Mods')
  const enabledIds = new Set(modsList)
  // Position in Mods= is load order. A Workshop item can ship several mod ids, so an item can
  // occupy several positions — report each, and the earliest for sorting.
  const orderIndex = {}
  modsList.forEach((id, i) => { orderIndex[id] = i })

  const base = workshopIds.map(wid => {
    const modIds = modIdsFromWorkshop(s, wid)
    const folders = modNamesFromWorkshop(s, wid)
    const q = qById[wid]
    let status = 'ok'
    if (!modIds.length) status = (q && q.status === 'collection') ? 'collection' : 'missing'
    const enabled = modIds.filter(id => enabledIds.has(id))
    const positions = enabled.map(id => orderIndex[id])
    return {
      workshopId: wid, modIds, modFolders: folders, status,
      enabledIds: enabled,
      // 1-based to match what the load-order editor shows.
      orderPositions: positions.map(i => i + 1),
      minOrder: positions.length ? Math.min.apply(null, positions) + 1 : null,
      loadOrderTotal: modsList.length,
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
        tags: getCachedTags(m.workshopId),
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

// Toggle one mod id in Mods= without touching WorkshopItems or any files on disk. Needed because
// variant packs ship mutually exclusive mods in a single Workshop item — Authentic Z's Current and
// Lite both register the same az:* item_body_location ids, so loading both throws
// "Tried to register duplicate object" and kills the client's Lua reset on connect. Deleting the
// item to drop one variant would take the others' files with it.
// Re-enabling appends to the end of Mods= (same as install does); load order is not preserved.
app.post('/api/mods/enabled', (req, res) => {
  const s = srv(req)
  const { modId, enabled } = req.body || {}
  if (typeof modId !== 'string' || !modId) return res.status(400).json({ error: 'modId required' })
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' })
  // Only ids belonging to an installed Workshop item may be written, so a stale UI can't inject
  // a name the server would then fail to load.
  const known = new Set(getIniList(s, 'WorkshopItems').flatMap(wid => modIdsFromWorkshop(s, wid)))
  if (!known.has(modId)) return res.status(400).json({ error: 'Unknown mod id: ' + modId })
  const rest = getIniList(s, 'Mods').filter(id => id !== modId)
  setIniList(s, 'Mods', enabled ? [...rest, modId] : rest)
  logFor(s, (enabled ? 'enabled' : 'disabled') + ' mod "' + modId + '" (' + (enabled ? rest.length + 1 : rest.length) + ' loaded)')
  res.json({ success: true, modId, enabled })
})

// --- Mod id drift (see moddrift.js) ---

// Dry run. Lists every enabled mod a client could not download, and what to rename it to.
app.get('/api/mods/drift', (req, res) => res.json(modDriftReport(srv(req))))

// Apply renames. Refuses anything the report did not suggest, and refuses a rename between two
// different builds unless the caller has seen the item cost and passed acceptItemLoss.
app.post('/api/mods/drift/repair', (req, res) => {
  const s = srv(req)
  const { remaps, acceptItemLoss } = req.body || {}
  if (!Array.isArray(remaps) || !remaps.length) return res.status(400).json({ error: 'remaps required' })

  const report = modDriftReport(s)
  const byId = new Map(report.issues.map(i => [i.id, i]))
  const unsafe = remaps
    .map(r => byId.get(String((r || {}).from || '').trim()))
    .filter(i => i && i.buildsIdentical === false)
  if (unsafe.length && !acceptItemLoss) {
    return res.status(409).json({
      error: 'Different builds — renaming these makes the game load different scripts, and items ' +
             'whose ids no longer exist are discarded. Re-send with acceptItemLoss:true to proceed.',
      needsConfirmation: unsafe.map(i => ({ id: i.id, folder: i.folder, suggest: i.suggest })),
    })
  }

  const mods = getIniList(s, 'Mods')
  const plan = planRepair(report, mods, remaps)
  if (!plan.applied.length) return res.status(400).json({ error: 'no applicable remap', rejected: plan.rejected })

  const backup = backupModOrder(s, 'before mod id drift repair')
  setIniList(s, 'Mods', plan.mods)
  logFor(s, 'mod id drift repaired: ' + plan.applied.map(a => a.from + ' -> ' + a.to).join(', ') +
    ', previous Mods= backed up as ' + backup)
  res.json({ success: true, applied: plan.applied, rejected: plan.rejected, backup,
             restartRequired: true })
})

// --- Clean reinstall of one Workshop item ---
//
// Removing a mod's files and letting the server boot without it is how a save loses items: PZ
// discards what it cannot load, in every container and on every character. So the whole flow is
// arranged around one rule — the server never starts while a mod id in Mods= has no files on
// disk. Everything else (downtime, a stale copy, a failed download) is recoverable.
//
// The download runs with the server still up, because SteamCMD lives inside the PZ container and
// a stopped container cannot be exec'd into. Only steps 5-11 are downtime.

// Promise wrappers, so the eleven-step reinstall below reads as a sequence rather than a callback
// ladder. Errors are trimmed because they end up in `state.error`, which the UI renders verbatim.
const dockerControl = (action, s, timeout) => new Promise((resolve, reject) =>
  docker.control(action, s.container, timeout, err => err ? reject(trimErr(err)) : resolve(undefined)))
const dockerExecIn = (s, argv, timeout) => new Promise((resolve, reject) => {
  try { resolve(docker.execInSync(s.container, argv, { timeout })) }
  catch (e) { reject(trimErr(e)) }
})
const trimErr = e => new Error(String((e && e.stderr) || (e && e.message) || e).trim().slice(0, 400))
const sleep = ms => new Promise(r => setTimeout(r, ms))
const saveThenAsync = s => new Promise(resolve => saveThen(s, resolve))

// Move rather than delete, so every step before the server comes back up is reversible.
//
// /pz-data, /workshop and /pz-install are three separate bind mounts, so a rename between them is
// EXDEV — which is every move out of the workshop tree, since the quarantine lives under /pz-data.
// The fallback copies first and only unlinks once the copy is complete, so a half-finished copy is
// never the only surviving version of a mod.
function quarantineMove(from, to) {
  if (!fs.existsSync(from)) return false
  fs.mkdirSync(path.dirname(to), { recursive: true })
  try {
    fs.renameSync(from, to)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    fs.rmSync(to, { recursive: true, force: true }) // a partial copy from an earlier attempt
    fs.cpSync(from, to, { recursive: true })
    fs.rmSync(from, { recursive: true, force: true })
  }
  return true
}

function pruneQuarantine(s) {
  try {
    const all = fs.readdirSync(reinstallDir(s)).sort().reverse()
    for (const old of all.slice(REINSTALL_QUARANTINE_KEEP)) {
      fs.rmSync(path.join(reinstallDir(s), old), { recursive: true, force: true })
    }
  } catch {}
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir) } catch { return [] }
}

// Mod ids the game can actually load, read from the two trees PZ itself scans: the SteamCMD
// install tree for Workshop mods, and <data>/mods for local ones. Deliberately not /workshop —
// that is the manager's inventory mirror, which B42 never reads, so counting it would let a mod
// pass this check and then fail to load.

// The <data>/mods folder names belonging to this item, read from the quarantined copy. Needed
// because modNamesFromWorkshop() reads the live workshop tree, which has just been moved aside.
function quarantinedFolders(quarantine) {
  const dir = path.join(quarantine, 'workshop', 'mods')
  if (!fs.existsSync(dir)) return []
  try { return fs.readdirSync(dir).filter(f => !/^\d+\.\d+$/.test(f)) } catch { return [] }
}

async function reinstallWorkshopItem(s, workshopId) {
  // The state shape lives with the store, in src/services/reinstall-state.js.
  const state = reinstallState.set(s, {
    workshopId, step: 'starting', startedAt: new Date().toISOString(),
    finishedAt: null, ok: false, error: null, quarantine: null,
  })
  const step = (name) => { state.step = name; logFor(s, 'reinstall ' + workshopId + ': ' + name) }

  const install = installContent(s)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const quarantine = path.join(reinstallDir(s), workshopId + '-' + stamp)
  const snapshot = { mods: getIniList(s, 'Mods'), workshopItems: getIniList(s, 'WorkshopItems') }
  const foldersBefore = modNamesFromWorkshop(s, workshopId)
  let stopped = false          // the container is down and this flow owes it a start
  let installed = false        // step 7 ran, so there are fresh files on disk to clear on rollback
  let movedWorkshop = false
  const movedModFolders = []

  // Undoes everything the downtime window touched. Returns true only when the ini and the disk
  // agree again, which is the sole condition under which the server may be started.
  const rollback = () => {
    try {
      // Only when step 7 actually laid fresh files down. Without this guard a failure before the
      // swap would delete the item's mod folders and have nothing quarantined to put back.
      if (installed) {
        for (const folder of modNamesFromWorkshop(s, workshopId)) {
          if (movedModFolders.includes(folder)) continue // restored below from the quarantine
          if (folderProviders(s, folder).filter(id => id !== workshopId).length) continue // shared
          try { fs.rmSync(path.join(modsDir(s), folder), { recursive: true, force: true }) } catch {}
        }
      }
      if (movedWorkshop) {
        fs.rmSync(path.join(workshopContent(s), workshopId), { recursive: true, force: true })
        quarantineMove(path.join(quarantine, 'workshop'), path.join(workshopContent(s), workshopId))
      }
      for (const folder of movedModFolders) {
        fs.rmSync(path.join(modsDir(s), folder), { recursive: true, force: true })
        quarantineMove(path.join(quarantine, 'mods', folder), path.join(modsDir(s), folder))
      }
      setIniList(s, 'WorkshopItems', snapshot.workshopItems)
      setIniList(s, 'Mods', snapshot.mods)
      return missingProviders(s, snapshot.mods).length === 0
    } catch (e) {
      console.error('[reinstall] rollback failed for ' + workshopId + ':', e.message)
      return false
    }
  }

  try {
    // 1 — snapshot. backupModOrder() writes Mods= into the same store the Load Order tab restores
    // from, so a bad outcome is undoable by hand as well as automatically.
    step('snapshotting mod list')
    if (!snapshot.workshopItems.includes(workshopId)) throw new Error('Workshop item ' + workshopId + ' is not installed on this server')
    backupModOrder(s, 'pre-reinstall-' + workshopId)
    fs.mkdirSync(quarantine, { recursive: true })
    fs.writeFileSync(path.join(quarantine, 'ini-snapshot.json'), JSON.stringify(snapshot, null, 2))
    state.quarantine = quarantine

    // 2 — clear SteamCMD's copy so the download cannot no-op on an up-to-date manifest. This is
    // the staging tree, and the container is still up, so exec works.
    step('clearing SteamCMD copy')
    await dockerExecIn(s, ['rm', '-rf',
      '/home/steam/pz-dedicated/steamapps/workshop/content/108600/' + workshopId], 120000)

    // 3 — download with the server still up. Any failure between here and step 4 costs nothing:
    // only the staging tree has been touched and the server never went down.
    step('downloading from Steam')
    writeQueue(s, readQueue(s).filter(e => e.id !== workshopId))
    steamcmdDownload(s, [workshopId], 'reinstall', null)
    const deadline = Date.now() + REINSTALL_DOWNLOAD_TIMEOUT_MS
    for (;;) {
      await sleep(5000)
      // reconcileDownloads() owns the queue and calls registerInstalledMod() when an item settles.
      // Waiting on it beats running a second copy of the same bookkeeping alongside it.
      const entry = readQueue(s).find(e => e.id === workshopId)
      if (entry && entry.status !== 'queued') {
        if (entry.status !== 'installed') throw new Error('Download did not complete: ' + (entry.error || entry.status))
        break
      }
      if (Date.now() > deadline) throw new Error('Download did not finish within ' + Math.round(REINSTALL_DOWNLOAD_TIMEOUT_MS / 60000) + ' minutes')
    }

    // 4 — last checkpoint before any downtime.
    step('verifying downloaded files')
    if (!itemHasContent(install, workshopId)) throw new Error('SteamCMD produced no loadable mod folders for ' + workshopId + ' — nothing has been changed')

    // The quarantine is on a different filesystem from the workshop tree, so it is a copy, not a
    // relink. Checked here because running out of room mid-swap would strand the server down.
    const needBytes = disk.dirSizeSync(path.join(workshopContent(s), workshopId)) + disk.dirSizeSync(path.join(install, workshopId))
    const haveBytes = disk.freeBytes(s.data)
    if (haveBytes && needBytes > haveBytes * 0.9) {
      throw new Error('Not enough free space to quarantine ' + workshopId + ': needs about ' +
        humanBytes(needBytes) + ', ' + humanBytes(haveBytes) + ' free — nothing has been changed')
    }

    // 5 — down. saveThen() writes the world first; without it the JVM is SIGKILLed and the world
    // reverts to its last autosave.
    step('saving world and stopping server')
    state.holdsContainer = true
    mstate(s).intentionalStop = true
    await saveThenAsync(s)
    await dockerControl('stop', s, 120000)
    stopped = true

    // 6 — quarantine the old copies. The install tree is deliberately not moved: SteamCMD already
    // replaced it in steps 2-3, and it is the one tree that can be re-fetched from Steam at will.
    step('quarantining old files')
    // Read now, not before the download: reconcileDownloads() has already mirrored the new tree in
    // by this point, so folders that appeared in this version are only visible here. Unioned with
    // the pre-download list so a folder the author deleted still gets moved aside rather than left
    // in <data>/mods claiming a live mod id.
    const foldersToMove = new Set([...foldersBefore, ...modNamesFromWorkshop(s, workshopId)])
    movedWorkshop = quarantineMove(path.join(workshopContent(s), workshopId), path.join(quarantine, 'workshop'))
    for (const folder of new Set([...foldersToMove, ...quarantinedFolders(quarantine)])) {
      if (quarantineMove(path.join(modsDir(s), folder), path.join(quarantine, 'mods', folder))) movedModFolders.push(folder)
    }

    // 7/8 — mirror the fresh tree out, dropping excluded folders on the way (registerInstalledMod
    // skips them and then calls applyExcludes for the install tree).
    step('installing fresh files')
    const result = registerInstalledMod(s, workshopId, { force: true })
    installed = true
    if (result.status !== 'installed') throw new Error('Fresh files produced no loadable mod ids')

    // 9 — put Mods= back exactly as it was. registerInstalledMod appends, which would silently
    // move this item to the end of the load order; order is what loadModAfter depends on.
    step('restoring load order')
    const added = result.modIds.filter(id => !snapshot.mods.includes(id))
    setIniList(s, 'WorkshopItems', snapshot.workshopItems)
    setIniList(s, 'Mods', [...snapshot.mods, ...added])
    state.addedModIds = added

    // 10 — the gate.
    step('verifying mod list against disk')
    const missing = missingProviders(s, getIniList(s, 'Mods'))
    if (missing.length) throw new Error('After reinstall these enabled mods have no files: ' + missing.join(', '))

    // 11 — back up.
    step('starting server')
    markAwaitingReady(s)
    await dockerControl('start', s, 60000)
    pruneQuarantine(s)

    state.ok = true
    state.step = 'done'
    state.finishedAt = new Date().toISOString()
    logFor(s, 'reinstall ' + workshopId + ' complete - mod ids [' + result.modIds.join(', ') + ']' + (added.length ? ', newly added [' + added.join(', ') + ']' : ''))
    pushoverFor(s, 'PZ Mod Reinstalled', 'Workshop item ' + workshopId + ' was reinstalled cleanly and the server is starting.')
    return state
  } catch (e) {
    const failedAt = state.step
    state.error = e.message
    state.finishedAt = new Date().toISOString()
    logFor(s, 'reinstall ' + workshopId + ' FAILED at [' + failedAt + ']: ' + e.message)

    // Keyed on the stop, not on whether any file moved: a failure on the very first move happens
    // with the container already down, and reporting "nothing changed" there would leave the
    // server stopped with nobody bringing it back.
    if (!stopped) {
      pushoverFor(s, 'PZ Mod Reinstall Failed', 'Workshop item ' + workshopId + ' failed at "' + failedAt + '". The server was not stopped and nothing changed.')
      return state
    }

    state.step = 'rolling back'
    if (rollback()) {
      state.rolledBack = true
      logFor(s, 'reinstall ' + workshopId + ': rolled back, starting server again')
      markAwaitingReady(s)
      try { await dockerControl('start', s, 60000) } catch (e2) { console.error('[reinstall] start after rollback failed:', e2.message) }
      pushoverFor(s, 'PZ Mod Reinstall Failed', 'Workshop item ' + workshopId + ' failed at "' + failedAt + '" and was rolled back. The server is starting again.')
      return state
    }

    // The one case where staying down is the right answer. Starting now would boot a world whose
    // Mods= names files that are not there, and PZ deletes those mods' items from the save.
    state.strandedDown = true
    logFor(s, 'reinstall ' + workshopId + ': ROLLBACK FAILED - leaving the server stopped on purpose. Files are in ' + quarantine)
    pushoverFor(s, 'PZ SERVER STOPPED - action needed',
      'Reinstall of ' + workshopId + ' failed and could not be rolled back. The server is deliberately stopped to protect the save. Files: ' + quarantine)
    return state
  } finally {
    state.holdsContainer = false
  }
}

app.get('/api/mods/reinstall', (req, res) => {
  const s = srv(req)
  res.json({ available: !!s.install, busy: reinstallState.busy(s), state: reinstallState.get(s) })
})

app.post('/api/mods/:workshopId/reinstall', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.params
  if (!validWorkshopId(workshopId)) return res.status(400).json({ error: 'workshopId must be digits' })
  if (!s.install) return res.status(409).json({ error: 'This server has no /pz-install mount, so the manager cannot see the files the game loads. Add ./install:/pz-install to the mod-manager service and restart it.' })
  if (reinstallState.busy(s)) return res.status(409).json({ error: 'A reinstall of ' + reinstallState.get(s).workshopId + ' is already running' })
  if (!getIniList(s, 'WorkshopItems').includes(workshopId)) return res.status(404).json({ error: 'Workshop item ' + workshopId + ' is not installed on this server' })

  // Answered immediately: the flow runs for as long as a download plus a restart, well past any
  // sensible HTTP timeout. Progress comes from GET /api/mods/reinstall.
  res.json({ success: true, workshopId, started: true })
  reinstallWorkshopItem(s, workshopId).catch(e => console.error('[reinstall]', e))
})

// --- Excluded mod folders ---
//
// Registered ahead of DELETE /api/mods/:workshopId, which would otherwise match "excludes" as a
// Workshop id and try to uninstall it.

app.get('/api/mods/excludes', (req, res) => {
  const s = srv(req)
  res.json({ excludes: readExcludes(s), duplicates: duplicateModIds(s) })
})

app.post('/api/mods/excludes', (req, res) => {
  const s = srv(req)
  const { workshopId, folder, force } = req.body || {}
  if (!validWorkshopId(workshopId)) return res.status(400).json({ error: 'workshopId must be digits' })
  if (!validFolder(folder)) return res.status(400).json({ error: 'Invalid folder name' })

  // The guard that matters. Excluding the only folder providing an enabled mod id would leave
  // Mods= naming a mod the server can no longer load, and PZ starting without a mod is what
  // strips that mod's items out of every character and container in the save. Refusing is
  // recoverable; discovering it after a boot is not. force:true is the deliberate override.
  const rows = modIdsByFolder(s)
  const mine = rows.filter(r => r.workshopId === workshopId && r.folder === folder)
  if (!mine.length && !force) {
    return res.status(404).json({ error: 'No mod folder "' + folder + '" found in Workshop item ' + workshopId })
  }
  const enabled = new Set(getIniList(s, 'Mods'))
  const orphaned = mine
    .map(r => r.modId)
    .filter(id => enabled.has(id))
    .filter(id => !rows.some(r => r.modId === id && !(r.workshopId === workshopId && r.folder === folder)))
  if (orphaned.length && !force) {
    return res.status(409).json({
      error: 'Excluding ' + folder + ' would leave ' + orphaned.join(', ') + ' enabled in Mods= with nothing to load. Disable the mod first, or re-send with force to accept that.',
      orphaned,
    })
  }

  let next
  try { next = addExclude(readExcludes(s), workshopId, folder) }
  catch (e) { return res.status(400).json({ error: e.message }) }
  try { writeExcludes(s, next) }
  catch (e) { return res.status(500).json({ error: 'Could not save exclusions: ' + e.message }) }

  logFor(s, 'excluding mod folder ' + workshopId + '/' + folder + (orphaned.length ? ' (forced, orphans ' + orphaned.join(', ') + ')' : ''))
  const removed = applyExcludes(s)
  res.json({ success: true, workshopId, folder, removed, orphaned })
})

app.delete('/api/mods/excludes', (req, res) => {
  const s = srv(req)
  const { workshopId, folder } = req.body || {}
  if (!validWorkshopId(workshopId)) return res.status(400).json({ error: 'workshopId must be digits' })
  if (!validFolder(folder)) return res.status(400).json({ error: 'Invalid folder name' })
  try { writeExcludes(s, removeExclude(readExcludes(s), workshopId, folder)) }
  catch (e) { return res.status(500).json({ error: 'Could not save exclusions: ' + e.message }) }
  // Nothing is restored here — the folder comes back on the item's next download or reinstall.
  logFor(s, 'no longer excluding mod folder ' + workshopId + '/' + folder + ' — returns on its next download')
  res.json({ success: true, workshopId, folder })
})

// The one removal path for a Workshop item: delete the copied mod folders, then drop the item
// from WorkshopItems= and its mod ids from Mods=. Manual removal, untracking a collection with
// removeMods, and clearing a dropped mod all route through here so they can't drift apart.
// Nothing removes a mod on a timer — a sync only ever reports what the curator dropped.
function removeWorkshopItem(s, workshopId) {
  const removedIds = modIdsFromWorkshop(s, workshopId)
  const removedFolders = modNamesFromWorkshop(s, workshopId)
  for (const folder of removedFolders) {
    const dest = path.join(modsDir(s), folder)
    try { fs.rmSync(dest, { recursive: true, force: true }) }
    catch (e) { console.error('[remove] could not delete mod folder "' + folder + '": ' + e.message) }
  }
  setIniList(s, 'WorkshopItems', getIniList(s, 'WorkshopItems').filter(id => id !== workshopId))
  setIniList(s, 'Mods', getIniList(s, 'Mods').filter(id => !removedIds.includes(id)))
  return { removedIds, removedFolders }
}

app.delete('/api/mods/:workshopId', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.params
  // The id is interpolated straight into an rm -rf path below, so it is checked before use.
  if (!validWorkshopId(workshopId)) return res.status(400).json({ error: 'workshopId must be digits' })
  const { removedIds, removedFolders } = removeWorkshopItem(s, workshopId)
  logFor(s, 'removed Workshop item ' + workshopId + ' - mod ids [' + removedIds.join(', ') + '], folders [' + removedFolders.join(', ') + ']')
  writeQueue(s, readQueue(s).filter(e => e.id !== workshopId))
  // Whatever the reason for removal, it is no longer outstanding. Clearing it here rather than
  // waiting for the next sync is what makes the "remove it" button in the dropped-mods panel
  // settle immediately instead of leaving a row that looks like it did nothing.
  const colls = readCollections(s)
  let clearedDropped = false
  for (const c of colls) {
    if (c.droppedItems && c.droppedItems.includes(workshopId)) {
      c.droppedItems = c.droppedItems.filter(id => id !== workshopId)
      clearedDropped = true
    }
  }
  if (clearedDropped) writeCollections(s, colls)
  res.json({ success: true, workshopId, removedIds, removedFolders })
})

// --- Load order ---
//
// Mods= is load order: later entries override earlier ones, and mods with loadModAfter= expect to
// sit behind their dependencies. Reordering rewrites the whole line, so every save snapshots the
// previous order first — a bad drag is then one click to undo rather than a hand-rebuilt list of
// 180 mod ids.
const MOD_ORDER_BACKUP_KEEP = 20

function listModOrderBackups(s) {
  try {
    return fs.readdirSync(modOrderBackupDir(s))
      .filter(f => f.startsWith('Mods-') && f.endsWith('.json'))
      .sort().reverse()
      .map(f => {
        let entry = {}
        try { entry = JSON.parse(fs.readFileSync(path.join(modOrderBackupDir(s), f), 'utf8')) } catch {}
        return { file: f, savedAt: entry.savedAt || '', label: entry.label || '', count: (entry.mods || []).length }
      })
  } catch { return [] }
}

function backupModOrder(s, label) {
  const dir = modOrderBackupDir(s)
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = 'Mods-' + stamp + '.json'
  fs.writeFileSync(path.join(dir, file), JSON.stringify({
    savedAt: new Date().toISOString(),
    label: label || '',
    mods: getIniList(s, 'Mods')
  }, null, 2))
  // Keep the most recent few; these are tiny but unbounded growth is nobody's friend.
  const all = listModOrderBackups(s)
  for (const old of all.slice(MOD_ORDER_BACKUP_KEEP)) {
    try { fs.unlinkSync(path.join(dir, old.file)) } catch {}
  }
  return file
}

app.get('/api/mods/order', (req, res) => {
  const s = srv(req)
  const meta = installedModMeta(s)
  const byLower = {}
  for (const [id, m] of Object.entries(meta)) byLower[id.toLowerCase()] = m
  res.json({
    mods: getIniList(s, 'Mods').map((id, i) => {
      const m = byLower[id.toLowerCase()] || {}
      return {
        modId: id, index: i,
        name: m.name || id,
        workshopId: m.workshopId || null,
        // Surfaced inline so the ordering constraints are visible while dragging.
        loadModAfter: m.loadModAfter || [],
        installed: !!byLower[id.toLowerCase()]
      }
    }),
    backups: listModOrderBackups(s)
  })
})

app.put('/api/mods/order', (req, res) => {
  const s = srv(req)
  const next = (req.body || {}).mods
  const current = getIniList(s, 'Mods')
  // Must be a permutation: reordering may never add or drop a mod. That is what the per-mod
  // toggles are for, and a silent change here would alter what the server loads.
  const check = validateReorder(current, next)
  if (!check.ok) return res.status(400).json({ error: check.error })
  const backup = backupModOrder(s, (req.body || {}).label || 'before reorder')
  setIniList(s, 'Mods', next)
  logFor(s, 'load order saved (' + next.length + ' mods), previous backed up as ' + backup)
  res.json({ success: true, count: next.length, backup })
})

app.get('/api/mods/order/backups', (req, res) => res.json({ backups: listModOrderBackups(srv(req)) }))

app.post('/api/mods/order/restore', (req, res) => {
  const s = srv(req)
  const { file } = req.body || {}
  if (!file || !/^Mods-[\w-]+\.json$/.test(file)) return res.status(400).json({ error: 'Invalid backup file' })
  const full = path.join(modOrderBackupDir(s), file)
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'No such backup: ' + file })
  let saved
  try { saved = JSON.parse(fs.readFileSync(full, 'utf8')) } catch (e) { return res.status(500).json({ error: 'Backup is unreadable: ' + e.message }) }
  // The snapshot may predate a mod being enabled or removed, so it is only valid if it still
  // describes exactly the current mod set — otherwise restoring it would change what loads.
  const check = validateReorder(getIniList(s, 'Mods'), saved.mods || [])
  if (!check.ok) return res.status(409).json({ error: 'Backup no longer matches the enabled mods — ' + check.error })
  const backup = backupModOrder(s, 'before restoring ' + file)
  setIniList(s, 'Mods', saved.mods)
  logFor(s, 'load order restored from ' + file + ' (' + saved.mods.length + ' mods)')
  res.json({ success: true, restored: file, count: saved.mods.length, backup })
})

// --- Disk audit ---
//
// Full visibility over what is actually on disk versus what the ini claims. Mods routinely get
// half-removed: a Workshop item unregistered but its files left behind, or a folder copied into
// the server's mods dir whose Workshop item is long gone. Those cost disk and confuse later
// installs, and nothing else in here would ever surface them.

function auditServer(s) {
  const registered = getIniList(s, 'WorkshopItems')
  const registeredSet = new Set(registered)
  const enabled = getIniList(s, 'Mods')
  const meta = installedModMeta(s)                       // registered items only
  const providedLower = new Set(Object.keys(meta).map(id => id.toLowerCase()))

  // Every Workshop id sitting in the content dir, registered or not.
  let onDisk = []
  try { onDisk = fs.readdirSync(workshopContent(s)).filter(f => /^\d+$/.test(f)) } catch {}

  // Downloaded but not in WorkshopItems= — pure wasted disk.
  const unregistered = onDisk.filter(id => !registeredSet.has(id)).map(id => ({
    workshopId: id,
    folders: (() => { try { return fs.readdirSync(path.join(workshopContent(s), id, 'mods')) } catch { return [] } })(),
    bytes: disk.dirSizeSync(path.join(workshopContent(s), id))
  }))

  // Registered but no mod content on disk — the server will fail to load these.
  const missingContent = registered.filter(id => !hasModContent(s, id))

  // Folders copied into the server's mods dir with no registered Workshop item behind them.
  const expectedFolders = new Set()
  for (const wid of registered) for (const f of modNamesFromWorkshop(s, wid)) expectedFolders.add(f)
  let modsDirFolders = []
  try { modsDirFolders = fs.readdirSync(modsDir(s), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch {}
  const orphanFolders = modsDirFolders.filter(f => !expectedFolders.has(f)).map(f => ({
    folder: f, bytes: disk.dirSizeSync(path.join(modsDir(s), f))
  }))

  // Enabled in Mods= but no installed mod.info provides that id — silently does nothing.
  const phantomEnabled = enabled.filter(id => !providedLower.has(id.toLowerCase()))

  // Installed and available but not loaded. Informational, not a problem.
  const enabledLower = new Set(enabled.map(id => id.toLowerCase()))
  const installedNotEnabled = Object.keys(meta).filter(id => !enabledLower.has(id.toLowerCase()))

  // Two folders claiming one mod id. PZ takes whichever it scans first, so the server boots
  // differently on consecutive starts — the "it needs a second restart" symptom, and invisible
  // everywhere else in this UI because installedModMeta() is keyed by id and keeps only the last
  // folder it read. Only ids that are actually enabled are worth flagging.
  const enabledSet = new Set(enabled)
  const duplicateIds = duplicateModIds(s).filter(d => enabledSet.has(d.modId))

  // phantomEnabled above reads the /workshop mirror. This reads the two trees the game itself
  // scans, so it catches the case that one cannot: a mod present in the manager's inventory but
  // absent from where PZ looks, which loads as nothing and drops its items from the save.
  const notLoadable = missingProviders(s, enabled)

  const reclaimable = unregistered.reduce((n, u) => n + u.bytes, 0) + orphanFolders.reduce((n, o) => n + o.bytes, 0)

  return {
    registered: registered.length,
    enabled: enabled.length,
    onDisk: onDisk.length,
    unregistered, missingContent, orphanFolders, phantomEnabled, installedNotEnabled, duplicateIds, notLoadable,
    reclaimableBytes: reclaimable,
    reclaimableHuman: humanBytes(reclaimable),
    freeBytes: disk.freeBytes(s.data),
    freeHuman: humanBytes(disk.freeBytes(s.data))
  }
}

app.get('/api/audit', (req, res) => {
  try { res.json(auditServer(srv(req))) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// Deletes one orphaned artefact found by the audit. Scoped deliberately: only things the audit
// classed as unreferenced, never a registered mod.
app.delete('/api/audit/orphan', (req, res) => {
  const s = srv(req)
  const { kind, id } = req.body || {}
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' })
  const audit = auditServer(s)
  let target
  if (kind === 'workshop') {
    if (!audit.unregistered.some(u => u.workshopId === id)) return res.status(400).json({ error: 'Not an unregistered Workshop item: ' + id })
    target = path.join(workshopContent(s), id)
  } else if (kind === 'folder') {
    if (!audit.orphanFolders.some(o => o.folder === id)) return res.status(400).json({ error: 'Not an orphaned mod folder: ' + id })
    target = path.join(modsDir(s), id)
  } else {
    return res.status(400).json({ error: 'kind must be "workshop" or "folder"' })
  }
  const bytes = disk.dirSizeSync(target)
  try { fs.rmSync(target, { recursive: true, force: true }) }
  catch (e) { return res.status(500).json({ error: 'Delete failed: ' + e.message }) }
  logFor(s, 'deleted orphaned ' + kind + ' "' + id + '" - freed ' + humanBytes(bytes))
  res.json({ success: true, kind, id, freed: humanBytes(bytes) })
})

// Bulk removal of every orphan the audit currently reports. The audit is recomputed here rather
// than trusting a list from the client, so a stale page can never delete something that has since
// become referenced. Only the two unreferenced categories are touched — missingContent and
// phantomEnabled are ini problems, not files, and are never deleted.
app.delete('/api/audit/orphans', (req, res) => {
  const s = srv(req)
  let audit
  try { audit = auditServer(s) } catch (e) { return res.status(500).json({ error: e.message }) }

  const targets = []
  for (const u of audit.unregistered) targets.push({ kind: 'workshop', id: u.workshopId, path: path.join(workshopContent(s), u.workshopId), bytes: u.bytes })
  for (const o of audit.orphanFolders) targets.push({ kind: 'folder', id: o.folder, path: path.join(modsDir(s), o.folder), bytes: o.bytes })

  const deleted = []
  const failed = []
  let freed = 0
  for (const t of targets) {
    try { fs.rmSync(t.path, { recursive: true, force: true }); deleted.push({ kind: t.kind, id: t.id }); freed += t.bytes }
    catch (e) { failed.push({ kind: t.kind, id: t.id, error: e.message }) }
  }
  logFor(s, 'bulk orphan delete: removed ' + deleted.length + ' item(s), freed ' + humanBytes(freed) + (failed.length ? ', ' + failed.length + ' failed' : ''))
  res.json({ success: true, deleted: deleted.length, failed, freed: humanBytes(freed), freedBytes: freed })
})

// --- Mod dependencies ---
//
// PZ won't tell you a dependency is unmet; the mod just misbehaves in-game. These endpoints read
// require= / incompatible= / loadModAfter= from every installed mod.info and report what the
// current Mods= list doesn't satisfy.
//
// Not every declared requirement is genuinely required — authors list optional companion mods in
// require= all the time — so nothing is auto-installed or auto-enabled. Issues are reported and
// the user decides, with an ignore list for the ones that don't apply.
function readDepIgnores(s) {
  try { const v = JSON.parse(fs.readFileSync(depIgnorePath(s), 'utf8')); return Array.isArray(v) ? v : [] }
  catch { return [] }
}
function writeDepIgnores(s, list) {
  try { fs.writeFileSync(depIgnorePath(s), JSON.stringify(list, null, 2)) } catch (e) {}
}
function depKey(modId, dependency) { return modId + '>' + dependency }

app.get('/api/dependencies', (req, res) => {
  const s = srv(req)
  const meta = installedModMeta(s)
  const enabled = getIniList(s, 'Mods')
  const ignores = readDepIgnores(s)
  const installed = Object.keys(meta)
  const issues = sortIssues(analyzeDependencies({ enabled, installed, meta, ignores }))

  // Resolve ids to something the UI can act on and a human can read.
  const byLowerId = {}
  for (const [id, m] of Object.entries(meta)) byLowerId[id.toLowerCase()] = Object.assign({ id }, m)

  res.json({
    issues: issues.map(i => {
      const self = byLowerId[String(i.modId).toLowerCase()] || {}
      const dep = byLowerId[String(i.dependency).toLowerCase()] || null
      return Object.assign({}, i, {
        key: depKey(i.modId, i.dependency),
        modName: self.name || i.modId,
        modWorkshopId: self.workshopId || null,
        dependencyName: dep ? dep.name : null,
        dependencyModId: dep ? dep.id : null,        // real-cased id, for enabling
        dependencyWorkshopId: dep ? dep.workshopId : null
      })
    }),
    checked: enabled.length,
    installedCount: installed.length,
    // Flagged rather than silently dropped: an ignore whose mod is no longer enabled can never
    // match again, so it sits in the list forever with nothing on screen explaining why. That is
    // what a mod id rename leaves behind — "MarzGuns>SWMG" outlived the id it was written for.
    // Still the user's decision to clear, so it is reported, not deleted.
    ignored: ignores.map(k => {
      const at = String(k).indexOf('>')
      const modId = at === -1 ? k : k.slice(0, at)
      const dependency = at === -1 ? '' : k.slice(at + 1)
      return {
        key: k, modId, dependency,
        stale: !enabled.some(id => id.toLowerCase() === String(modId).toLowerCase()),
      }
    })
  })
})

// Dismiss (or restore) one dependent>dependency pair. Scoped to the pair, not the mod, so
// ignoring one optional companion doesn't silence a genuine problem in the same mod.
app.post('/api/dependencies/ignore', (req, res) => {
  const s = srv(req)
  const { modId, dependency, ignored } = req.body || {}
  if (!modId || !dependency) return res.status(400).json({ error: 'modId and dependency are required' })
  if (typeof ignored !== 'boolean') return res.status(400).json({ error: 'ignored must be a boolean' })
  const key = depKey(modId, dependency)
  const list = readDepIgnores(s).filter(k => k.toLowerCase() !== key.toLowerCase())
  if (ignored) list.push(key)
  writeDepIgnores(s, list)
  logFor(s, (ignored ? 'ignoring' : 'restored') + ' dependency ' + key)
  res.json({ success: true, key, ignored })
})

// Satisfy one loadModAfter constraint by moving the dependent mod.
//
// "X must load after Y" with Y sitting later in Mods= is a pure ordering fault, so the repair is a
// move and nothing else: the mod that carries the constraint slides to just past the mod it names.
// moveItem(list, from, to) with to = the dependency's index does exactly that — removing the entry
// first shifts the dependency down one, so inserting at its old index lands immediately after it.
//
// Deliberately one pair per press. A mod can carry several loadModAfter entries and mods can
// constrain each other, so a single move can satisfy one pair and break another; a full
// topological sort would reshuffle a 173-entry list the user has hand-tuned. Instead the move is
// applied, the analysis re-run, and whatever is still outstanding reported back so the next press
// works on current facts.
//
// The pair must be a real, current issue — a caller cannot post an arbitrary move here, because
// this writes Mods= and order is what loadModAfter depends on.
app.post('/api/dependencies/fix-order', (req, res) => {
  const s = srv(req)
  const { modId, dependency } = req.body || {}
  if (!modId || !dependency) return res.status(400).json({ error: 'modId and dependency are required' })

  const meta = installedModMeta(s)
  const mods = getIniList(s, 'Mods')
  const issues = analyzeDependencies({
    enabled: mods, installed: Object.keys(meta), meta, ignores: readDepIgnores(s),
  })
  const lower = v => String(v).toLowerCase()
  const issue = issues.find(i => i.type === 'order' &&
    lower(i.modId) === lower(modId) && lower(i.dependency) === lower(dependency))
  if (!issue) return res.status(400).json({ error: 'Not a current load-order issue: ' + modId + ' after ' + dependency })

  // Resolve against Mods= itself: loadModAfter values are frequently mis-cased by authors.
  const from = mods.findIndex(id => lower(id) === lower(issue.modId))
  const to = mods.findIndex(id => lower(id) === lower(issue.dependency))
  if (from === -1 || to === -1) return res.status(400).json({ error: 'Both mods must be in the load order' })

  const next = moveItem(mods, from, to)
  const check = validateReorder(mods, next)
  if (!check.ok) return res.status(500).json({ error: 'Refusing to write a non-permutation: ' + check.error })

  const backup = backupModOrder(s, 'before load-order fix: ' + issue.modId + ' after ' + issue.dependency)
  setIniList(s, 'Mods', next)

  const remaining = analyzeDependencies({
    enabled: next, installed: Object.keys(meta), meta, ignores: readDepIgnores(s),
  }).filter(i => i.type === 'order')

  logFor(s, 'load-order fix: moved "' + issue.modId + '" from ' + (from + 1) + ' to ' + (to + 1) +
    ' so it loads after "' + issue.dependency + '"' +
    (remaining.length ? ' (' + remaining.length + ' order issue(s) still outstanding)' : '') +
    ', previous order backed up as ' + backup)

  res.json({
    success: true, modId: issue.modId, dependency: issue.dependency,
    from: from + 1, to: to + 1, backup,
    remainingOrderIssues: remaining.length, restartRequired: true,
  })
})

// --- Mod auto-update ---
//
// Hourly: ask Steam whether any installed Workshop item has been updated, download the ones that
// have, and — once the downloads finish and the server is empty — restart so they take effect.
//
// Off by default. It restarts a live game server, so every decision is conservative: a first
// sighting only seeds the baseline (enabling it must not re-download 150 mods), and a restart
// needs a genuinely pending update, no downloads in flight, and a confirmed-empty server.
const AUTOUPDATE_CHECK_MS = 60 * 60 * 1000   // ask Steam at most hourly
const AUTOUPDATE_TICK_MS = 5 * 60 * 1000     // but re-evaluate the restart condition often

function readAutoUpdate(s) {
  const def = { enabled: false, restartWhenEmpty: true, lastCheck: null, lastRestart: null, pending: [], times: {}, lastResult: '' }
  try { return Object.assign(def, JSON.parse(fs.readFileSync(autoUpdatePath(s), 'utf8'))) }
  catch { return def }
}
function writeAutoUpdate(s, cfg) {
  try { fs.writeFileSync(autoUpdatePath(s), JSON.stringify(cfg, null, 2)) } catch (e) {}
}

// How many downloads are still in flight for this server.
function activeDownloadCount(s, cb) {
  docker.logs(s.container, ['--tail', '1500'], { maxBuffer: 8 * docker.MB }, (err, out) => {
    const live = parseDownloads((out || '').split('\n')).length
    const queued = readQueue(s).filter(e => e.status === 'queued').length
    cb(live + queued)
  })
}

// force=true is the manual "Check now" button: it runs the pass even while the hourly check is
// switched off. Restarting is not forced with it — that still goes through shouldRestart(), which
// refuses whenever auto-update is disabled.
function runAutoUpdate(s, force) {
  const cfg = readAutoUpdate(s)
  if (!cfg.enabled && !force) return
  // The reinstall owns the container and the ini while it runs, and "Check now" is no exception:
  // a download queued underneath it would land in the middle of the file swap.
  if (reinstallState.busy(s)) return console.log('[autoupdate] ' + serverLabel(s) + ': skipped, a mod reinstall is in progress')

  const finish = () => writeAutoUpdate(s, cfg)

  // Step 1 — restart if a previous pass left updates waiting and the server is now clear.
  // Both inputs are asked of the running server first; playerCountFor() still reports null when
  // nothing can answer, and shouldRestart() treats that as "someone might be on".
  const decide = (active, players) => {
    const verdict = shouldRestart({
      enabled: cfg.enabled, restartWhenEmpty: cfg.restartWhenEmpty,
      pending: cfg.pending, activeDownloads: active, playersOnline: players
    })

    if (verdict.restart) {
      console.log('[autoupdate] ' + serverLabel(s) + ': restarting for ' + cfg.pending.length + ' updated mod(s)')
      mstate(s).intentionalStop = true
      markAwaitingReady(s)
      saveThen(s, () => bringUp(s, 'restart', 120000, err => {
        const cur = readAutoUpdate(s)
        if (err) {
          cur.lastResult = 'Restart failed: ' + err.message
          console.error('[autoupdate] restart failed:', err.message)
        } else {
          cur.lastResult = 'Restarted for ' + cur.pending.length + ' updated mod(s) at ' + new Date().toISOString()
          cur.lastRestart = new Date().toISOString()
          // Only record the new stamps once the update has actually been applied — a failed
          // download or restart is then retried rather than silently forgotten.
          cur.times = seedState(cur.times, cur.pendingTimes || {})
          cur.pending = []
          cur.pendingTimes = {}
          pushoverFor(s, 'PZ Mods Auto-Updated', 'Server was empty — restarted to apply updated mods.')
        }
        writeAutoUpdate(s, cur)
      }))
      return
    }
    if (cfg.pending.length) cfg.lastResult = 'Waiting to restart: ' + verdict.reason

    // Step 2 — ask Steam, at most hourly.
    if (!dueForCheck(Date.now(), cfg.lastCheck, AUTOUPDATE_CHECK_MS)) return finish()

    const ids = getIniList(s, 'WorkshopItems')
    fetchWorkshopTimes(ids, times => {
      const cur = readAutoUpdate(s)
      cur.lastCheck = new Date().toISOString()
      const seeded = Object.keys(cur.times).length
      const outdated = outdatedItems(cur.times, times)

      if (!seeded) {
        // First run: record what everything is at right now and do nothing else.
        cur.times = seedState(cur.times, times)
        cur.lastResult = 'Baseline recorded for ' + Object.keys(cur.times).length + ' mod(s) — updates will be detected from here on.'
        console.log('[autoupdate] ' + serverLabel(s) + ': baseline recorded (' + Object.keys(cur.times).length + ' mods)')
        return writeAutoUpdate(s, cur)
      }

      if (!outdated.length) {
        // Nothing changed, but keep stamps current for ids seen for the first time.
        cur.times = seedState(cur.times, times)
        cur.lastResult = 'Checked ' + Object.keys(times).length + ' mod(s) — all up to date.'
        return writeAutoUpdate(s, cur)
      }

      // Stamps are only recorded once a restart has applied them, so the same mod stays outdated
      // on every check until then — deliberately, since that is what retries a failed download.
      // What must not repeat is the download and the push for an id already sitting installed and
      // waiting: on a server that stays busy that fired every hour, for days.
      const installed = new Set(readQueue(s).filter(e => e.status === 'installed').map(e => String(e.id)))
      const waiting = (cur.pending || []).filter(id => installed.has(String(id)))
      const fresh = outdated.filter(id => !waiting.includes(id))

      cur.pending = [...new Set([...(cur.pending || []), ...outdated])]
      cur.pendingTimes = Object.assign({}, cur.pendingTimes || {}, times)

      if (!fresh.length) {
        cur.lastResult = cur.pending.length + ' update(s) downloaded — waiting for an empty server to restart.'
        return writeAutoUpdate(s, cur)
      }

      // The download is held back on a busy server, not just the restart. It stays in
      // cur.pending either way, so the next pass over an empty server picks it up.
      const dl = shouldDownload({ playersOnline: players })
      if (!dl.download) {
        cur.lastResult = fresh.length + ' update(s) found — download held: ' + dl.reason
        console.log('[autoupdate] ' + serverLabel(s) + ': ' + fresh.length + ' mod(s) updated on Steam — download held (' + dl.reason + ')')
        return writeAutoUpdate(s, cur)
      }

      console.log('[autoupdate] ' + serverLabel(s) + ': ' + fresh.length + ' mod(s) updated on Steam — downloading')
      cur.lastResult = fresh.length + ' update(s) downloading, queued ' + new Date().toISOString()
      writeAutoUpdate(s, cur)
      steamcmdDownload(s, fresh, 'autoupdate', null)
      pushoverFor(s, 'PZ Mod Updates Found', fresh.length + ' mod(s) updated on Steam — downloading, will restart when the server is empty.')
    })
  }

  activeDownloadCount(s, active => playerCountFor(s, players => decide(active, players)))
}

setInterval(() => { for (const s of allServers()) { try { runAutoUpdate(s) } catch (e) { console.error('[autoupdate]', e.message) } } }, AUTOUPDATE_TICK_MS)

app.get('/api/mods/autoupdate', (req, res) => {
  const s = srv(req)
  const cfg = readAutoUpdate(s)
  res.json({
    enabled: cfg.enabled,
    restartWhenEmpty: cfg.restartWhenEmpty,
    lastCheck: cfg.lastCheck,
    lastRestart: cfg.lastRestart,
    lastResult: cfg.lastResult,
    pending: cfg.pending || [],
    tracked: Object.keys(cfg.times || {}).length,
    checkIntervalHours: AUTOUPDATE_CHECK_MS / 3600000
  })
})

app.put('/api/mods/autoupdate', (req, res) => {
  const s = srv(req)
  const { enabled, restartWhenEmpty } = req.body || {}
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' })
  const cfg = readAutoUpdate(s)
  cfg.enabled = enabled
  if (typeof restartWhenEmpty === 'boolean') cfg.restartWhenEmpty = restartWhenEmpty
  if (!enabled) cfg.lastResult = 'Disabled.'
  writeAutoUpdate(s, cfg)
  res.json({ success: true, enabled: cfg.enabled, restartWhenEmpty: cfg.restartWhenEmpty })
})

// Checks Steam now and downloads anything outdated, whether or not the hourly check is enabled.
// With auto-update off this downloads only — shouldRestart() will not restart the server.
app.post('/api/mods/autoupdate/check', (req, res) => {
  const s = srv(req)
  const cfg = readAutoUpdate(s)
  cfg.lastCheck = null // force the Steam call regardless of when the last one ran
  writeAutoUpdate(s, cfg)
  runAutoUpdate(s, true)
  res.json({ success: true, message: 'Check started — results appear here within a few seconds.' })
})

// --- Server alerts ---
//
// One place that answers "is anything wrong with this server right now", pulling from every
// source that already knows something: dependency analysis, the disk audit, the download queue,
// and errors in both log streams. Nothing here is new detection — it is the existing signals
// gathered so the dashboard doesn't require visiting four tabs to notice a problem.

// The PZ log runs to tens of thousands of lines; scanning it on every dashboard poll would be
// wasteful, so results are cached briefly.
const ALERT_LOG_TTL = 30 * 1000
const alertLogCache = {} // [serverId] = { at, server: [], manager: [] }

// Collapses repeated errors into one entry with a count. Numbers, hashes and file paths are
// stripped from the grouping key so "missing X.xml" and "missing Y.xml" group as one problem.
function summariseLogErrors(text, pattern) {
  const groups = new Map()
  for (const raw of String(text || '').split('\n')) {
    if (!pattern.test(raw)) continue
    const line = stripAnsi(raw).trim()
    if (!line) continue
    const key = line
      .replace(/^\S*\s*/, m => m)
      .replace(/f:\d+ st:[\d,]+/g, '')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/g, '')
      .replace(/"[^"]*"/g, '"…"')
      .replace(/\/\S+/g, '/…')
      .replace(/\d{3,}/g, 'N')
      .slice(0, 160)
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { count: 1, sample: line.slice(0, 240) })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 8)
}

function collectLogAlerts(s, cb) {
  const hit = alertLogCache[s.id]
  if (hit && Date.now() - hit.at < ALERT_LOG_TTL) return cb(hit)
  const done = { at: Date.now(), server: [], manager: [] }
  let pending = 2
  const finish = () => { if (--pending <= 0) { alertLogCache[s.id] = done; cb(done) } }
  docker.logs(s.container, ['--since', '60m', '--tail', '4000'], { maxBuffer: 16 * docker.MB }, (e, out) => {
    done.server = summariseLogErrors(out, /^ERROR|SEVERE|FATAL/)
    finish()
  })
  const own = ownContainerId()
  if (!own) return finish()
  docker.logs(own, ['--since', '60m', '--tail', '2000'], { maxBuffer: 8 * docker.MB }, (e, out) => {
    done.manager = summariseLogErrors(out, /error|failed|exception/i)
    finish()
  })
}

app.get('/api/alerts', (req, res) => {
  const s = srv(req)
  const alerts = []
  const push = (severity, category, title, detail, extra) =>
    alerts.push(Object.assign({ severity, category, title, detail }, extra || {}))

  // Dependencies
  let depIssues = []
  try {
    const meta = installedModMeta(s)
    depIssues = sortIssues(analyzeDependencies({
      enabled: getIniList(s, 'Mods'), installed: Object.keys(meta), meta, ignores: readDepIgnores(s)
    }))
  } catch (e) {}
  const conflicts = depIssues.filter(i => i.type === 'incompatible')
  const missingDeps = depIssues.filter(i => i.type === 'missing')
  const disabledDeps = depIssues.filter(i => i.type === 'disabled')
  const orderIssues = depIssues.filter(i => i.type === 'order')
  if (conflicts.length) push('error', 'mods', conflicts.length + ' mod conflict(s)', conflicts.map(i => i.modId + ' ⇄ ' + i.dependency).join(', '), { tab: 'mods' })
  if (missingDeps.length) push('error', 'mods', missingDeps.length + ' missing dependenc(ies)', missingDeps.map(i => i.modId + ' → ' + i.dependency).join(', '), { tab: 'mods' })
  if (disabledDeps.length) push('warn', 'mods', disabledDeps.length + ' dependenc(ies) installed but not loaded', disabledDeps.map(i => i.modId + ' → ' + i.dependency).join(', '), { tab: 'mods' })
  if (orderIssues.length) push('info', 'mods', orderIssues.length + ' load-order issue(s)', orderIssues.map(i => i.modId + ' should load after ' + i.dependency).join(', '), { tab: 'mods' })

  // Disk / files
  let audit = null
  try { audit = auditServer(s) } catch (e) {}
  if (audit) {
    if (audit.missingContent.length) push('error', 'files', audit.missingContent.length + ' registered mod(s) missing files', 'Registered in WorkshopItems but nothing on disk: ' + audit.missingContent.join(', '), { tab: 'mods' })
    if (audit.phantomEnabled.length) push('warn', 'files', audit.phantomEnabled.length + ' enabled mod id(s) not provided by any install', audit.phantomEnabled.join(', '), { tab: 'mods' })
    if (audit.notLoadable.length) {
      push('error', 'files', audit.notLoadable.length + ' enabled mod id(s) the game cannot load',
        audit.notLoadable.join(', ') + '. Not present in the install tree or in the mods folder, so the server starts without them and drops their items from the save.', { tab: 'mods' })
    }
    // Ranked as an error: this is the one that makes a restart come up differently each time, and
    // it stays invisible until someone reads a boot log line by line.
    if (audit.duplicateIds.length) {
      push('error', 'files', audit.duplicateIds.length + ' mod id(s) claimed by more than one folder',
        audit.duplicateIds.map(d => d.modId + ' ← ' + d.providers.map(p => p.workshopId + '/' + p.folder).join(' + ')).join(' | ') +
        '. PZ loads whichever it finds first, so the server boots differently each restart. Exclude the folder you do not want.', { tab: 'mods' })
    }
    if (audit.unregistered.length || audit.orphanFolders.length) {
      push('warn', 'files', 'Orphaned mod files on disk (' + audit.reclaimableHuman + ' reclaimable)',
        audit.unregistered.length + ' unregistered Workshop item(s), ' + audit.orphanFolders.length + ' stray mods folder(s)', { tab: 'mods' })
    }
    if (audit.freeBytes && audit.freeBytes < 10 * 1024 * 1024 * 1024) {
      push('error', 'disk', 'Low disk space: ' + audit.freeHuman + ' free', 'Each mod is stored twice (workshop copy + server mods folder).')
    }
  }

  // Mods the curators dropped. Nothing was deleted, so this is the nudge to act: the mods are
  // still loaded and will stay loaded until they are removed and the server restarts.
  try {
    const dropped = allDroppedItems(s)
    if (dropped.length) {
      push('warn', 'collections', dropped.length + ' mod(s) dropped from collections — remove and restart',
        'Still installed and loading: ' + dropped.map(d => d.id).join(', ') +
        '. Remove them in Mods, then restart the server to apply.', { tab: 'mods' })
    }
  } catch (e) {}

  // Downloads: failures, and what changed recently
  const queue = readQueue(s)
  const failed = queue.filter(e => e.status === 'failed')
  if (failed.length) push('error', 'downloads', failed.length + ' failed download(s)', failed.slice(0, 5).map(e => e.id + ': ' + (e.error || 'unknown')).join(' | '), { tab: 'mods' })
  const dayAgo = Date.now() - 24 * 3600 * 1000
  const recent = queue.filter(e => e.status === 'installed' && e.updatedAt && new Date(e.updatedAt).getTime() > dayAgo)
  if (recent.length) push('info', 'updates', recent.length + ' mod(s) installed or updated in the last 24h', recent.slice(0, 8).map(e => (e.modIds || [e.id]).join(', ')).join(' · '), { tab: 'mods' })

  collectLogAlerts(s, logs => {
    for (const g of logs.server) {
      push(g.count > 50 ? 'warn' : 'info', 'server-log', g.count + '× ' + (g.sample.slice(0, 90)), g.sample, { tab: 'logs' })
    }
    for (const g of logs.manager) {
      push('warn', 'manager-log', g.count + '× ' + (g.sample.slice(0, 90)), g.sample, { tab: 'logs' })
    }
    const rank = { error: 0, warn: 1, info: 2 }
    alerts.sort((a, b) => rank[a.severity] - rank[b.severity])
    res.json({
      alerts,
      counts: {
        error: alerts.filter(a => a.severity === 'error').length,
        warn: alerts.filter(a => a.severity === 'warn').length,
        info: alerts.filter(a => a.severity === 'info').length
      },
      generatedAt: new Date().toISOString()
    })
  })
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
//
// Syncing is purely additive. Mods the curator has dropped are recorded on the registry entry
// and surfaced — in the Mods tab and as an alert — but never deleted here. Deleting one out from
// under a running server desyncs every connected client, and a mod vanishing as a silent side
// effect of "check for updates" is indistinguishable from the server eating someone's save. The
// operator removes them and restarts when it suits them.
function installCollection(s, collectionId, cb) {
  resolveCollectionLeaves(collectionId, (err, leaves, nested) => {
    if (err) return cb(err)
    getTitles([collectionId], titles => {
      // Captured before the upsert overwrites it — this is what the collection used to contain.
      const existing = readCollections(s).find(c => c.id === collectionId)
      const previous = (existing && existing.items) || []
      const installed = getIniList(s, 'WorkshopItems')
      const have = new Set(installed)
      const todo = leaves.filter(id => !have.has(id) || !hasModContent(s, id))
      const dropped = droppedItems({
        knownDropped: (existing && existing.droppedItems) || [],
        previous,
        leaves,
        otherCollections: readCollections(s).filter(c => c.id !== collectionId),
        installed
      })
      upsertCollection(s, {
        id: collectionId,
        title: titles[collectionId] || '',
        items: leaves,
        nestedCollections: nested || [],
        droppedItems: dropped,
        lastSynced: new Date().toISOString()
      })
      if (dropped.length) logFor(s, 'collection ' + collectionId + ': ' + dropped.length + ' dropped mod(s) still installed, awaiting removal [' + dropped.join(', ') + ']')
      logFor(s, 'collection ' + collectionId + ' synced: ' + leaves.length + ' item(s), ' + todo.length + ' to download')
      if (todo.length) steamcmdDownload(s, todo, 'collection', collectionId)
      cb(null, {
        total: leaves.length, queued: todo.length, nested: (nested || []).length,
        dropped: dropped.length, droppedIds: dropped
      })
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

// Every mod the curators have dropped, across every tracked collection, that is still installed.
// One flat list because that is how it gets acted on: remove them, then restart once.
function allDroppedItems(s) {
  const seen = new Set()
  const out = []
  for (const c of readCollections(s)) {
    for (const id of (c.droppedItems || [])) {
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, collectionId: c.id, collectionTitle: c.title || '' })
    }
  }
  return out
}

app.get('/api/collections/dropped', (req, res) => res.json({ dropped: allDroppedItems(srv(req)) }))

// Clear an id from every collection's dropped list without touching the files. For the case where
// the operator decides to keep a mod the curator dropped — otherwise every sync re-reports it.
app.post('/api/collections/dropped/:workshopId/keep', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.params
  const list = readCollections(s)
  for (const c of list) {
    if (c.droppedItems) c.droppedItems = c.droppedItems.filter(id => id !== workshopId)
  }
  writeCollections(s, list)
  res.json({ success: true, id: workshopId })
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
      removeWorkshopItem(s, wid)
      removed++
    }
  }
  res.json({ success: true, removedMods: removed })
})

// --- Scheduled collection auto-sync ---
// Config lives alongside the registry so it survives restarts. Off by default.
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
    let droppedTotal = 0
    let pending = list.length
    for (const c of list) {
      installCollection(s, c.id, (err, r) => {
        if (!err && r) { queuedTotal += r.queued; droppedTotal += r.dropped || 0 }
        if (--pending <= 0 && (queuedTotal > 0 || droppedTotal > 0)) {
          const parts = []
          if (queuedTotal) parts.push('queued ' + queuedTotal + ' new/missing mod(s)')
          // Deliberately worded as an outstanding task, not a completed one — nothing was removed.
          if (droppedTotal) parts.push('found ' + droppedTotal + ' mod(s) dropped from their collection, still installed — remove them and restart')
          pushoverFor(s, 'PZ Collection Sync', 'Auto-sync ' + parts.join(' and ') + '.')
        }
      })
    }
  }
}, 10 * 60 * 1000)

// ===== SERVER CONFIG =====


app.get('/api/config', (req, res) => {
  const s = srv(req)
  res.json(getFullIni(s))
})

app.put('/api/config', (req, res) => {
  const s = srv(req)
  const updates = req.body || {}
  const changed = []
  for (const [k, v] of Object.entries(updates)) {
    if (INI_KEY_RE.test(k) && typeof v === 'string') { setIniValue(s, k, v); changed.push(k) }
  }
  if (changed.length) logFor(s, 'server config updated: ' + changed.join(', '))
  res.json({ success: true })
})

// ===== SANDBOX / MOD OPTIONS =====
//

app.get('/api/config/sandbox', (req, res) => {
  const s = srv(req)
  try {
    const content = fs.readFileSync(sandboxPath(s), 'utf8')
    const parsed = parseSandbox(content)
    res.json({ sections: parsed.sections, raw: content })
  } catch (e) {
    res.status(404).json({ error: 'SandboxVars file not found', detail: e.message })
  }
})

// Structured save. Accepts { updates: { "Section.Key": value, ... } }.
//
// Everything is validated first — if any single value is invalid, nothing is written and all
// errors come back at once. Only then is a timestamped backup taken and the file rewritten
// line-by-line, so unedited lines (including every comment) are preserved byte-for-byte.
app.put('/api/config/sandbox', (req, res) => {
  const s = srv(req)
  const body = req.body || {}

  // Raw-mode escape hatch, still validated for structure before it's allowed to land.
  if (typeof body.content === 'string') {
    if (!body.content.trim()) return res.status(400).json({ error: 'Empty content' })
    if (!sandboxStructureOk(body.content)) {
      return res.status(400).json({ error: 'Unbalanced braces — the file would be invalid Lua. Nothing was saved.' })
    }
    try {
      const backup = sandboxPath(s) + '.' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.bak'
      fs.copyFileSync(sandboxPath(s), backup)
      fs.writeFileSync(sandboxPath(s), body.content)
      return res.json({ success: true, backup: path.basename(backup), mode: 'raw' })
    } catch (e) { return res.status(500).json({ error: e.message }) }
  }

  const updates = body.updates
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'No updates provided' })

  let content, parsed
  try {
    content = fs.readFileSync(sandboxPath(s), 'utf8')
    parsed = parseSandbox(content)
  } catch (e) { return res.status(500).json({ error: 'Could not read SandboxVars: ' + e.message }) }

  const byId = {}
  for (const sec of parsed.sections) for (const f of sec.fields) byId[f.section + '.' + f.key] = f

  // Validate everything before touching the file.
  const errors = []
  const applies = []
  for (const [id, value] of Object.entries(updates)) {
    const field = byId[id]
    if (!field) { errors.push(id + ': unknown option (was the file changed elsewhere?)'); continue }
    const err = validateSandboxValue(field, value)
    if (err) { errors.push(err); continue }
    applies.push({ field, formatted: formatSandboxValue(field, value) })
  }
  if (errors.length) return res.status(400).json({ error: 'Validation failed — nothing was saved', errors })

  // Surgical per-line replacement: only the value between "Key = " and the trailing comma moves.
  const lines = content.split('\n')
  let changed = 0
  for (const { field, formatted } of applies) {
    const idx = field.line - 1
    const line = lines[idx]
    const m = line && line.match(SANDBOX_KEY_RE)
    if (!m || m[2] !== field.key) {
      return res.status(409).json({ error: 'SandboxVars changed on disk while editing (line ' + field.line + ' no longer holds ' + field.key + '). Reload and try again.' })
    }
    const newLine = m[1] + field.key + ' = ' + formatted + ','
    if (newLine !== line) { lines[idx] = newLine; changed++ }
  }
  const out = lines.join('\n')

  if (!sandboxStructureOk(out)) {
    return res.status(500).json({ error: 'Refusing to save: result failed the structure check.' })
  }
  // Round-trip check — the rewritten file must still parse to the same set of options.
  try {
    const reparsed = parseSandbox(out)
    const before = parsed.sections.reduce((n, sec) => n + sec.fields.length, 0)
    const after = reparsed.sections.reduce((n, sec) => n + sec.fields.length, 0)
    if (before !== after) {
      return res.status(500).json({ error: 'Refusing to save: option count changed (' + before + ' → ' + after + ').' })
    }
  } catch (e) {
    return res.status(500).json({ error: 'Refusing to save: result no longer parses (' + e.message + ')' })
  }

  try {
    const backup = sandboxPath(s) + '.' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.bak'
    fs.copyFileSync(sandboxPath(s), backup)
    fs.writeFileSync(sandboxPath(s), out)
    res.json({ success: true, changed, backup: path.basename(backup) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Lists the timestamped backups this editor has written, newest first.
app.get('/api/config/sandbox/backups', (req, res) => {
  const s = srv(req)
  const dir = path.dirname(sandboxPath(s))
  const base = path.basename(sandboxPath(s))
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.') && f.endsWith('.bak'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime.toISOString() }))
      .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
    res.json({ backups: files })
  } catch (e) { res.json({ backups: [] }) }
})

// ===== SYSTEM STATS =====

app.get('/api/sysinfo', (req, res) => {
  const s = srv(req)
  docker.stats(s.container, (err, out) => {
    const parts = (out || '').trim().split('|')
    const cpu = parts[0] || '—'
    const mem = parts[1] || '—'
    const memPct = parts[2] || '—'
    disk.df('/workshop', cols => res.json({ cpu, mem, memPct, disk: cols }))
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
  docker.logs(s.container, ['--tail', '2000'], { maxBuffer: 8 * docker.MB }, (err, out) => {
    const lines = (out || '').split('\n')
    res.json({ active: parseDownloads(lines), queue: readQueue(s).slice().reverse() })
  })
})

// Clears the download activity list. Only settled entries go — anything still 'queued' is work in
// flight, and dropping it would orphan the download (reconcileDownloads would never register the
// mod when it lands). Purely a display concern: no mod files or ini entries are touched.
app.delete('/api/downloads/queue', (req, res) => {
  const s = srv(req)
  const before = readQueue(s)
  const kept = before.filter(e => e.status === 'queued')
  writeQueue(s, kept)
  res.json({ success: true, cleared: before.length - kept.length, kept: kept.length })
})

// ===== NOTIFICATIONS =====

app.get('/api/notifications', (req, res) => {
  res.json(publicNotifConfig())
})

// Merged over what is already saved, not swapped for it: the previous version wrote req.body
// straight to disk, so a partial payload from any client silently erased the Discord settings and
// every event toggle it did not happen to mention.
//
// A blank secret means "leave it alone", which is what lets the UI render a
// "configured — leave blank to keep" field instead of round-tripping the token through the browser.
app.put('/api/notifications', (req, res) => {
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

app.post('/api/notifications/test', (req, res) => {
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
  const p = validBackupPath(srv(req), qs(req.query.type), qs(req.query.name))
  if (!p) return res.status(404).json({ error: 'Backup not found' })
  res.download(p)
})

// List contents of an existing backup (for inspection)
app.get('/api/backups/peek', (req, res) => {
  const p = validBackupPath(srv(req), qs(req.query.type), qs(req.query.name))
  if (!p) return res.status(404).json({ error: 'Backup not found' })
  archive.listMembers(p, (err, names) => {
    if (err) return res.status(500).json({ error: err.message })
    // The same 50-line preview as before, plus the count so a truncated list says so.
    res.json({ contents: names.slice(0, 50).join('\n') || '(empty)', members: names.length })
  })
})

// Restore from an existing server backup
app.post('/api/backups/restore', (req, res) => {
  const s = srv(req)
  const { type, name } = req.body || {}
  const p = validBackupPath(s, typeof type === 'string' ? type : '', typeof name === 'string' ? name : '')
  if (!p) return res.status(404).json({ error: 'Backup not found' })

  archive.extractInto(p, s.data, (err, info) => {
    if (err) return res.status(500).json({ error: err.message })
    logFor(s, 'restored backup "' + name + '" (' + (info ? info.members : 0) + ' entries)')
    res.json({ success: true, members: info ? info.members : 0 })
  })
})

// Upload a backup file and restore from it.
// Accepts a raw application/octet-stream body; the client sets X-Backup-Ext to 'zip' or 'tar.gz'.
//
// Capped: the volume this writes to is the one the game server is saving the world onto, so an
// unbounded upload was a way to stop the server by filling its disk. The archive is also checked
// member by member before anything is extracted — see src/services/archive.js.
app.post('/api/backups/upload', (req, res) => {
  const s = srv(req)
  const ext = header(req, 'x-backup-ext').toLowerCase() === 'tar.gz' ? 'tar.gz' : 'zip'
  const declared = Number(header(req, 'content-length') || 0)
  if (declared && declared > archive.MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: 'Backup is larger than the ' + humanBytes(archive.MAX_UPLOAD_BYTES) + ' upload limit' })
  }

  const tempPath = '/tmp/pz-restore-upload-' + s.id + '.' + (ext === 'tar.gz' ? 'tar.gz' : 'zip')
  const ws = fs.createWriteStream(tempPath)
  const cleanup = () => fs.unlink(tempPath, () => {})

  let received = 0
  let aborted = false
  const fail = (status, message) => {
    if (aborted) return
    aborted = true
    req.unpipe(ws)
    ws.destroy()
    cleanup()
    if (!res.headersSent) res.status(status).json({ error: message })
  }

  // Content-Length can lie, or be absent on a chunked upload, so the real limit is enforced on the
  // bytes that actually arrive.
  req.on('data', chunk => {
    received += chunk.length
    if (received > archive.MAX_UPLOAD_BYTES) {
      fail(413, 'Backup exceeded the ' + humanBytes(archive.MAX_UPLOAD_BYTES) + ' upload limit')
      req.destroy()
    }
  })

  req.pipe(ws)

  ws.on('finish', () => {
    if (aborted) return
    archive.extractInto(tempPath, s.data, (err, info) => {
      cleanup()
      if (err) return res.status(400).json({ error: err.message })
      logFor(s, 'restored uploaded backup (' + humanBytes(received) + ', ' + (info ? info.members : 0) + ' entries)')
      res.json({ success: true, members: info ? info.members : 0 })
    })
  })

  ws.on('error', e => fail(500, e.message))
  req.on('error', e => fail(500, e.message))
})


// ===== ONLINE PLAYERS =====

app.get('/api/players/online', (req, res) => {
  const players = onlinePlayersFor(srv(req))
  res.json({ online: players.length, players })
})

// 7777 is the port *inside* the container; docker-compose publishes it on the host (7778 in the
// reference compose). Nothing in here can see the host-side mapping, so say which one this is
// rather than printing a bare port that doesn't match the URL people actually use.
// Servers are listed as id + resolved label, because an id is just a slug the user can rename and
// on its own it says nothing about which server it refers to.
// Registered after every route, because Express only reaches an error handler for what was
// registered before it.
installErrorHandler(app)

app.listen(7777, () => {
  console.log(
    'PZ Server Manager listening on container port 7777 (published to the host by docker-compose) — servers: ' +
    (allServers().map(s => s.id + ' "' + serverLabel(s) + '"').join(', ') || 'none found')
  )
  // The operator needs the token to get in, and on a first run `docker logs` is the only place it
  // exists. An operator-set MANAGER_TOKEN is never echoed — they already have it, and printing it
  // would copy a secret they chose deliberately into the log stream the UI displays.
  if (MANAGER_AUTH.source === 'env') {
    logFor(null, 'auth: using MANAGER_TOKEN from the environment')
  } else {
    logFor(null, 'auth: manager token is ' + MANAGER_AUTH.token +
      (MANAGER_AUTH.source === 'file' ? ' (from ' + '/pz-data/manager-token' + ')' : ' (generated — set MANAGER_TOKEN to pin it)'))
  }
  // A startup summary, so the Manager Logs pane opens with the state it is working from rather
  // than a bare "listening" line and then silence until something happens.
  for (const s of allServers()) {
    try {
      logFor(s, 'container=' + s.container + ' data=' + s.data + ' workshop=' + s.workshop + ' state=' + (s.state || 'unknown'))
      logFor(s, getIniList(s, 'WorkshopItems').length + ' Workshop item(s) registered, ' +
        getIniList(s, 'Mods').length + ' mod(s) in load order')
      const au = readAutoUpdate(s)
      logFor(s, 'mod auto-update ' + (au.enabled ? 'ON (hourly, restart-when-empty ' + (au.restartWhenEmpty ? 'on' : 'off') + ')' : 'off'))
      const as = readAutoSync(s)
      logFor(s, 'collection auto-sync ' + (as.enabled ? 'ON every ' + as.intervalHours + 'h' : 'off') +
        ' · ' + readCollections(s).length + ' collection(s) tracked')
    } catch (e) { logFor(s, 'startup summary unavailable: ' + e.message) }
  }
  const n = readNotifConfig()
  logFor(null, 'notifications ' + (n.enabled ? 'ON' : 'off') +
    ' · Discord status ' + ((n.discord && n.discord.enabled) ? 'ON' : 'off'))
  logFor(null, 'monitors: crash 60s · ready 20s · downloads 15s · user log 10s · auto-update 5m · Discord 5m')
})
