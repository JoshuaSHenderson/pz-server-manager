// What is downloading now, and what has been requested since.
//
// `active` is live per-item progress parsed from the current log tail; `queue` is the persisted
// record that survives a restart of this manager and is what the UI actually renders.

const registry = require('../registry/servers')
const { srv } = registry
const { readQueue, writeQueue, parseDownloads } = require('../services/downloads')
const docker = require('../infra/docker')

const router = require('express').Router()

// `active` = live per-item progress parsed from the current log tail (byte-level %, while
// still downloading). `queue` = the persisted record of everything ever requested for this
// server (queued/installed/failed with timestamps) — this is what survives a manager restart
// and is what the "Queued for Download" UI section actually renders from.
router.get('/api/downloads', (req, res) => {
  const s = srv(req)
  docker.logs(s.container, ['--tail', '2000'], { maxBuffer: 8 * docker.MB }, (err, out) => {
    const lines = (out || '').split('\n')
    res.json({ active: parseDownloads(lines), queue: readQueue(s).slice().reverse() })
  })
})

// Clears the download activity list. Only settled entries go — anything still 'queued' is work in
// flight, and dropping it would orphan the download (reconcileDownloads would never register the
// mod when it lands). Purely a display concern: no mod files or ini entries are touched.
router.delete('/api/downloads/queue', (req, res) => {
  const s = srv(req)
  const before = readQueue(s)
  const kept = before.filter(e => e.status === 'queued')
  writeQueue(s, kept)
  res.json({ success: true, cleared: before.length - kept.length, kept: kept.length })
})

module.exports = router
