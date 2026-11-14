// "Is anything wrong with this server right now", in one response.
//
// Nothing here is new detection - it gathers signals that already exist (dependency analysis, the
// disk audit, the download queue, errors in both log streams) so noticing a problem does not
// require visiting four tabs.

const registry = require('../registry/servers')
const { srv } = registry
const { getIniList } = require('../domain/ini')
const { installedModMeta } = require('../domain/modinfo')
const { auditServer } = require('../services/audit')
const { readQueue } = require('../services/downloads')
const { collectLogAlerts } = require('../services/alerts')
const { readDepIgnores } = require('../services/depignores')
const { allDroppedItems } = require('../services/collection-sync')
const { analyzeDependencies, sortIssues } = require('../../lib/deps')

const router = require('express').Router()

router.get('/api/alerts', (req, res) => {
  const s = srv(req)
  const alerts = []
  const push = (severity, category, title, detail, extra) =>
    alerts.push(Object.assign({ severity, category, title, detail }, extra || {}))

  // Dependencies
  let depIssues = []
  try {
    const meta = installedModMeta(s)
    depIssues = sortIssues(analyzeDependencies({
      enabled: getIniList(s, 'Mods'), installed: Object.keys(meta), meta, ignores: readDepIgnores(s)
    }))
  } catch (e) {}
  const conflicts = depIssues.filter(i => i.type === 'incompatible')
  const missingDeps = depIssues.filter(i => i.type === 'missing')
  const disabledDeps = depIssues.filter(i => i.type === 'disabled')
  const orderIssues = depIssues.filter(i => i.type === 'order')
  if (conflicts.length) push('error', 'mods', conflicts.length + ' mod conflict(s)', conflicts.map(i => i.modId + ' ⇄ ' + i.dependency).join(', '), { tab: 'mods' })
  if (missingDeps.length) push('error', 'mods', missingDeps.length + ' missing dependenc(ies)', missingDeps.map(i => i.modId + ' → ' + i.dependency).join(', '), { tab: 'mods' })
  if (disabledDeps.length) push('warn', 'mods', disabledDeps.length + ' dependenc(ies) installed but not loaded', disabledDeps.map(i => i.modId + ' → ' + i.dependency).join(', '), { tab: 'mods' })
  if (orderIssues.length) push('info', 'mods', orderIssues.length + ' load-order issue(s)', orderIssues.map(i => i.modId + ' should load after ' + i.dependency).join(', '), { tab: 'mods' })

  // Disk / files
  let audit = null
  try { audit = auditServer(s) } catch (e) {}
  if (audit) {
    if (audit.missingContent.length) push('error', 'files', audit.missingContent.length + ' registered mod(s) missing files', 'Registered in WorkshopItems but nothing on disk: ' + audit.missingContent.join(', '), { tab: 'mods' })
    if (audit.phantomEnabled.length) push('warn', 'files', audit.phantomEnabled.length + ' enabled mod id(s) not provided by any install', audit.phantomEnabled.join(', '), { tab: 'mods' })
    if (audit.notLoadable.length) {
      push('error', 'files', audit.notLoadable.length + ' enabled mod id(s) the game cannot load',
        audit.notLoadable.join(', ') + '. Not present in the install tree or in the mods folder, so the server starts without them and drops their items from the save.', { tab: 'mods' })
    }
    // Ranked as an error: this is the one that makes a restart come up differently each time, and
    // it stays invisible until someone reads a boot log line by line.
    if (audit.duplicateIds.length) {
      push('error', 'files', audit.duplicateIds.length + ' mod id(s) claimed by more than one folder',
        audit.duplicateIds.map(d => d.modId + ' ← ' + d.providers.map(p => p.workshopId + '/' + p.folder).join(' + ')).join(' | ') +
        '. PZ loads whichever it finds first, so the server boots differently each restart. Exclude the folder you do not want.', { tab: 'mods' })
    }
    if (audit.unregistered.length || audit.orphanFolders.length) {
      push('warn', 'files', 'Orphaned mod files on disk (' + audit.reclaimableHuman + ' reclaimable)',
        audit.unregistered.length + ' unregistered Workshop item(s), ' + audit.orphanFolders.length + ' stray mods folder(s)', { tab: 'mods' })
    }
    if (audit.freeBytes && audit.freeBytes < 10 * 1024 * 1024 * 1024) {
      push('error', 'disk', 'Low disk space: ' + audit.freeHuman + ' free', 'Each mod is stored twice (workshop copy + server mods folder).')
    }
  }

  // Mods the curators dropped. Nothing was deleted, so this is the nudge to act: the mods are
  // still loaded and will stay loaded until they are removed and the server restarts.
  try {
    const dropped = allDroppedItems(s)
    if (dropped.length) {
      push('warn', 'collections', dropped.length + ' mod(s) dropped from collections — remove and restart',
        'Still installed and loading: ' + dropped.map(d => d.id).join(', ') +
        '. Remove them in Mods, then restart the server to apply.', { tab: 'mods' })
    }
  } catch (e) {}

  // Downloads: failures, and what changed recently
  const queue = readQueue(s)
  const failed = queue.filter(e => e.status === 'failed')
  if (failed.length) push('error', 'downloads', failed.length + ' failed download(s)', failed.slice(0, 5).map(e => e.id + ': ' + (e.error || 'unknown')).join(' | '), { tab: 'mods' })
  const dayAgo = Date.now() - 24 * 3600 * 1000
  const recent = queue.filter(e => e.status === 'installed' && e.updatedAt && new Date(e.updatedAt).getTime() > dayAgo)
  if (recent.length) push('info', 'updates', recent.length + ' mod(s) installed or updated in the last 24h', recent.slice(0, 8).map(e => (e.modIds || [e.id]).join(', ')).join(' · '), { tab: 'mods' })

  collectLogAlerts(s, logs => {
    for (const g of logs.server) {
      push(g.count > 50 ? 'warn' : 'info', 'server-log', g.count + '× ' + (g.sample.slice(0, 90)), g.sample, { tab: 'logs' })
    }
    for (const g of logs.manager) {
      push('warn', 'manager-log', g.count + '× ' + (g.sample.slice(0, 90)), g.sample, { tab: 'logs' })
    }
    const rank = { error: 0, warn: 1, info: 2 }
    alerts.sort((a, b) => rank[a.severity] - rank[b.severity])
    res.json({
      alerts,
      counts: {
        error: alerts.filter(a => a.severity === 'error').length,
        warn: alerts.filter(a => a.severity === 'warn').length,
        info: alerts.filter(a => a.severity === 'info').length
      },
      generatedAt: new Date().toISOString()
    })
  })
})

module.exports = router
