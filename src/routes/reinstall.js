// Starting a clean reinstall, and reading its progress.
//
// The flow runs for as long as a download plus a restart, well past any sensible HTTP timeout, so
// the POST only starts it and everything after that is read back from the GET.

const registry = require('../registry/servers')
const { srv } = registry
const { getIniList } = require('../domain/ini')
const { reinstallWorkshopItem } = require('../services/reinstall')
const reinstallState = require('../services/reinstall-state')
const { validWorkshopId } = require('../../lib/excludes')

const router = require('express').Router()

router.get('/api/mods/reinstall', (req, res) => {
  const s = srv(req)
  res.json({ available: !!s.install, busy: reinstallState.busy(s), state: reinstallState.get(s) })
})

router.post('/api/mods/:workshopId/reinstall', (req, res) => {
  const s = srv(req)
  const { workshopId } = req.params
  if (!validWorkshopId(workshopId)) return res.status(400).json({ error: 'workshopId must be digits' })
  if (!s.install) return res.status(409).json({ error: 'This server has no /pz-install mount, so the manager cannot see the files the game loads. Add ./install:/pz-install to the mod-manager service and restart it.' })
  if (reinstallState.busy(s)) return res.status(409).json({ error: 'A reinstall of ' + reinstallState.get(s).workshopId + ' is already running' })
  if (!getIniList(s, 'WorkshopItems').includes(workshopId)) return res.status(404).json({ error: 'Workshop item ' + workshopId + ' is not installed on this server' })

  // Answered immediately: the flow runs for as long as a download plus a restart, well past any
  // sensible HTTP timeout. Progress comes from GET /api/mods/reinstall.
  res.json({ success: true, workshopId, started: true })
  reinstallWorkshopItem(s, workshopId).catch(e => console.error('[reinstall]', e))
})

module.exports = router
