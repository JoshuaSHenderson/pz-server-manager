// Errors pulled out of the two log streams, grouped so a dashboard can show them.
//
// Nothing here is new detection. It reads the same logs an operator would, and the only real work
// is collapsing repetition: a mod that throws the same exception on every tick would otherwise
// bury everything else. Numbers, hashes and file paths are stripped from the grouping key, so
// "missing X.xml" and "missing Y.xml" count as one problem rather than two hundred.
//
// Cached briefly because the PZ log runs to tens of thousands of lines and the dashboard polls.

const registry = require('../registry/servers')
const docker = require('../infra/docker')
const { stripAnsi } = require('./downloads')

/** @typedef {import('../paths').Server} Server */

// gathered so the dashboard doesn't require visiting four tabs to notice a problem.

// The PZ log runs to tens of thousands of lines; scanning it on every dashboard poll would be
// wasteful, so results are cached briefly.
const ALERT_LOG_TTL = 30 * 1000
const alertLogCache = {} // [serverId] = { at, server: [], manager: [] }

// Collapses repeated errors into one entry with a count. Numbers, hashes and file paths are
// stripped from the grouping key so "missing X.xml" and "missing Y.xml" group as one problem.
function summariseLogErrors(text, pattern) {
  const groups = new Map()
  for (const raw of String(text || '').split('\n')) {
    if (!pattern.test(raw)) continue
    const line = stripAnsi(raw).trim()
    if (!line) continue
    const key = line
      .replace(/^\S*\s*/, m => m)
      .replace(/f:\d+ st:[\d,]+/g, '')
      .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/g, '')
      .replace(/"[^"]*"/g, '"…"')
      .replace(/\/\S+/g, '/…')
      .replace(/\d{3,}/g, 'N')
      .slice(0, 160)
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { count: 1, sample: line.slice(0, 240) })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 8)
}

function collectLogAlerts(s, cb) {
  const hit = alertLogCache[s.id]
  if (hit && Date.now() - hit.at < ALERT_LOG_TTL) return cb(hit)
  const done = { at: Date.now(), server: [], manager: [] }
  let pending = 2
  const finish = () => { if (--pending <= 0) { alertLogCache[s.id] = done; cb(done) } }
  docker.logs(s.container, ['--since', '60m', '--tail', '4000'], { maxBuffer: 16 * docker.MB }, (e, out) => {
    done.server = summariseLogErrors(out, /^ERROR|SEVERE|FATAL/)
    finish()
  })
  const own = docker.ownId()
  if (!own) return finish()
  docker.logs(own, ['--since', '60m', '--tail', '2000'], { maxBuffer: 8 * docker.MB }, (e, out) => {
    done.manager = summariseLogErrors(out, /error|failed|exception/i)
    finish()
  })
}

module.exports = { summariseLogErrors, collectLogAlerts, ALERT_LOG_TTL }
