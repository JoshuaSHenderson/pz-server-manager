// Deciding when a start or restart has actually produced a server that accepts players.
//
// Pure and tested (test_ready.js) because getting it wrong is loud: it pushes a "Server Ready"
// alert to everyone, and it did so within seconds of every restart while quoting a wait of 153m 8s.
//
// Two facts about docker make this trickier than "grep the log for the marker":
//
//   1. `docker restart` takes seconds to come back, and until it does `docker inspect` still
//      reports the *previous* run's StartedAt — so `docker logs --since <that>` still contains the
//      previous run's marker. A poll that lands in that window announces the old boot as the new
//      one. readyMinStart is the floor: the run being waited on started after the restart was
//      issued, so anything older is the run we just replaced.
//
//   2. Polling every 20s cannot time anything to better than 20s. `docker logs -t` prefixes each
//      line with the moment it was written, so the wait is measured from container start to the
//      moment PZ printed the marker, not to whenever the poll noticed it.
//
// Returns either { wait: <why> } or { ready: true, seconds, took }.
function readyCheck(o) {
  o = o || {}
  const startedMs = Date.parse(o.startedAt || '')
  if (!startedMs) return { wait: 'no container start time' }
  // Strictly older than the floor is the previous run. Equal is fine: a container that was already
  // up when we started watching (the crash monitor's case) passes readyMinStart 0.
  if (startedMs < (o.readyMinStart || 0)) return { wait: 'container has not come back up yet' }

  const line = String(o.markerLine || '').trim()
  if (!line) return { wait: 'no ready marker yet' }

  // `docker logs -t` writes "<rfc3339> <the line>". Without -t, or on anything unparseable, fall
  // back to now — a wait that is up to one poll long, rather than no answer at all.
  const stamped = Date.parse(line.split(/\s+/)[0])
  const readyAt = stamped || o.now || Date.now()
  const seconds = Math.max(0, Math.round((readyAt - startedMs) / 1000))
  return { ready: true, seconds, took: formatWait(seconds) }
}

function formatWait(secs) {
  const mins = Math.floor(secs / 60)
  return mins ? mins + 'm ' + (secs % 60) + 's' : secs + 's'
}

module.exports = { readyCheck, formatWait }
