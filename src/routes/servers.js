// The managed-server registry as the UI sees it: list, rescan, rename/hide/default, and forget.
//
// Exempt from the ?server= guard, so the UI can always re-read this list and repair a stale
// selection rather than being locked out by one.

const registry = require('../registry/servers')
const { serverRow, serverLabel, refreshServers, readServerConfig, writeServerConfig } = registry
const { logFor } = require('../log')

const allServers = registry.all
const anyServerById = id => registry.anyById(id) || null

const router = require('express').Router()

router.get('/api/servers', (req, res) => {
  res.json({
    default: registry.defaultId(),
    servers: allServers().map(s => serverRow(s)),
    hidden: registry.hidden().map(s => serverRow(s, { hidden: true })),
    stale: registry.stale().map(s => ({
      id: s.id || s.container, name: s.name || s.container, container: s.container,
      state: 'missing', discovered: false, managed: false,
    })),
  })
})

// Manually re-scans for PZ containers (in case one was added since the last 60s auto-refresh).
router.post('/api/servers/refresh', (req, res) => {
  refreshServers()
  res.json({ success: true, count: allServers().length })
})

// Rename / set connect / hide / make default. One endpoint, all persisted to servers.json.
router.put('/api/servers/:id', (req, res) => {
  const target = anyServerById(req.params.id)
  if (!target) return res.status(404).json({ error: 'No such server: ' + req.params.id })
  const { name, connect, hidden, makeDefault, id: newId } = req.body || {}
  if (newId !== undefined && !/^[A-Za-z0-9._-]{1,40}$/.test(newId)) {
    return res.status(400).json({ error: 'Id must be 1-40 chars of letters, numbers, dot, dash or underscore.' })
  }
  if (newId && newId !== target.id && anyServerById(newId)) {
    return res.status(409).json({ error: 'Id "' + newId + '" is already in use.' })
  }

  const cfg = readServerConfig()
  const o = Object.assign({}, cfg.overrides[target.container])
  if (newId !== undefined) o.id = newId || target.container
  if (name !== undefined) o.name = name.trim()
  if (connect !== undefined) o.connect = connect.trim()
  cfg.overrides[target.container] = o

  const set = new Set(cfg.hidden || [])
  if (hidden === true) set.add(target.container)
  if (hidden === false) set.delete(target.container)
  cfg.hidden = [...set]

  if (makeDefault) cfg.default = o.id || target.id
  // Hiding the default would leave the picker pointing at nothing.
  if (cfg.hidden.includes(target.container) && cfg.default === (o.id || target.id)) cfg.default = ''

  writeServerConfig(cfg)
  refreshServers()
  res.json({ success: true, default: registry.defaultId(), servers: allServers().map(s => serverRow(s)) })
})

// Forget a server: drops its saved override and un-hides it. For a stale entry (container gone)
// this removes it for good; for a live one it just resets it back to auto-discovered defaults.
router.delete('/api/servers/:id', (req, res) => {
  const target = anyServerById(req.params.id)
  if (!target) return res.status(404).json({ error: 'No such server: ' + req.params.id })
  const cfg = readServerConfig()
  delete cfg.overrides[target.container]
  cfg.hidden = (cfg.hidden || []).filter(c => c !== target.container)
  if (cfg.default === target.id) cfg.default = ''
  writeServerConfig(cfg)
  refreshServers()
  const stillThere = !!anyServerById(target.id)
  res.json({ success: true, removed: !stillThere, default: registry.defaultId() })
})

module.exports = router
