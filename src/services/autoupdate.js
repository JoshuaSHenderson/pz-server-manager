// Hourly: ask Steam whether any installed Workshop item has been updated, download the ones that
// have, and - once the downloads finish and the server is empty - restart so they take effect.
//
// Off by default, because it restarts a live game server. Every decision is therefore conservative,
// and the conservatism is the feature:
//
//   - a first sighting only seeds the baseline, so enabling this does not re-download 150 mods
//   - a restart needs a genuinely pending update, no downloads in flight, AND a confirmed-empty
//     server; "cannot tell" is never treated as empty
//   - the empty check asks the server over RCON rather than reading the user log, because an empty
//     server has no user log at all - see src/services/playerlog.js for the deadlock that caused
//
// The decisions themselves are pure and tested in lib/autoupdate.js. This file is the I/O around
// them.

const { autoUpdatePath } = require('../paths')
const { readJson, writeJson } = require('../util/fsx')
const { getIniList } = require('../domain/ini')
const { fetchWorkshopTimes } = require('../infra/steam')
const { readQueue, steamcmdDownload, parseDownloads } = require('./downloads')
const { playerCountFor } = require('./playerlog')
const { saveThen, bringUp } = require('./lifecycle')
const { pushoverFor } = require('./notify')
const { mstate, markAwaitingReady } = require('../monitors/state')
const { outdatedItems, seedState, dueForCheck, shouldRestart, shouldDownload } = require('../../lib/autoupdate')
const docker = require('../infra/docker')
const { logFor } = require('../log')
const registry = require('../registry/servers')
const reinstallState = require('./reinstall-state')

const serverLabel = registry.serverLabel

/** @typedef {import('../paths').Server} Server */

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

/** @param {Server} s */
function readAutoUpdate(s) {
  const def = { enabled: false, restartWhenEmpty: true, lastCheck: null, lastRestart: null, pending: [], times: {}, lastResult: '' }
  return Object.assign(def, readJson(autoUpdatePath(s), {}))
}

/**
 * Deliberately swallows a write failure. The baseline this persists is an optimisation - a lost
 * one means the next pass re-seeds from Steam, which is slow but correct - and a throw here would
 * escape into the monitor tick rather than anywhere that could act on it.
 * @param {Server} s @param {any} cfg
 */
function writeAutoUpdate(s, cfg) {
  try { writeJson(autoUpdatePath(s), cfg) }
  catch (e) { console.error('[autoupdate] could not persist state for ' + s.id + ': ' + e.message) }
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

module.exports = {
  readAutoUpdate, writeAutoUpdate, activeDownloadCount, runAutoUpdate,
  AUTOUPDATE_CHECK_MS, AUTOUPDATE_TICK_MS,
}
