// Writing the world before the container goes down.
//
// PZ runs its shutdown hook — and the SaveAll inside it — only when the game process itself
// receives the signal. `docker stop` and `docker restart` send SIGTERM to the container's PID 1,
// which in the server image is bash running entry.sh: it traps nothing and never execs, so the
// signal dies there and the JVM is SIGKILLed once the grace period expires. Every restart this
// manager issued therefore left the world at its last autosave — up to SaveWorldEveryMinutes
// (45 by default) of play silently rolled back, which reads as corruption rather than a lost save.
//
// Confirmed against the live server: every rotated DebugLog ends mid-line with no shutdown
// message, while signalling the game process directly produces
// "Shutdown handling started" / "SaveAll took 60.156914 ms" / "Shutdown handling finished".
//
// So ask for the save over RCON first. The one hard rule is that a save which cannot happen must
// never strand the server: if RCON is unconfigured, unreachable, or the server is still booting,
// log it and go down anyway. An unsaved restart is bad; a server that will not restart is worse.

// Time between RCON acknowledging `save` and the container going down. PZ answers as soon as the
// save is queued rather than when it has finished writing, so this is the write window. SaveAll
// measured 60ms on a 183-mod world; the rest is slack for a larger one.
// ponytail: fixed delay. If a world ever outgrows it, watch the log for "SaveAll took" instead.
const SAVE_SETTLE_MS = 5000

// deps.rcon(command, cb)  — cb(err, output), must always call back exactly once
// deps.wait(ms, cb)       — setTimeout, injected so the test does not sleep
// deps.log(message)       — one line of operator-facing context
// next()                  — take the server down; always runs, exactly once
function saveThenGoDown(deps, next) {
  let taken = false
  const proceed = () => {
    if (taken) return
    taken = true
    next()
  }

  deps.rcon('save', (err, out) => {
    if (err) {
      deps.log('pre-shutdown save skipped: ' + err.message)
      return proceed()
    }
    const said = String(out || '').trim()
    deps.log('world saved' + (said ? ': ' + said : ''))
    deps.wait(SAVE_SETTLE_MS, proceed)
  })
}

module.exports = { saveThenGoDown, SAVE_SETTLE_MS }
