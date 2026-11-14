// Listing, creating, downloading, inspecting and restoring backup archives.

const fs = require('fs')
const { spawn } = require('child_process')
const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const { backupDirs } = require('../paths')
const { listBackupDir, validBackupPath } = require('../services/backups')
const archive = require('../services/archive')
const { qs, header } = require('../http')
const { humanBytes } = require('../infra/disk')

const router = require('express').Router()

router.get('/api/backups', (req, res) => {
  const s = srv(req)
  const dirs = backupDirs(s)
  try { fs.mkdirSync(dirs.manual, { recursive: true }) } catch {}
  res.json({
    startup: listBackupDir(dirs.startup),
    version: listBackupDir(dirs.version),
    manual: listBackupDir(dirs.manual)
  })
})

// Stream a fresh tar.gz backup to the client
router.get('/api/backups/create', (req, res) => {
  const s = srv(req)
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const filename = 'pz-backup-' + s.id + '-' + ts + '.tar.gz'
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"')
  res.setHeader('Content-Type', 'application/gzip')

  // Archive: world saves + player DB + all server config files.
  // Saves dir may not exist before first world gen — include what's there.
  const entries = ['db/servertest.db', 'Server']
  if (fs.existsSync(s.data + '/Saves/Multiplayer/servertest')) entries.unshift('Saves/Multiplayer/servertest')
  const tar = spawn('tar', ['-czf', '-', '-C', s.data, ...entries])

  tar.stdout.pipe(res)
  tar.stderr.on('data', d => console.error('[tar]', d.toString().trim()))
  tar.on('error', (e) => { console.error('[tar error]', e.message); if (!res.headersSent) res.status(500).end() })
  req.on('close', () => { try { tar.kill() } catch {} })
})

// Download an existing server backup zip/tar.gz
router.get('/api/backups/download', (req, res) => {
  const p = validBackupPath(srv(req), qs(req.query.type), qs(req.query.name))
  if (!p) return res.status(404).json({ error: 'Backup not found' })
  res.download(p)
})

// List contents of an existing backup (for inspection)
router.get('/api/backups/peek', (req, res) => {
  const p = validBackupPath(srv(req), qs(req.query.type), qs(req.query.name))
  if (!p) return res.status(404).json({ error: 'Backup not found' })
  archive.listMembers(p, (err, names) => {
    if (err) return res.status(500).json({ error: err.message })
    // The same 50-line preview as before, plus the count so a truncated list says so.
    res.json({ contents: names.slice(0, 50).join('\n') || '(empty)', members: names.length })
  })
})

// Restore from an existing server backup
router.post('/api/backups/restore', (req, res) => {
  const s = srv(req)
  const { type, name } = req.body || {}
  const p = validBackupPath(s, typeof type === 'string' ? type : '', typeof name === 'string' ? name : '')
  if (!p) return res.status(404).json({ error: 'Backup not found' })

  archive.extractInto(p, s.data, (err, info) => {
    if (err) return res.status(500).json({ error: err.message })
    logFor(s, 'restored backup "' + name + '" (' + (info ? info.members : 0) + ' entries)')
    res.json({ success: true, members: info ? info.members : 0 })
  })
})

// Upload a backup file and restore from it.
// Accepts a raw application/octet-stream body; the client sets X-Backup-Ext to 'zip' or 'tar.gz'.
//
// Capped: the volume this writes to is the one the game server is saving the world onto, so an
// unbounded upload was a way to stop the server by filling its disk. The archive is also checked
// member by member before anything is extracted — see src/services/archive.js.
router.post('/api/backups/upload', (req, res) => {
  const s = srv(req)
  const ext = header(req, 'x-backup-ext').toLowerCase() === 'tar.gz' ? 'tar.gz' : 'zip'
  const declared = Number(header(req, 'content-length') || 0)
  if (declared && declared > archive.MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: 'Backup is larger than the ' + humanBytes(archive.MAX_UPLOAD_BYTES) + ' upload limit' })
  }

  const tempPath = '/tmp/pz-restore-upload-' + s.id + '.' + (ext === 'tar.gz' ? 'tar.gz' : 'zip')
  const ws = fs.createWriteStream(tempPath)
  const cleanup = () => fs.unlink(tempPath, () => {})

  let received = 0
  let aborted = false
  const fail = (status, message) => {
    if (aborted) return
    aborted = true
    req.unpipe(ws)
    ws.destroy()
    cleanup()
    if (!res.headersSent) res.status(status).json({ error: message })
  }

  // Content-Length can lie, or be absent on a chunked upload, so the real limit is enforced on the
  // bytes that actually arrive.
  req.on('data', chunk => {
    received += chunk.length
    if (received > archive.MAX_UPLOAD_BYTES) {
      fail(413, 'Backup exceeded the ' + humanBytes(archive.MAX_UPLOAD_BYTES) + ' upload limit')
      req.destroy()
    }
  })

  req.pipe(ws)

  ws.on('finish', () => {
    if (aborted) return
    archive.extractInto(tempPath, s.data, (err, info) => {
      cleanup()
      if (err) return res.status(400).json({ error: err.message })
      logFor(s, 'restored uploaded backup (' + humanBytes(received) + ', ' + (info ? info.members : 0) + ' entries)')
      res.json({ success: true, members: info ? info.members : 0 })
    })
  })

  ws.on('error', e => fail(500, e.message))
  req.on('error', e => fail(500, e.message))
})

module.exports = router
