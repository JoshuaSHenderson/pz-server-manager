// Who is currently connected, parsed from the PZ user log.
//
// Pure and tested (test_players.js) because two things depend on it: the join/leave
// notifications, and the auto-updater's "is the server empty" gate — a wrong answer there either
// restarts on top of live players or never restarts at all.
//
// PZ has written connection events in two shapes. Both are handled, because a server's log can
// contain both across a version change:
//
//   older, name-carrying:
//     <steamid> "Name" allowed to join.
//     <steamid> "Name" disconnected player (x,y,z).
//     <steamid> "Name" removed connection index=0.
//
//   current B42, id-only on the way out:
//     <steamid> "Name" allowed to join.
//     Connection disconnect index=0 guid=... id=<steamid>.
//     Connection remove     index=0 guid=... id=<steamid>.
//
// "fully connected" is deliberately NOT a join signal: PZ writes it every time a character enters
// the world, including respawning after death, which produced join alerts for players who never
// left. It is reported separately as a 'spawn' event — that repeat is exactly what makes it
// useful for "someone is now in the world", and useless as a join.

const JOIN = /(\d{6,})\s+"([^"]+)"\s+allowed to join/
const SPAWN = /(\d{6,})\s+"([^"]+)"\s+fully connected/
const LEAVE_NAMED = /"([^"]+)"\s+(?:disconnected player|removed connection)/
const LEAVE_BY_ID = /Connection (?:disconnect|remove)\b.*?\bid=(\d{6,})/

// Feed lines in order. Returns the events that actually represent a state change, so a duplicate
// "disconnect" then "remove" for the same session yields one leave, not two.
//
// state: { online: Map<steamId, name>, namesOnly: Set<name>, spawned: Set<steamId> }
function makeState() { return { online: new Map(), namesOnly: new Set(), spawned: new Set() } }

function applyLine(state, line) {
  let m
  if ((m = line.match(JOIN))) {
    const [, id, name] = m
    if (state.online.has(id) || state.namesOnly.has(name)) return null
    state.online.set(id, name)
    return { type: 'join', name, steamId: id }
  }
  // Entering the world: first spawn and every respawn after death. Reported every time by
  // design, and never treated as a connection.
  if ((m = line.match(SPAWN))) {
    const [, id, name] = m
    const respawn = state.spawned.has(id)
    state.spawned.add(id)
    return { type: 'spawn', name, steamId: id, respawn }
  }
  if ((m = line.match(LEAVE_BY_ID))) {
    const id = m[1]
    const name = state.online.get(id)
    if (name === undefined) return null
    state.online.delete(id)
    state.namesOnly.delete(name)
    state.spawned.delete(id)
    return { type: 'leave', name, steamId: id }
  }
  if ((m = line.match(LEAVE_NAMED))) {
    const name = m[1]
    // The named form may arrive for a session first seen via its id.
    for (const [id, n] of state.online) {
      if (n === name) {
        state.online.delete(id)
        state.namesOnly.delete(name)
        state.spawned.delete(id)
        return { type: 'leave', name, steamId: id }
      }
    }
    if (state.namesOnly.delete(name)) return { type: 'leave', name, steamId: null }
    return null
  }
  return null
}

// Replays a whole log and returns the resulting events plus final state. Used to seed state on
// startup (events discarded) and to answer "who is online right now".
function replay(text) {
  const state = makeState()
  const events = []
  for (const line of String(text || '').split('\n')) {
    if (!line) continue
    const ev = applyLine(state, line)
    if (ev) events.push(ev)
  }
  return { state, events, online: [...state.online.values(), ...state.namesOnly] }
}

function onlineNames(state) {
  return [...state.online.values(), ...state.namesOnly]
}

// The reply to PZ's RCON `players` command: "Players connected (2): \n-Rick\n-Carl\n".
//
// Asking the server directly is the only way to tell "nobody is on" from "no log to read". PZ
// creates <date>_user.txt lazily, on the first connection of a session, so a server that has been
// restarted and not yet joined has no user log at all — exactly the state the auto-updater needs
// to recognise as empty.
//
// Returns null when the text is not a `players` reply (RCON down, unexpected build), so callers
// can fall back rather than read silence as zero.
function parseConnectedCount(text) {
  const m = String(text || '').match(/Players connected\s*\((\d+)\)/i)
  return m ? parseInt(m[1], 10) : null
}

module.exports = { makeState, applyLine, replay, onlineNames, parseConnectedCount }
