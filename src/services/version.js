// The build the game is actually running, read from its own startup log.
//
// PZ prints `version=42.20.0 a2947723ca demo=false` once, about a hundred lines into startup.
// Tailing the end of a log that runs to tens of thousands of lines never reached it, which is why
// the version used to show as blank — so this reads forward from the start of the current run.
//
// Cached for five minutes, and scoped to the current run via --since, so a restart onto a new
// build is picked up rather than the first answer being kept forever.

const docker = require('../infra/docker')
const { logFor } = require('../log')

/** @typedef {import('../paths').Server} Server */

// --- Running game version (cached per server — parsed from the server's own startup log) ---
const versionCache = {} // [serverId] = { version, at }
const VERSION_TTL = 5 * 60 * 1000
// PZ prints "version=42.20.0 a2947723ca demo=false" once, about 100 lines into startup. Tailing
// the end of a log that runs to tens of thousands of lines never reached it, which is why the
// version showed as blank — so read forward from the start of the current run instead.
function getServerVersion(s, cb) {
  const cached = versionCache[s.id]
  if (cached && Date.now() - cached.at < VERSION_TTL) return cb(cached.version)
  docker.inspect(s.container, '{{.State.StartedAt}}', (e1, startedAt) => {
    const since = (startedAt || '').trim()
    // --since scopes it to the current run so a restart picks up a changed version. The read used
    // to be capped with `| head -n 2000`; the cap is now applied to the text, which does the same
    // job without a shell and without the pipe's broken-pipe race on a long log.
    docker.logs(s.container, since ? ['--since', since] : [], { maxBuffer: 8 * docker.MB }, (err, full) => {
      const out = full.split('\n', 2000).join('\n')
      const m = (out || '').match(/\bversion=(\d[\w.]*)/)
      const version = m ? m[1] : (cached ? cached.version : '')
      if (version && (!cached || cached.version !== version)) logFor(s, 'detected PZ version ' + version)
      versionCache[s.id] = { version, at: Date.now() }
      cb(version)
    })
  })
}

module.exports = { getServerVersion, versionCache, VERSION_TTL }
