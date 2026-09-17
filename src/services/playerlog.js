// Who is connected, from PZ's own user event log.
//
// The log is the only source that names players, so it feeds the dashboard, the Discord card and
// the join/leave/death notifications. It cannot answer "is the server empty", though, and that
// distinction is load-bearing: PZ creates <date>_user.txt on the first connection of a session, so
// after a restart nobody has joined there is no log at all. "Cannot see" reads identically to a
// stale log full of ghosts — which is exactly the state the auto-updater must recognise as empty,
// and why it once deadlocked, only restarting while a log existed and every restart removing it.
//
// So playerCountFor() asks the server itself over RCON, and returns null for "genuinely unknown".
// Callers must keep treating null as "someone might be on".

const fs = require('fs')
const path = require('path')
const { logDir } = require('../paths')
const { safeReaddir } = require('../util/fsx')
const { rconCommand } = require('../infra/rcon')
const { readNotifConfig, pushoverFor } = require('./notify')
const { logFor } = require('../log')
const {
  makeState: makePlayerState, applyLine: applyPlayerLine, replay: replayPlayerLog,
  onlineNames: playerNames, parseConnectedCount,
} = require('../../lib/players')

/** @typedef {import('../paths').Server} Server */

// Where each server's tail has got to, and who it believes is online.
//
// `players` was previously bolted onto the shared monitor state at first use rather than declared,
// so what the poller actually kept between ticks was not visible anywhere.
//
// Private: the poller below is the only writer.
/**
 * @typedef {{ userLogPath: string|null, userLogPos: number,
 *             players?: ReturnType<typeof makePlayerState> }} TailState
 */
/** @type {Record<string, TailState>} */
const tailState = {}

/** @param {Server} s @returns {TailState} */
function tail(s) {
  if (!tailState[s.id]) tailState[s.id] = { userLogPath: null, userLogPos: 0 }
  return tailState[s.id]
}

// Online players parsed from the user event log (shared by API + Discord)
function onlinePlayersFor(s) {
  const logFile = findLatestUserLog(s)
  if (!logFile) return []
  try {
    return replayPlayerLog(fs.readFileSync(logFile, 'utf8')).online
  } catch { return [] }
}

// How many players are connected, asked of the server itself.
//
// The user log cannot answer this on an empty server: PZ creates <date>_user.txt on the first
// connection of a session, so after a restart that nobody has joined there is no log at all —
// which reads as "cannot see" and is indistinguishable from a stale log full of ghosts. That is
// precisely the state the auto-updater must recognise as empty, so it deadlocked: it would only
// restart while a log existed, and every restart took the log away.
//
// cb(null) means genuinely unknown (RCON down, server still loading) — callers must keep treating
// that as "someone might be on".
function playerCountFor(s, cb) {
  rconCommand(s, 'players', (err, out) => {
    const n = err ? null : parseConnectedCount(out)
    if (n !== null) return cb(n)
    cb(findLatestUserLog(s) ? onlinePlayersFor(s).length : null)
  })
}

// Player event log monitor
function findLatestUserLog(s) {
  try {
    return fs.readdirSync(logDir(s))
      .filter(f => f.endsWith('_user.txt'))
      .map(f => path.join(logDir(s), f))
      .sort((a, b) => fs.statSync(b).mtime.getTime() - fs.statSync(a).mtime.getTime())[0] || null
  } catch { return null }
}

function pollUserLog(s) {
  const cfg = readNotifConfig()
  if (!cfg.enabled || !cfg.events) return
  const ev = cfg.events
  if (!ev.playerJoin && !ev.playerLeave && !ev.playerSpawned && !ev.playerDied && !ev.playerKicked) return

  const latest = findLatestUserLog(s)
  if (!latest) return
  const st = tail(s)

  try {
    const size = fs.statSync(latest).size
    if (latest !== st.userLogPath) {
      // Seed from the whole file before skipping to the end. Without this the online map starts
      // empty, so anyone who connected before the manager (re)started would leave with nothing to
      // match against and no "Player Left" would ever fire. Events from the replay are discarded —
      // they already happened.
      //
      // A *rotation* is the opposite case: PZ restarted and opened a fresh log, so everything in
      // it is happening now. Seeding past it swallowed the first join after every restart. Read it
      // from the start instead and let the normal path below report it.
      const rotated = st.userLogPath !== null
      st.userLogPath = latest
      st.userLogPos = rotated ? 0 : size
      if (rotated) {
        st.players = makePlayerState()
        logFor(s, 'watching ' + path.basename(latest) + ' — new log after a server restart')
        return
      }
      try {
        st.players = replayPlayerLog(fs.readFileSync(latest, 'utf8')).state
        const names = playerNames(st.players)
        logFor(s, 'watching ' + path.basename(latest) + (names.length ? ' — ' + names.length + ' player(s) already connected: ' + names.join(', ') : ' — nobody connected'))
      } catch { st.players = makePlayerState() }
      return
    }
    if (size <= st.userLogPos) return

    const fd = fs.openSync(latest, 'r')
    const buf = Buffer.allocUnsafe(size - st.userLogPos)
    fs.readSync(fd, buf, 0, buf.length, st.userLogPos)
    fs.closeSync(fd)
    st.userLogPos = size

    // Connection state is tracked in players.js, which understands both log shapes PZ has used
    // and only reports genuine transitions — see the notes there.
    if (!st.players) st.players = makePlayerState()
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      const evt = applyPlayerLine(st.players, line)
      if (evt) {
        if (evt.type === 'join' && ev.playerJoin) pushoverFor(s, 'Player Joined', evt.name + ' joined the server')
        if (evt.type === 'leave' && ev.playerLeave) pushoverFor(s, 'Player Left', evt.name + ' left the server')
        // Off by default: this fires on every respawn, so on a deadly server it is chatty.
        if (evt.type === 'spawn' && ev.playerSpawned) {
          pushoverFor(s, 'Player Spawned', evt.name + (evt.respawn ? ' respawned into the world' : ' spawned into the world'))
        }
        continue
      }
      let m
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

module.exports = { onlinePlayersFor, playerCountFor, findLatestUserLog, pollUserLog }
