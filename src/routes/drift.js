// Mods that load here but no client can download - see lib/moddrift.js.
//
// The wording of these responses is the point of the feature. The operator is looking at mods that
// work perfectly from the server's side, so nothing appears broken; the damage is only visible to a
// player who gets "Mod ... is not installed [WorkshopID: ]" and bounces.

const fs = require('fs')
const path = require('path')
const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const { modsDir } = require('../paths')
const { getIniList, setIniList } = require('../domain/ini')
const { modDriftReport } = require('../domain/inventory')
const { backupModOrder } = require('../services/modorder')
const { planRepair } = require('../../lib/moddrift')

const router = require('express').Router()

// Dry run. Lists every enabled mod a client could not download, and what to rename it to.
router.get('/api/mods/drift', (req, res) => res.json(modDriftReport(srv(req))))

// Apply renames. Refuses anything the report did not suggest, and refuses a rename between two
// different builds unless the caller has seen the item cost and passed acceptItemLoss.
router.post('/api/mods/drift/repair', (req, res) => {
  const s = srv(req)
  const { remaps, acceptItemLoss } = req.body || {}
  if (!Array.isArray(remaps) || !remaps.length) return res.status(400).json({ error: 'remaps required' })

  const report = modDriftReport(s)
  const byId = new Map(report.issues.map(i => [i.id, i]))
  const unsafe = remaps
    .map(r => byId.get(String((r || {}).from || '').trim()))
    .filter(i => i && i.buildsIdentical === false)
  if (unsafe.length && !acceptItemLoss) {
    return res.status(409).json({
      error: 'Different builds — renaming these makes the game load different scripts, and items ' +
             'whose ids no longer exist are discarded. Re-send with acceptItemLoss:true to proceed.',
      needsConfirmation: unsafe.map(i => ({ id: i.id, folder: i.folder, suggest: i.suggest })),
    })
  }

  const mods = getIniList(s, 'Mods')
  const plan = planRepair(report, mods, remaps)
  if (!plan.applied.length) return res.status(400).json({ error: 'no applicable remap', rejected: plan.rejected })

  const backup = backupModOrder(s, 'before mod id drift repair')
  setIniList(s, 'Mods', plan.mods)
  logFor(s, 'mod id drift repaired: ' + plan.applied.map(a => a.from + ' -> ' + a.to).join(', ') +
    ', previous Mods= backed up as ' + backup)
  res.json({ success: true, applied: plan.applied, rejected: plan.rejected, backup,
             restartRequired: true })
})

module.exports = router
