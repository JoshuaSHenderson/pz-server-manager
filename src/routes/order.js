// The load order: reading Mods=, rewriting it, and restoring a previous version.
//
// Every write is a validated permutation of the current list and is preceded by a snapshot, so a
// bad drag costs one click rather than a hand-rebuilt list of 180 mod ids.

const fs = require('fs')
const path = require('path')
const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const { modOrderBackupDir } = require('../paths')
const { getIniList, setIniList } = require('../domain/ini')
const { installedModMeta } = require('../domain/modinfo')
const { listModOrderBackups, backupModOrder } = require('../services/modorder')
const { getTitles } = require('../infra/steam')
const { validateReorder } = require('../../lib/order')

const router = require('express').Router()

router.get('/api/mods/order', (req, res) => {
  const s = srv(req)
  const meta = installedModMeta(s)
  const byLower = {}
  for (const [id, m] of Object.entries(meta)) byLower[id.toLowerCase()] = m
  res.json({
    mods: getIniList(s, 'Mods').map((id, i) => {
      const m = byLower[id.toLowerCase()] || {}
      return {
        modId: id, index: i,
        name: m.name || id,
        workshopId: m.workshopId || null,
        // Surfaced inline so the ordering constraints are visible while dragging.
        loadModAfter: m.loadModAfter || [],
        installed: !!byLower[id.toLowerCase()]
      }
    }),
    backups: listModOrderBackups(s)
  })
})

router.put('/api/mods/order', (req, res) => {
  const s = srv(req)
  const next = (req.body || {}).mods
  const current = getIniList(s, 'Mods')
  // Must be a permutation: reordering may never add or drop a mod. That is what the per-mod
  // toggles are for, and a silent change here would alter what the server loads.
  const check = validateReorder(current, next)
  if (!check.ok) return res.status(400).json({ error: check.error })
  const backup = backupModOrder(s, (req.body || {}).label || 'before reorder')
  setIniList(s, 'Mods', next)
  logFor(s, 'load order saved (' + next.length + ' mods), previous backed up as ' + backup)
  res.json({ success: true, count: next.length, backup })
})

router.get('/api/mods/order/backups', (req, res) => res.json({ backups: listModOrderBackups(srv(req)) }))

router.post('/api/mods/order/restore', (req, res) => {
  const s = srv(req)
  const { file } = req.body || {}
  if (!file || !/^Mods-[\w-]+\.json$/.test(file)) return res.status(400).json({ error: 'Invalid backup file' })
  const full = path.join(modOrderBackupDir(s), file)
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'No such backup: ' + file })
  let saved
  try { saved = JSON.parse(fs.readFileSync(full, 'utf8')) } catch (e) { return res.status(500).json({ error: 'Backup is unreadable: ' + e.message }) }
  // The snapshot may predate a mod being enabled or removed, so it is only valid if it still
  // describes exactly the current mod set — otherwise restoring it would change what loads.
  const check = validateReorder(getIniList(s, 'Mods'), saved.mods || [])
  if (!check.ok) return res.status(409).json({ error: 'Backup no longer matches the enabled mods — ' + check.error })
  const backup = backupModOrder(s, 'before restoring ' + file)
  setIniList(s, 'Mods', saved.mods)
  logFor(s, 'load order restored from ' + file + ' (' + saved.mods.length + ' mods)')
  res.json({ success: true, restored: file, count: saved.mods.length, backup })
})

module.exports = router
