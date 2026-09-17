// What the background monitors remember between ticks.
//
// Held apart from the monitors themselves because three of these fields are written from outside:
// the stop and restart endpoints set `intentionalStop` so the crash monitor does not page about a
// shutdown the operator asked for, and every path that starts a container calls markAwaitingReady()
// so the readiness watcher knows which run to watch.
//
// Previously a bare `const monitorState = {}` in server.js with a comment listing five fields, two
// of which no longer lived here and two more of which were assigned at first use and appeared in
// no declaration at all.

/**
 * @typedef {{
 *   lastKnownStatus: string|null,
 *   intentionalStop: boolean,
 *   wasDownloading: boolean,
 *   awaitingReady?: boolean,
 *   awaitingSince?: number,
 *   readyMinStart?: number,
 * }} MonitorState
 */

/** @type {Record<string, MonitorState>} */
const monitorState = {}

/** @param {import('../paths').Server} s @returns {MonitorState} */
function mstate(s) {
  if (!monitorState[s.id]) {
    monitorState[s.id] = { lastKnownStatus: null, intentionalStop: false, wasDownloading: false }
  }
  return monitorState[s.id]
}

// "Started" only means the container is up. PZ then loads assets, mods and the world for a long
// while — on this server, minutes — and rejects connections until it prints this. That is the
// moment worth telling people about, not the container transition.
const SERVER_READY_MARKER = '*** SERVER STARTED ***'
const READY_WAIT_MS = 45 * 60 * 1000

/**
 * Start waiting for the readiness marker of the run that is about to begin.
 *
 * The run must have started *after* this instant. Callers issue their `docker restart` on the very
 * next line, and a restart takes a few seconds to come back — so for those seconds `docker inspect`
 * still reports the *old* run's StartedAt, and `docker logs --since <that>` still contains the old
 * run's marker. Watching without this floor announced "ready" within seconds of every restart, and
 * measured the wait from the previous boot: on this server that read as 153m 8s.
 *
 * @param {import('../paths').Server} s
 * @param {boolean} [alreadyRunning] true for the crash monitor, which notices a container that is
 *   already back up — there the current run *is* the one to watch, so no floor applies.
 */
function markAwaitingReady(s, alreadyRunning) {
  const st = mstate(s)
  st.awaitingReady = true
  st.awaitingSince = Date.now()
  st.readyMinStart = alreadyRunning ? 0 : Date.now()
}

module.exports = { mstate, markAwaitingReady, SERVER_READY_MARKER, READY_WAIT_MS }
