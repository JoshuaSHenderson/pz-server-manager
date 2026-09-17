// The whitelist, and who is connected right now.

const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const db = require('../infra/db')
const { ACCESS_LEVELS } = db
const whitelist = require('../services/whitelist')
const { onlinePlayersFor } = require('../services/playerlog')

const router = require('express').Router()

router.get('/api/players', (req, res) => {
  res.json({ players: whitelist.list(srv(req)) })
})

router.post('/api/players', (req, res) => {
  const s = srv(req)
  const { username, accesslevel = 'none' } = req.body || {}
  if (!db.validUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  if (!ACCESS_LEVELS.includes(accesslevel)) return res.status(400).json({ error: 'Invalid accesslevel' })
  try {
    whitelist.add(s, username, accesslevel)
    logFor(s, 'whitelisted "' + username + '" as ' + accesslevel)
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.patch('/api/players/:username', (req, res) => {
  const s = srv(req)
  const { username } = req.params
  if (!db.validUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  const { accesslevel, banned } = req.body || {}
  try {
    const r = whitelist.update(s, username, { accesslevel, banned })
    if (r.ok !== true) return res.status(400).json({ error: r.error })
    logFor(s, 'updated "' + username + '"' +
      (accesslevel !== undefined ? ' accesslevel=' + accesslevel : '') +
      (banned !== undefined ? (banned ? ' banned' : ' unbanned') : ''))
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/api/players/:username', (req, res) => {
  const s = srv(req)
  const { username } = req.params
  if (!db.validUsername(username)) return res.status(400).json({ error: 'Invalid username' })
  try {
    whitelist.remove(s, username)
    logFor(s, 'removed "' + username + '" from the whitelist')
    res.json({ success: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/api/players/online', (req, res) => {
  const players = onlinePlayersFor(srv(req))
  res.json({ online: players.length, players })
})

module.exports = router
