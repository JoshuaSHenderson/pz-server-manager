// The mod auto-update switch, its status, and the manual "check now".

const registry = require('../registry/servers')
const { srv } = registry
const { readAutoUpdate, writeAutoUpdate, runAutoUpdate, AUTOUPDATE_CHECK_MS } = require('../services/autoupdate')

const router = require('express').Router()

router.get('/api/mods/autoupdate', (req, res) => {
  const s = srv(req)
  const cfg = readAutoUpdate(s)
  res.json({
    enabled: cfg.enabled,
    restartWhenEmpty: cfg.restartWhenEmpty,
    lastCheck: cfg.lastCheck,
    lastRestart: cfg.lastRestart,
    lastResult: cfg.lastResult,
    pending: cfg.pending || [],
    tracked: Object.keys(cfg.times || {}).length,
    checkIntervalHours: AUTOUPDATE_CHECK_MS / 3600000
  })
})

router.put('/api/mods/autoupdate', (req, res) => {
  const s = srv(req)
  const { enabled, restartWhenEmpty } = req.body || {}
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be a boolean' })
  const cfg = readAutoUpdate(s)
  cfg.enabled = enabled
  if (typeof restartWhenEmpty === 'boolean') cfg.restartWhenEmpty = restartWhenEmpty
  if (!enabled) cfg.lastResult = 'Disabled.'
  writeAutoUpdate(s, cfg)
  res.json({ success: true, enabled: cfg.enabled, restartWhenEmpty: cfg.restartWhenEmpty })
})

// Checks Steam now and downloads anything outdated, whether or not the hourly check is enabled.
// With auto-update off this downloads only — shouldRestart() will not restart the server.
router.post('/api/mods/autoupdate/check', (req, res) => {
  const s = srv(req)
  const cfg = readAutoUpdate(s)
  cfg.lastCheck = null // force the Steam call regardless of when the last one ran
  writeAutoUpdate(s, cfg)
  runAutoUpdate(s, true)
  res.json({ success: true, message: 'Check started — results appear here within a few seconds.' })
})

module.exports = router
