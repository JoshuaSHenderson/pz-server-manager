// Server-sent-events tails of the game server's log and of this manager's own.
//
// Two streams rather than one because when a mod fails to install, the reason is almost always in
// the manager's output rather than the game's - and pausing or filtering one pane must not affect
// the other.

const registry = require('../registry/servers')
const { srv } = registry
const { qs } = require('../http')
const docker = require('../infra/docker')

/**
 * Server-sent-events tail of a container's log.
 *
 * Shared by the game server's log and this manager's own so the two panes cannot drift apart in
 * behaviour. The tail is capped: a client asking for the whole of a log that runs to tens of
 * thousands of lines would spend the first several seconds rendering history nobody scrolled to.
 *
 * @param {import('express').Response} res
 * @param {string} container
 * @param {string} tailArg
 */
function streamContainerLogs(res, container, tailArg) {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const tail = Math.min(parseInt(tailArg) || 300, 2000)
  const child = docker.logStream(container, tail)
  const send = (/** @type {string} */ l) => { if (l.trim()) res.write('data: ' + JSON.stringify(l) + '\n\n') }
  child.stdout.on('data', d => d.toString().split('\n').forEach(send))
  child.stderr.on('data', d => d.toString().split('\n').forEach(send))
  child.on('close', () => res.end())
  // The client going away must kill the docker process, or every closed tab leaks one.
  res.on('close', () => child.kill())
}

// This manager's own container id. Inside Docker, `hostname` is the short container id, which
// `docker logs` accepts — the same trick the registry uses to find our own bind mounts.
const ownContainerId = () => docker.ownId()

const router = require('express').Router()

router.get('/api/logs', (req, res) => {
  streamContainerLogs(res, srv(req).container, qs(req.query.tail))
})

// The manager's own output: Express request errors, SteamCMD launch failures, download
// reconciliation, collection auto-sync, RCON and schedule activity. Separate from the PZ server
// log because when a mod fails to install, the reason is almost always in here, not in the game
// server's log.
router.get('/api/manager-logs', (req, res) => {
  const id = ownContainerId()
  if (!id) return res.status(500).json({ error: 'Could not determine own container id' })
  streamContainerLogs(res, id, qs(req.query.tail))
})

module.exports = router
