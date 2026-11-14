// The only module that knows this manager talks to Docker.
//
// Every one of these calls used to be an `exec('docker ... ' + name + ' ...')` built by string
// concatenation, spread across twenty-five sites in server.js. Two consequences worth naming:
//
//   1. A shell was involved in all of them. Container names come from Docker itself so nothing was
//      exploitable in practice, but `sh -c` was parsing strings this process assembled, and one of
//      the sites interpolated a Workshop id into a command run inside the game container.
//   2. `docker logs ... 2>&1 | grep -F <pattern> | tail -1` meant the readiness check and the dead
//      mod check each depended on a shell pipeline. Both now read the log and filter in JS, which
//      is fewer moving parts and one less thing that behaves differently under busybox.
//
// Everything here takes an argument array. There is no string-command entry point on purpose: the
// injection class cannot come back if the door is not there.

const { execFile, execFileSync, spawn } = require('child_process')

const MB = 1024 * 1024

/**
 * Every container on the box right now, name -> state.
 *
 * Returns null (not an empty map) when Docker cannot be reached, so a transient failure is
 * distinguishable from "no containers" — the registry relies on that difference to avoid pruning
 * every known server on one bad call.
 *
 * @returns {Record<string,string>|null}
 */
function psAll() {
  try {
    const out = execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}|{{.State}}'], { maxBuffer: 4 * MB })
      .toString().trim()
    /** @type {Record<string,string>} */
    const map = {}
    for (const line of out.split('\n')) {
      const [name, state] = line.split('|')
      if (name) map[name] = state || 'unknown'
    }
    return map
  } catch { return null }
}

/**
 * Container names running a given image.
 * @param {string} image
 * @returns {string[]}
 */
function psByImage(image) {
  try {
    return execFileSync('docker', ['ps', '-a', '--filter', 'ancestor=' + image, '--format', '{{.Names}}'], { maxBuffer: 4 * MB })
      .toString().trim().split('\n').filter(Boolean)
  } catch { return [] }
}

/**
 * A container's bind mounts.
 * @param {string} target container name or id
 * @returns {Array<{ Type?: string, Source?: string, Destination?: string }>}
 */
function mounts(target) {
  try {
    return JSON.parse(execFileSync('docker', ['inspect', target, '--format', '{{json .Mounts}}'], { maxBuffer: 4 * MB }).toString())
  } catch { return [] }
}

/**
 * This container's own id.
 *
 * Inside Docker, `hostname` is the short container id, which `docker logs` and `docker inspect`
 * both accept. That is how the manager reads its own log stream and finds its own mounts.
 * @returns {string}
 */
function ownId() {
  try { return execFileSync('hostname').toString().trim() } catch { return '' }
}

/**
 * @param {string|string[]} target one container, or several to inspect in one call
 * @param {string} format a Go template, e.g. '{{.State.Status}}'
 * @param {(err: Error|null, out: string) => void} cb
 */
function inspect(target, format, cb) {
  const targets = Array.isArray(target) ? target : [target]
  execFile('docker', ['inspect', ...targets, '--format', format], { maxBuffer: 4 * MB }, (err, out) =>
    cb(err, String(out || '').trim()))
}

/**
 * A container's log, stdout and stderr together.
 *
 * PZ writes to both, and every caller previously asked the shell for `2>&1`. execFile hands them
 * back separately, so they are concatenated here to preserve that.
 *
 * @param {string} target
 * @param {string[]} args extra `docker logs` arguments, e.g. ['--tail', '1500']
 * @param {{ maxBuffer?: number, timeout?: number }} opts
 * @param {(err: Error|null, text: string) => void} cb
 */
function logs(target, args, opts, cb) {
  const o = opts || {}
  execFile('docker', ['logs', target, ...args], { maxBuffer: o.maxBuffer || 8 * MB, timeout: o.timeout },
    (err, stdout, stderr) => cb(err, String(stdout || '') + String(stderr || '')))
}

/**
 * Log lines containing a fixed substring, newest last.
 *
 * Replaces `docker logs ... | grep -F <pattern> | tail -1`. Filtering in JS keeps the match exactly
 * as literal as `grep -F` was, without depending on which grep the image ships or on a pattern
 * surviving a trip through the shell.
 *
 * @param {string} target
 * @param {string[]} args
 * @param {string} needle
 * @param {{ maxBuffer?: number, timeout?: number }} opts
 * @param {(err: Error|null, lines: string[]) => void} cb
 */
function logsContaining(target, args, needle, opts, cb) {
  logs(target, args, opts, (err, text) => {
    // A non-zero exit with output still carries usable lines (docker logs on a stopped container),
    // so the text is filtered either way and the error is passed along for the caller to judge.
    const lines = text ? text.split('\n').filter(l => l.includes(needle)) : []
    cb(err, lines)
  })
}

/**
 * A live `docker logs --follow` process, for streaming to an SSE response.
 * @param {string} target
 * @param {number|string} tail how many lines of history to send first
 */
function logStream(target, tail) {
  return spawn('docker', ['logs', target, '--tail', String(tail), '--follow', '--timestamps'])
}

/**
 * @param {string} target
 * @param {(err: Error|null, out: string) => void} cb
 */
function stats(target, cb) {
  execFile('docker', ['stats', target, '--no-stream', '--format', '{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}'],
    (err, out) => cb(err, String(out || '').trim()))
}

/**
 * start / stop / restart.
 * @param {'start'|'stop'|'restart'} action
 * @param {string} target
 * @param {number} timeout
 * @param {(err: Error|null, out?: string) => void} cb
 */
function control(action, target, timeout, cb) {
  execFile('docker', [action, target], { timeout }, (err, out) => cb(err, String(out || '').trim()))
}

/**
 * Run a command inside a container and wait for it.
 * @param {string} target
 * @param {string[]} argv
 * @param {{ timeout?: number, maxBuffer?: number }} [opts]
 * @returns {string} stdout
 */
function execInSync(target, argv, opts) {
  const o = opts || {}
  return execFileSync('docker', ['exec', target, ...argv], { timeout: o.timeout, maxBuffer: o.maxBuffer || 4 * MB })
    .toString()
}

/**
 * Start a command inside a container and leave it running.
 *
 * `-d` is what lets a SteamCMD download survive a restart of this manager: the process belongs to
 * the game container, not to us, so completion is detected by reconciling the queue rather than by
 * a callback on this process.
 *
 * @param {string} target
 * @param {string[]} argv
 * @param {{ timeout?: number }} opts
 * @param {(err: Error|null, stdout: string, stderr: string) => void} cb
 */
function execInDetached(target, argv, opts, cb) {
  execFile('docker', ['exec', '-d', target, ...argv], { timeout: (opts || {}).timeout },
    (err, stdout, stderr) => cb(err, String(stdout || ''), String(stderr || '')))
}

module.exports = {
  psAll, psByImage, mounts, ownId, inspect, logs, logsContaining, logStream, stats, control,
  execInSync, execInDetached, MB,
}
