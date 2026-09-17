// servertest.ini: the curated fields, and every other key the file actually contains.

const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const { getFullIni, setIniValue, CONFIG_FIELDS, INI_KEY_RE } = require('../domain/ini')

const router = require('express').Router()

router.get('/api/config', (req, res) => {
  const s = srv(req)
  res.json(getFullIni(s))
})

router.put('/api/config', (req, res) => {
  const s = srv(req)
  const updates = req.body || {}
  const changed = []
  for (const [k, v] of Object.entries(updates)) {
    if (INI_KEY_RE.test(k) && typeof v === 'string') { setIniValue(s, k, v); changed.push(k) }
  }
  if (changed.length) logFor(s, 'server config updated: ' + changed.join(', '))
  res.json({ success: true })
})

module.exports = router
