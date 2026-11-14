// Host and container statistics, and the manager's own wall clock.
//
// The clock matters because the restart schedule runs on it: an operator setting "restart at 04:00"
// needs to see which 04:00 this container thinks that is.

const registry = require('../registry/servers')
const { srv } = registry
const docker = require('../infra/docker')
const disk = require('../infra/disk')

const router = require('express').Router()

router.get('/api/sysinfo', (req, res) => {
  const s = srv(req)
  docker.stats(s.container, (err, out) => {
    const parts = (out || '').trim().split('|')
    const cpu = parts[0] || '—'
    const mem = parts[1] || '—'
    const memPct = parts[2] || '—'
    disk.df('/workshop', cols => res.json({ cpu, mem, memPct, disk: cols }))
  })
})

// Server local time (for schedule display)
router.get('/api/servertime', (req, res) => {
  const now = new Date()
  res.json({
    hour: now.getHours(),
    minute: now.getMinutes(),
    display: now.toLocaleString()
  })
})

module.exports = router
