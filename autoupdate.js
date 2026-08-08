// Mod auto-update decisions.
//
// Pure on purpose: the outcome of these functions restarts a running game server. Tested in
// test_autoupdate.js. Everything here is deliberately conservative — any uncertainty means wait,
// because a wrong "yes" drops whoever is currently playing.

// Which installed items Steam has updated since we last recorded them.
//
// An id with no recorded stamp is NOT reported as outdated. The first check after enabling would
// otherwise flag all ~150 installed mods at once, re-download them and restart the server for no
// reason. First sighting seeds the baseline; only a later increase counts as an update.
function outdatedItems(stored, steamTimes) {
  const out = []
  for (const id of Object.keys(steamTimes || {})) {
    const t = steamTimes[id]
    if (!t) continue                          // Steam returned nothing usable for this id
    const prev = (stored || {})[id]
    if (prev === undefined) continue          // first sighting — seed only
    if (t > prev) out.push(id)
  }
  return out
}

// Records the stamps we have now. Only called once an update has actually been applied, so a
// failed download is retried on the next pass instead of being silently forgotten.
function seedState(stored, steamTimes) {
  const next = Object.assign({}, stored || {})
  for (const id of Object.keys(steamTimes || {})) {
    if (steamTimes[id]) next[id] = steamTimes[id]
  }
  return next
}

function dueForCheck(now, lastCheck, intervalMs) {
  if (!lastCheck) return true
  return (now - new Date(lastCheck).getTime()) >= intervalMs
}

// A restart is only safe when an update is genuinely pending, nothing is still downloading, and
// nobody is connected. Returns the reason either way so it can be logged and shown in the UI.
function shouldRestart(o) {
  o = o || {}
  if (!o.enabled) return { restart: false, reason: 'auto-update disabled' }
  if (!o.restartWhenEmpty) return { restart: false, reason: 'restart-when-empty disabled' }
  if (!o.pending || !o.pending.length) return { restart: false, reason: 'no pending updates' }
  if ((o.activeDownloads || 0) > 0) return { restart: false, reason: 'downloads still running' }
  // Unknown player count is treated as "someone might be on" — never guess in favour of kicking.
  if (o.playersOnline === null || o.playersOnline === undefined) {
    return { restart: false, reason: 'player count unknown' }
  }
  if (o.playersOnline > 0) {
    return { restart: false, reason: o.playersOnline + ' player(s) online — waiting for an empty server' }
  }
  return { restart: true, reason: 'updates downloaded and server empty' }
}

// Downloading is gated on an empty server for the same reason restarting is.
//
// A Workshop download is hundreds of MB pulled at line speed. On a home
// connection that fills the WAN queue, and every player crossing it sees
// their latency jump — which in this game reads as "I can't get in the car"
// and "the door won't open", because those are server-authoritative actions
// that need a round trip, while client-predicted walking carries on looking
// fine. Anyone on the LAN notices nothing at all, which is what makes it
// look like the server rather than the link.
//
// Waiting costs nothing: shouldRestart() will not apply the update until the
// server is empty anyway, so downloading early only moves the disruption
// earlier — it never makes the mod live any sooner.
function shouldDownload(o) {
  o = o || {}
  // Same rule as shouldRestart: not knowing is treated as "someone is on".
  if (o.playersOnline === null || o.playersOnline === undefined) {
    return { download: false, reason: 'player count unknown' }
  }
  if (o.playersOnline > 0) {
    return { download: false, reason: o.playersOnline + ' player(s) online — waiting for an empty server' }
  }
  return { download: true, reason: 'server empty' }
}

module.exports = { outdatedItems, seedState, dueForCheck, shouldRestart, shouldDownload }
