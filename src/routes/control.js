// Starting, stopping and restarting a server.
//
// Every path here goes through saveThen() and bringUp() rather than touching Docker directly - see
// src/services/lifecycle.js for why a plain `docker stop` loses up to SaveWorldEveryMinutes of play.

const registry = require('../registry/servers')
const { srv} = registry
const { logFor } = require('../log')
const { saveThen, bringUp, sendIngameMsg } = require('../services/lifecycle')
const { mstate, markAwaitingReady } = require('../monitors/state')
const { readNotifConfig, pushoverFor } = require('../services/notify')
const docker = require('../infra/docker')

const router = require('express').Router()

router.get('/api/status', (req, res) => {
  const s = srv(req)
  docker.inspect(s.container, '{{.State.Status}}|{{.State.StartedAt}}', (err, out) => {
    if (err) return res.json({ status: 'unknown' })
    const [status, startedAt] = out.split('|')
    res.json({ status, startedAt, server: s.id })
  })
})

router.post('/api/server/start', (req, res) => {
  const s = srv(req)
  logFor(s, 'start requested via UI')
  markAwaitingReady(s)
  bringUp(s, 'start', 30000, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStart) pushoverFor(s, 'PZ Server Started', 'Project Zomboid server is starting up.')
    }
    res.json({ success: ok, error: err?.message })
  })
})

router.post('/api/server/stop', (req, res) => {
  const s = srv(req)
  logFor(s, 'stop requested via UI')
  mstate(s).intentionalStop = true
  saveThen(s, () => docker.control('stop', s.container, 60000, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStop) pushoverFor(s, 'PZ Server Stopped', 'Project Zomboid server has been stopped.')
    }
    res.json({ success: ok, error: err?.message })
  }))
})

router.post('/api/server/restart', (req, res) => {
  const s = srv(req)
  logFor(s, 'restart requested via UI')
  mstate(s).intentionalStop = true
  markAwaitingReady(s)
  saveThen(s, () => bringUp(s, 'restart', 60000, (err) => {
    const ok = !err
    if (ok) {
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.serverStart) pushoverFor(s, 'PZ Server Restarted', 'Project Zomboid server has been restarted.')
    }
    res.json({ success: ok, error: err?.message })
  }))
})

// Warned restart: send in-game countdown messages then restart
router.post('/api/server/warned-restart', (req, res) => {
  const s = srv(req)
  const delayMin = Math.max(1, Math.min(60, parseInt((req.body || {}).delayMinutes) || 10))
  res.json({ success: true, message: 'Restart scheduled in ' + delayMin + ' minute(s).' })
  sendIngameMsg(s, 'Server restarting in ' + delayMin + ' minute' + (delayMin > 1 ? 's' : '') + '!')
  const warnings = [10, 5, 1].filter(w => w < delayMin)
  warnings.forEach(w => {
    setTimeout(() => sendIngameMsg(s, 'Server restarting in ' + w + ' minute' + (w > 1 ? 's' : '') + '!'),
      (delayMin - w) * 60000)
  })
  setTimeout(() => {
    mstate(s).intentionalStop = true
    saveThen(s, () => bringUp(s, 'restart', 90000, () => {}))
  }, delayMin * 60000)
})

module.exports = router
