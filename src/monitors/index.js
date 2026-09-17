// Every background monitor, and the one place they are started.
//
// These were eleven bare setInterval() calls at eleven different depths of server.js, most of them
// unguarded. Two problems that fixes:
//
//   1. A tick could re-enter while the previous one was still running. reconcileDownloads does
//      synchronous disk work that can exceed its own 15s period on a cold cache, so it overlapped
//      itself and two passes reconciled the same queue.
//   2. There was no list of what runs in the background, so the startup summary's line naming the
//      cadences was maintained by hand against code hundreds of lines away.
//
// every() below is the guard. It is deliberately per-monitor rather than per-server: the work
// inside each one already loops over servers, and a slow server should delay its own next tick
// rather than let a faster one run twice.

const registry = require('../registry/servers')
const { mstate, markAwaitingReady, SERVER_READY_MARKER, READY_WAIT_MS } = require('./state')
const { readNotifConfig, pushover, pushoverFor } = require('../services/notify')
const { reportDeadMods, reportModDrift } = require('../services/health')
const { parseDownloads, reconcileDownloads } = require('../services/downloads')
const { pollUserLog } = require('../services/playerlog')
const { readSchedule, minutesUntilRestart } = require('../services/schedule')
const { saveThen, bringUp, sendIngameMsg } = require('../services/lifecycle')
const { updateDiscordStatus } = require('../services/discord')
const { runAutoUpdate, AUTOUPDATE_TICK_MS } = require('../services/autoupdate')
const { installCollection, readAutoSync, writeAutoSync } = require('../services/collection-sync')
const { readCollections } = require('../services/collections')
const reinstallState = require('../services/reinstall-state')
const { readyCheck } = require('../../lib/ready')
const docker = require('../infra/docker')
const disk = require('../infra/disk')

const allServers = registry.all
const serverLabel = registry.serverLabel

/**
 * Run `fn` every `ms`, never twice at once.
 *
 * `fn` is handed a `done` callback because most of this work is callback-based and fans out over
 * servers; a monitor that forgets to call it simply stops running, which is loud enough to find.
 * A throw releases the guard too, or one bad tick would wedge the monitor forever.
 *
 * @param {string} name
 * @param {number} ms
 * @param {(done: () => void) => void} fn
 */
function every(name, ms, fn) {
  let running = false
  return setInterval(() => {
    if (running) return console.log('[monitor] ' + name + ': previous pass still running, skipping this tick')
    running = true
    let settled = false
    const done = () => { if (!settled) { settled = true; running = false } }
    try { fn(done) } catch (e) { done(); console.error('[monitor] ' + name + ' threw:', e && e.message) }
  }, ms)
}

/**
 * Fans a callback-per-server pass out and calls `done` once they have all reported.
 * @param {(s: any, next: () => void) => void} fn
 * @param {() => void} done
 */
function forEachServer(fn, done) {
  const servers = allServers()
  let pending = servers.length
  if (!pending) return done()
  for (const s of servers) {
    let called = false
    fn(s, () => { if (!called) { called = true; if (--pending === 0) done() } })
  }
}

// Which minute each server last fired a scheduled restart in, so a restart cannot fire twice
// within the same minute.
/** @type {Record<string, number>} */
const lastRestartMinute = {}

// Notices a container that went away without being asked to, and starts the readiness wait for
// one that has come back.
function crashMonitor(done) {
  forEachServer((s, next) => {
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
      next()
    })
  }, done)
}

// Watches for the readiness marker after a start/restart. Only looks at logs written since the
// container came up, so the previous run's marker can never be mistaken for this one's.
function readyMonitor(done) {
  forEachServer((s, next) => {
    const st = mstate(s)
    if (!st.awaitingReady) return next()
    if (Date.now() - (st.awaitingSince || 0) > READY_WAIT_MS) {
      st.awaitingReady = false
      console.log('[ready] ' + serverLabel(s) + ': gave up waiting for the ready marker')
      return next()
    }
    docker.inspect(s.container, '{{.State.StartedAt}}', (e1, startedAt) => {
      const since = (startedAt || '').trim()
      if (!since) return next()
      // -t so the marker carries the moment it was printed — see ready.js. The match and the
      // "last one wins" are done on the text rather than by `| grep -F ... | tail -1`.
      docker.logsContaining(s.container, ['-t', '--since', since], SERVER_READY_MARKER,
        { maxBuffer: 4 * docker.MB }, (err, lines) => {
          next()
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
  }, done)
}


// One filesystem is shared by every server here, so this is one check and one alert rather than
// one per server. Latched: it alerts on the way down and re-arms on the way back up, instead of
// paging every five minutes while the disk stays full.
let lowDiskAlerted = false
function lowDiskMonitor(done) {
  const cfg = readNotifConfig()
  if (!cfg.enabled || !cfg.events || !cfg.events.lowDisk) return done()
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
    done()
  })
}

// Fires once, on the edge where a server stops having downloads in flight.
function downloadCompleteMonitor(done) {
  const cfg = readNotifConfig()
  forEachServer((s, next) => {
    const st = mstate(s)
    if (!cfg.enabled || !cfg.events || !cfg.events.downloadComplete) { st.wasDownloading = false; return next() }
    docker.logs(s.container, ['--tail', '500'], { maxBuffer: 4 * docker.MB }, (err, out) => {
      const active = parseDownloads((out || '').split('\n'))
      const isDownloading = active.length > 0
      if (st.wasDownloading && !isDownloading) {
        pushoverFor(s, 'PZ Mods Updated', 'All Workshop downloads complete. Restart server to apply mod updates.')
      }
      st.wasDownloading = isDownloading
      next()
    })
  }, done)
}

// Scheduled restarts. Checked every minute because the schedule has minute resolution, and the
// ten/five/one-minute warnings have to land on their own minute.
function scheduleMonitor(done) {
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
  done()
}

// Tracked collections re-checked against Steam on the operator's chosen interval.
function autoSyncMonitor(done) {
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
  done()
}

/**
 * Starts every background monitor. Called once, from server.js, after the routes are mounted.
 *
 * The cadences are listed here and nowhere else — the startup summary reads this list rather than
 * restating it, so the two cannot drift apart.
 */
function start() {
  every('registry', 60_000, done => { registry.refreshServers(); done() })
  every('discord', 5 * 60_000, done => updateDiscordStatus(() => done()))
  every('crash', 60_000, crashMonitor)
  every('ready', 20_000, readyMonitor)
  every('lowDisk', 5 * 60_000, lowDiskMonitor)
  every('downloadComplete', 30_000, downloadCompleteMonitor)
  every('userLog', 10_000, done => { for (const s of allServers()) pollUserLog(s); done() })
  every('downloads', 15_000, done => { for (const s of allServers()) reconcileDownloads(s); done() })
  every('schedule', 60_000, scheduleMonitor)
  // Re-evaluated often even though Steam is only asked hourly: the restart condition (downloads
  // settled, server empty) is what this is really waiting for, and it can become true at any time.
  every('autoUpdate', AUTOUPDATE_TICK_MS, done => {
    for (const s of allServers()) {
      try { runAutoUpdate(s) } catch (e) { console.error('[autoupdate]', e && e.message) }
    }
    done()
  })
  every('collectionAutoSync', 10 * 60_000, autoSyncMonitor)
}

// For the startup summary, so the line an operator reads is generated from the schedule above.
const CADENCES = 'crash 60s · ready 20s · downloads 15s · user log 10s · auto-update 5m · Discord 5m'

module.exports = { start, every, forEachServer, CADENCES }
