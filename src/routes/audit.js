// The disk audit, and the deletion of what it finds unreferenced.
//
// The audit is recomputed inside the delete handlers rather than trusted from the client, so a
// stale page can never delete something that has since become referenced.

const path = require('path')
const fs = require('fs')
const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const { modsDir, workshopContent } = require('../paths')
const { auditServer } = require('../services/audit')
const disk = require('../infra/disk')
const { humanBytes } = disk

const router = require('express').Router()

router.get('/api/audit', (req, res) => {
  try { res.json(auditServer(srv(req))) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

// Deletes one orphaned artefact found by the audit. Scoped deliberately: only things the audit
// classed as unreferenced, never a registered mod.
router.delete('/api/audit/orphan', (req, res) => {
  const s = srv(req)
  const { kind, id } = req.body || {}
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required' })
  const audit = auditServer(s)
  let target
  if (kind === 'workshop') {
    if (!audit.unregistered.some(u => u.workshopId === id)) return res.status(400).json({ error: 'Not an unregistered Workshop item: ' + id })
    target = path.join(workshopContent(s), id)
  } else if (kind === 'folder') {
    if (!audit.orphanFolders.some(o => o.folder === id)) return res.status(400).json({ error: 'Not an orphaned mod folder: ' + id })
    target = path.join(modsDir(s), id)
  } else {
    return res.status(400).json({ error: 'kind must be "workshop" or "folder"' })
  }
  const bytes = disk.dirSizeSync(target)
  try { fs.rmSync(target, { recursive: true, force: true }) }
  catch (e) { return res.status(500).json({ error: 'Delete failed: ' + e.message }) }
  logFor(s, 'deleted orphaned ' + kind + ' "' + id + '" - freed ' + humanBytes(bytes))
  res.json({ success: true, kind, id, freed: humanBytes(bytes) })
})

// Bulk removal of every orphan the audit currently reports. The audit is recomputed here rather
// than trusting a list from the client, so a stale page can never delete something that has since
// become referenced. Only the two unreferenced categories are touched — missingContent and
// phantomEnabled are ini problems, not files, and are never deleted.
router.delete('/api/audit/orphans', (req, res) => {
  const s = srv(req)
  let audit
  try { audit = auditServer(s) } catch (e) { return res.status(500).json({ error: e.message }) }

  const targets = []
  for (const u of audit.unregistered) targets.push({ kind: 'workshop', id: u.workshopId, path: path.join(workshopContent(s), u.workshopId), bytes: u.bytes })
  for (const o of audit.orphanFolders) targets.push({ kind: 'folder', id: o.folder, path: path.join(modsDir(s), o.folder), bytes: o.bytes })

  const deleted = []
  const failed = []
  let freed = 0
  for (const t of targets) {
    try { fs.rmSync(t.path, { recursive: true, force: true }); deleted.push({ kind: t.kind, id: t.id }); freed += t.bytes }
    catch (e) { failed.push({ kind: t.kind, id: t.id, error: e.message }) }
  }
  logFor(s, 'bulk orphan delete: removed ' + deleted.length + ' item(s), freed ' + humanBytes(freed) + (failed.length ? ', ' + failed.length + ' failed' : ''))
  res.json({ success: true, deleted: deleted.length, failed, freed: humanBytes(freed), freedBytes: freed })
})

module.exports = router
