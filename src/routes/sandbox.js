// The sandbox options editor.
//
// Registered before the config router, whose PUT /api/config would not collide but whose GET would
// be confusing to find these under.
//
// Everything is validated before anything is written: if one value is invalid, nothing is written
// and all the errors come back at once. Only then is a timestamped backup taken and the file
// rewritten line by line, so every comment and blank line survives byte-for-byte.

const fs = require('fs')
const path = require('path')
const registry = require('../registry/servers')
const { srv } = registry
const { logFor } = require('../log')
const { sandboxPath } = require('../paths')
const {
  parseSandbox, validateSandboxValue, formatSandboxValue, sandboxStructureOk, SANDBOX_KEY_RE,
} = require('../domain/sandbox')

const router = require('express').Router()

router.get('/api/config/sandbox', (req, res) => {
  const s = srv(req)
  try {
    const content = fs.readFileSync(sandboxPath(s), 'utf8')
    const parsed = parseSandbox(content)
    res.json({ sections: parsed.sections, raw: content })
  } catch (e) {
    res.status(404).json({ error: 'SandboxVars file not found', detail: e.message })
  }
})

// Structured save. Accepts { updates: { "Section.Key": value, ... } }.
//
// Everything is validated first — if any single value is invalid, nothing is written and all
// errors come back at once. Only then is a timestamped backup taken and the file rewritten
// line-by-line, so unedited lines (including every comment) are preserved byte-for-byte.
router.put('/api/config/sandbox', (req, res) => {
  const s = srv(req)
  const body = req.body || {}

  // Raw-mode escape hatch, still validated for structure before it's allowed to land.
  if (typeof body.content === 'string') {
    if (!body.content.trim()) return res.status(400).json({ error: 'Empty content' })
    if (!sandboxStructureOk(body.content)) {
      return res.status(400).json({ error: 'Unbalanced braces — the file would be invalid Lua. Nothing was saved.' })
    }
    try {
      const backup = sandboxPath(s) + '.' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.bak'
      fs.copyFileSync(sandboxPath(s), backup)
      fs.writeFileSync(sandboxPath(s), body.content)
      return res.json({ success: true, backup: path.basename(backup), mode: 'raw' })
    } catch (e) { return res.status(500).json({ error: e.message }) }
  }

  const updates = body.updates
  if (!updates || typeof updates !== 'object') return res.status(400).json({ error: 'No updates provided' })

  let content, parsed
  try {
    content = fs.readFileSync(sandboxPath(s), 'utf8')
    parsed = parseSandbox(content)
  } catch (e) { return res.status(500).json({ error: 'Could not read SandboxVars: ' + e.message }) }

  const byId = {}
  for (const sec of parsed.sections) for (const f of sec.fields) byId[f.section + '.' + f.key] = f

  // Validate everything before touching the file.
  const errors = []
  const applies = []
  for (const [id, value] of Object.entries(updates)) {
    const field = byId[id]
    if (!field) { errors.push(id + ': unknown option (was the file changed elsewhere?)'); continue }
    const err = validateSandboxValue(field, value)
    if (err) { errors.push(err); continue }
    applies.push({ field, formatted: formatSandboxValue(field, value) })
  }
  if (errors.length) return res.status(400).json({ error: 'Validation failed — nothing was saved', errors })

  // Surgical per-line replacement: only the value between "Key = " and the trailing comma moves.
  const lines = content.split('\n')
  let changed = 0
  for (const { field, formatted } of applies) {
    const idx = field.line - 1
    const line = lines[idx]
    const m = line && line.match(SANDBOX_KEY_RE)
    if (!m || m[2] !== field.key) {
      return res.status(409).json({ error: 'SandboxVars changed on disk while editing (line ' + field.line + ' no longer holds ' + field.key + '). Reload and try again.' })
    }
    const newLine = m[1] + field.key + ' = ' + formatted + ','
    if (newLine !== line) { lines[idx] = newLine; changed++ }
  }
  const out = lines.join('\n')

  if (!sandboxStructureOk(out)) {
    return res.status(500).json({ error: 'Refusing to save: result failed the structure check.' })
  }
  // Round-trip check — the rewritten file must still parse to the same set of options.
  try {
    const reparsed = parseSandbox(out)
    const before = parsed.sections.reduce((n, sec) => n + sec.fields.length, 0)
    const after = reparsed.sections.reduce((n, sec) => n + sec.fields.length, 0)
    if (before !== after) {
      return res.status(500).json({ error: 'Refusing to save: option count changed (' + before + ' → ' + after + ').' })
    }
  } catch (e) {
    return res.status(500).json({ error: 'Refusing to save: result no longer parses (' + e.message + ')' })
  }

  try {
    const backup = sandboxPath(s) + '.' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.bak'
    fs.copyFileSync(sandboxPath(s), backup)
    fs.writeFileSync(sandboxPath(s), out)
    res.json({ success: true, changed, backup: path.basename(backup) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// Lists the timestamped backups this editor has written, newest first.
router.get('/api/config/sandbox/backups', (req, res) => {
  const s = srv(req)
  const dir = path.dirname(sandboxPath(s))
  const base = path.basename(sandboxPath(s))
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(base + '.') && f.endsWith('.bak'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtime.toISOString() }))
      .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
    res.json({ backups: files })
  } catch (e) { res.json({ backups: [] }) }
})

module.exports = router
