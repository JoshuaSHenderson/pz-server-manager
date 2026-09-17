// A mirror of the server's sandbox validation rules, for immediate feedback while typing.
//
// The server re-validates everything regardless — this exists so a bad value is visible before a
// request is made, not so the server can trust the client. Kept apart from the form component
// because it is the piece worth reasoning about on its own: these rules decide whether a value can
// reach servertest_SandboxVars.lua, and a wrong answer there is a world that will not load.

import type { SandboxField, SandboxSection } from '../../api/types'

export type FieldValue = boolean | number | string

/** "Section.Key" — the id the save endpoint expects. */
export function fieldId(f: SandboxField): string {
  return f.section + '.' + f.key
}

export function validateField(f: SandboxField, v: FieldValue): string | null {
  if (f.type === 'boolean') return typeof v === 'boolean' ? null : 'must be true or false'

  if (f.type === 'enum') {
    return (f.options ?? []).some(o => o.value === String(v)) ? null : 'not a valid option'
  }

  if (f.type === 'int' || f.type === 'float') {
    if (String(v).trim() === '') return 'cannot be blank'
    const n = Number(v)
    if (!Number.isFinite(n)) return 'must be a number'
    if (f.type === 'int' && !Number.isInteger(n)) return 'must be a whole number'
    if (f.min !== null && n < f.min) return 'minimum is ' + f.min
    if (f.max !== null && n > f.max) return 'maximum is ' + f.max
    return null
  }

  if (f.type === 'string') {
    // Both would end the Lua string literal the value is written into.
    if (String(v).includes('"')) return 'cannot contain double quotes'
    if (String(v).includes('\\')) return 'cannot contain backslashes'
    return null
  }

  // 'raw' — a shape this parser did not recognise. The form refuses to guess at it.
  return null
}

/** The edits made so far, keyed by field id. Only these are sent, so untouched lines are untouched. */
export type Edits = Record<string, FieldValue>

export function currentValue(f: SandboxField, edits: Edits): FieldValue {
  const id = fieldId(f)
  return Object.prototype.hasOwnProperty.call(edits, id) ? edits[id]! : f.value
}

export function isDirty(f: SandboxField, edits: Edits): boolean {
  const id = fieldId(f)
  if (!Object.prototype.hasOwnProperty.call(edits, id)) return false
  return String(edits[id]) !== String(f.value)
}

export interface DirtySummary {
  changed: number
  invalid: number
}

export function summarise(sections: SandboxSection[], edits: Edits): DirtySummary {
  let changed = 0
  let invalid = 0
  for (const section of sections) {
    for (const f of section.fields) {
      if (!isDirty(f, edits)) continue
      changed++
      if (validateField(f, currentValue(f, edits))) invalid++
    }
  }
  return { changed, invalid }
}

export interface BuildResult {
  updates: Record<string, FieldValue>
  invalid: string[]
}

/**
 * Turns the edits into the payload the API expects, coercing numbers out of the strings the input
 * elements produce.
 */
export function buildUpdates(sections: SandboxSection[], edits: Edits): BuildResult {
  const updates: Record<string, FieldValue> = {}
  const invalid: string[] = []

  for (const section of sections) {
    for (const f of section.fields) {
      if (!isDirty(f, edits)) continue
      const v = currentValue(f, edits)
      const err = validateField(f, v)
      if (err) { invalid.push(fieldId(f) + ': ' + err); continue }
      updates[fieldId(f)] = f.type === 'int' ? parseInt(String(v), 10)
        : f.type === 'float' ? Number(v)
          : v
    }
  }

  return { updates, invalid }
}
