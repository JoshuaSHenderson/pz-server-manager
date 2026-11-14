// Taking a container down, and bringing one back up.
//
// Every path that stops a server goes through saveThen(), and every path that starts one goes
// through bringUp(). That is the whole point of the file: two funnels, so a new caller cannot
// quietly skip either the pre-shutdown save or the exclusion sweep.
//
// Why the save has to be asked for over RCON rather than left to `docker stop`: PZ runs its
// shutdown hook, and the SaveAll inside it, only when the game process itself receives the signal.
// SIGTERM goes to the container's PID 1, which in this image is bash running entry.sh - it traps
// nothing and never execs, so the signal dies there and the JVM is SIGKILLed when the grace period
// expires. Every restart therefore left the world at its last autosave, up to SaveWorldEveryMinutes
// of play silently rolled back, which reads as corruption rather than a lost save. See lib/save.js.

const { rconCommand } = require('../infra/rcon')
const { applyExcludes } = require('./excludes')
const { saveThenGoDown } = require('../../lib/save')
const docker = require('../infra/docker')

/** @typedef {import('../paths').Server} Server */

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

module.exports = { saveThen, bringUp, sendIngameMsg }
