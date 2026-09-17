// Parsing and editing servertest_SandboxVars.lua.
//
// Pure: every function here takes text and returns a value or a description of one. Nothing reads
// or writes a file, which is what lets it be tested (sandbox.test.js) — and it badly needed to be.
// It is 180 lines of hand-written parser sitting in front of a file that, written back wrong, can
// stop a world loading, and it had no test at all.

// servertest_SandboxVars.lua is a Lua table, not an ini. Rather than round-tripping Lua
// (fragile, and it would discard the descriptive comments the game ships), this parses the file
// into typed field descriptors for a real form UI, and writes changes back by surgically
// replacing only the value on each changed line. That keeps every comment, blank line and
// indentation byte-identical, so a save can never reformat or damage the file.

const SANDBOX_KEY_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?),?\s*$/
const SANDBOX_OPEN_RE = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\{\s*$/
const SANDBOX_CLOSE_RE = /^\s*\}\s*,?\s*$/

// Turns the comment lines that precede a key into structured metadata.
// PZ writes: a prose description, optional "Min: x Max: y Default: z", and optional
// "-- N = Label" enum lines.
function parseSandboxComments(buf) {
  const meta = { description: '', options: null, min: null, max: null, default: null }
  const descParts = []
  for (const raw of buf) {
    const line = raw.replace(/^\s*--\s?/, '').trim()
    if (!line) continue
    const opt = line.match(/^(-?\d+)\s*=\s*(.+)$/)
    if (opt) {
      if (!meta.options) meta.options = []
      meta.options.push({ value: opt[1], label: opt[2].trim() })
      continue
    }
    const mm = line.match(/Min:\s*(-?[\d.]+)\s*Max:\s*(-?[\d.]+)(?:\s*Default:\s*(-?[\d.]+))?/i)
    if (mm) {
      meta.min = parseFloat(mm[1])
      meta.max = parseFloat(mm[2])
      if (mm[3] !== undefined) meta.default = mm[3]
      const before = line.slice(0, mm.index).trim()
      if (before) descParts.push(before)
      continue
    }
    const dm = line.match(/^Default\s*=\s*(.+)$/i)
    if (dm) { meta.default = dm[1].trim(); continue }
    descParts.push(line)
  }
  meta.description = descParts.join(' ').trim()
  return meta
}

function classifySandboxValue(rawValue, meta) {
  if (/^(true|false)$/i.test(rawValue)) return { type: 'boolean', value: rawValue.toLowerCase() === 'true' }
  if (/^".*"$/s.test(rawValue)) return { type: 'string', value: rawValue.slice(1, -1) }
  if (/^-?\d+$/.test(rawValue)) {
    // An integer that has labelled options is really an enum choice.
    if (meta.options && meta.options.length) return { type: 'enum', value: rawValue }
    return { type: 'int', value: parseInt(rawValue, 10) }
  }
  if (/^-?\d*\.\d+$/.test(rawValue)) return { type: 'float', value: parseFloat(rawValue) }
  return { type: 'raw', value: rawValue }
}

// Parses the file into { sections: [{ name, fields: [...] }] }. Each field carries its 1-based
// line number, which is what the writer uses to target its replacement.
function parseSandbox(content) {
  const lines = content.split('\n')
  const sections = []
  const stack = []
  let commentBuf = []
  const rootName = 'General'
  let current = { name: rootName, fields: [] }
  sections.push(current)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (/^--/.test(trimmed)) { commentBuf.push(trimmed); continue }
    if (!trimmed) { commentBuf = []; continue }

    if (/^SandboxVars\s*=\s*\{\s*$/.test(trimmed)) { commentBuf = []; continue }

    const open = line.match(SANDBOX_OPEN_RE)
    if (open) {
      stack.push(current)
      current = { name: open[2], fields: [] }
      sections.push(current)
      commentBuf = []
      continue
    }

    if (SANDBOX_CLOSE_RE.test(trimmed)) {
      if (stack.length) current = stack.pop()
      commentBuf = []
      continue
    }

    const kv = line.match(SANDBOX_KEY_RE)
    if (kv) {
      const key = kv[2]
      const rawValue = kv[3].trim()
      const meta = parseSandboxComments(commentBuf)
      const cls = classifySandboxValue(rawValue, meta)
      current.fields.push({
        key,
        section: current.name,
        line: i + 1,
        type: cls.type,
        value: cls.value,
        raw: rawValue,
        description: meta.description,
        options: meta.options,
        min: meta.min,
        max: meta.max,
        default: meta.default
      })
      commentBuf = []
      continue
    }
    commentBuf = []
  }
  return { sections: sections.filter(sec => sec.fields.length) }
}

// Validates one incoming value against the field it targets. Returns an error string, or null.
function validateSandboxValue(field, value) {
  const label = field.section + '.' + field.key
  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return label + ': must be true or false'
      return null
    case 'enum': {
      const v = String(value)
      if (!/^-?\d+$/.test(v)) return label + ': must be one of the listed options'
      if (field.options && !field.options.some(o => o.value === v)) {
        return label + ': "' + v + '" is not a valid option (expected ' + field.options.map(o => o.value).join(', ') + ')'
      }
      return null
    }
    case 'int': {
      if (typeof value === 'string' && !/^-?\d+$/.test(value.trim())) return label + ': must be a whole number'
      const n = Number(value)
      if (!Number.isFinite(n)) return label + ': must be a whole number'
      if (!Number.isInteger(n)) return label + ': must be a whole number (no decimals)'
      if (field.min !== null && n < field.min) return label + ': must be at least ' + field.min
      if (field.max !== null && n > field.max) return label + ': must be at most ' + field.max
      return null
    }
    case 'float': {
      const n = Number(value)
      if (!Number.isFinite(n)) return label + ': must be a number'
      if (field.min !== null && n < field.min) return label + ': must be at least ' + field.min
      if (field.max !== null && n > field.max) return label + ': must be at most ' + field.max
      return null
    }
    case 'string': {
      if (typeof value !== 'string') return label + ': must be text'
      if (/[\r\n]/.test(value)) return label + ': cannot contain line breaks'
      if (value.includes('"')) return label + ': cannot contain double quotes'
      if (value.includes('\\')) return label + ': cannot contain backslashes'
      return null
    }
    default:
      return label + ': this option has an unrecognised format and can only be edited in raw mode'
  }
}

// Renders a validated value back into Lua source form.
function formatSandboxValue(field, value) {
  switch (field.type) {
    case 'boolean': return value ? 'true' : 'false'
    case 'enum': return String(value)
    case 'int': return String(parseInt(value, 10))
    case 'float': {
      const n = Number(value)
      // Keep a decimal point so a float field never silently becomes an int in the file.
      return Number.isInteger(n) ? n.toFixed(1) : String(n)
    }
    case 'string': return '"' + value + '"'
    default: return String(value)
  }
}

// Cheap structural check that the rewritten file is still a well-formed Lua table.
function sandboxStructureOk(content) {
  let depth = 0
  for (const ch of content) {
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth < 0) return false }
  }
  return depth === 0
}

module.exports = {
  parseSandboxComments, classifySandboxValue, parseSandbox,
  validateSandboxValue, formatSandboxValue, sandboxStructureOk,
  SANDBOX_KEY_RE, SANDBOX_OPEN_RE, SANDBOX_CLOSE_RE,
}
