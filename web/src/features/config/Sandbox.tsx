// The sandbox and mod options form.
//
// The server parses servertest_SandboxVars.lua into typed field descriptors and writes changes back
// by replacing only the value on each changed line — so every comment, blank line and indentation
// byte survives a save. This form's job is to only ever send the fields that were actually edited.

import { useMemo, useState } from 'react'
import { api } from '../../api/client'
import { useAction, useApi } from '../../api/hooks'
import type { SandboxBackup, SandboxField, SandboxResponse } from '../../api/types'
import { Card } from '../../components/Card'
import { Empty, Message, MessageSlot } from '../../components/ui'
import {
  buildUpdates, currentValue, fieldId, isDirty, summarise, validateField,
  type Edits, type FieldValue,
} from './sandboxValidation'

export function Sandbox() {
  const { data, error, reload } = useApi<SandboxResponse>('/api/config/sandbox')
  const backups = useApi<{ backups: SandboxBackup[] }>('/api/config/sandbox/backups')
  const action = useAction()

  const [edits, setEdits] = useState<Edits>({})
  const [section, setSection] = useState('')
  const [filter, setFilter] = useState('')
  const [changedOnly, setChangedOnly] = useState(false)
  const [invalidOnSave, setInvalidOnSave] = useState<string[]>([])

  const sections = data?.sections ?? []
  const { changed, invalid } = useMemo(() => summarise(sections, edits), [sections, edits])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return sections
      .filter(s => !section || s.name === section)
      .map(s => ({
        name: s.name,
        fields: s.fields.filter(f => {
          if (changedOnly && !isDirty(f, edits)) return false
          if (!needle) return true
          return f.key.toLowerCase().includes(needle) || (f.description || '').toLowerCase().includes(needle)
        }),
      }))
      .filter(s => s.fields.length > 0)
  }, [sections, section, filter, changedOnly, edits])

  const setValue = (f: SandboxField, v: FieldValue) => setEdits(prev => ({ ...prev, [fieldId(f)]: v }))

  const discard = () => {
    if (changed && !confirm('Discard all pending changes?')) return
    setEdits({})
    setInvalidOnSave([])
    action.setMessage({ text: 'Changes discarded.', kind: 'info' })
  }

  const save = async () => {
    const { updates, invalid: bad } = buildUpdates(sections, edits)
    setInvalidOnSave(bad)
    if (bad.length) return
    if (!Object.keys(updates).length) {
      return action.setMessage({ text: 'No changes to save.', kind: 'info' })
    }
    const res = await api.put<{ changed: number; backup: string }>('/api/config/sandbox', { updates })
      .catch(e => { action.setMessage({ text: String(e.message ?? e), kind: 'error' }); return null })
    if (!res) return
    action.setMessage({
      text: 'Saved ' + res.changed + ' option(s). Backup: ' + res.backup + '. Restart the server to apply.',
      kind: 'success',
    })
    setEdits({})
    reload()
    backups.reload()
  }

  return (
    <div style={{ marginTop: '1.4rem' }}>
      <Card
        id="config-sandbox"
        title="Sandbox & Mod Options"
        aside={
          <span
            className="text-muted"
            style={{ fontSize: '.8rem', fontFamily: 'var(--font-mono)', color: invalid ? '#e74c3c' : undefined }}
          >
            {changed
              ? changed + ' change' + (changed > 1 ? 's' : '') + (invalid ? ' · ' + invalid + ' invalid' : '') + ' pending'
              : ''}
          </span>
        }
      >
        <p style={{ fontSize: '.85rem', color: 'var(--muted)', margin: '0 0 1rem' }}>
          Sandbox settings and most mods' own options. Values are validated against each option's type
          and allowed range before anything is written, and a timestamped backup is taken on every save.
        </p>

        <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <select
            className="server-select"
            style={{ width: 'auto', margin: 0, padding: '.35rem .6rem', fontSize: '.85rem' }}
            value={section}
            onChange={e => setSection(e.target.value)}
          >
            <option value="">All sections</option>
            {sections.map(s => <option key={s.name} value={s.name}>{s.name} ({s.fields.length})</option>)}
          </select>
          <input
            type="text"
            placeholder="Search options..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ flex: 1, minWidth: 180, padding: '.35rem .55rem', fontSize: '.85rem' }}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: '.45rem', cursor: 'pointer', fontSize: '.8rem', color: 'var(--muted)' }}>
            <input type="checkbox" checked={changedOnly} onChange={e => setChangedOnly(e.target.checked)} /> Changed only
          </label>
        </div>

        {invalidOnSave.length > 0 && (
          <div className="msg msg-error" style={{ marginBottom: '1rem' }}>
            <strong>Fix these before saving:</strong>
            {invalidOnSave.map(e => <div key={e}>{e}</div>)}
          </div>
        )}
        <MessageSlot message={action.message} onClear={() => action.setMessage(null)} />

        {error ? <Empty>Could not load: {error}</Empty>
          : !data ? <Empty>Loading...</Empty>
            : !visible.length ? <Empty>No options match</Empty>
              : visible.map(s => (
                <div key={s.name} style={{ marginBottom: '1.6rem' }}>
                  <div style={{
                    fontFamily: 'var(--font-mono)', fontSize: '.75rem', textTransform: 'uppercase',
                    letterSpacing: '.1em', color: 'var(--accent)', marginBottom: '.75rem',
                    paddingBottom: '.35rem', borderBottom: '1px solid var(--border)',
                  }}>
                    {s.name} <span style={{ opacity: .5 }}>{s.fields.length}</span>
                  </div>
                  {s.fields.map(f => (
                    <Field key={fieldId(f)} field={f} edits={edits} onChange={setValue} />
                  ))}
                </div>
              ))}

        <div style={{ marginTop: '1rem', display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-primary" onClick={save} disabled={invalid > 0 || action.busy}>Save Changes</button>
          <button className="btn-secondary" onClick={discard}>Discard Changes</button>
        </div>

        <RawEditor onSaved={() => { reload(); backups.reload() }} backups={backups.data?.backups ?? []} />
      </Card>
    </div>
  )
}

function Field({ field, edits, onChange }: {
  field: SandboxField
  edits: Edits
  onChange: (f: SandboxField, v: FieldValue) => void
}) {
  const value = currentValue(field, edits)
  const dirty = isDirty(field, edits)
  const err = validateField(field, value)

  const hints: string[] = []
  if (field.min !== null) hints.push('Range ' + field.min + '–' + field.max)
  if (field.default) hints.push('Default ' + field.default)
  hints.push(field.type)

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '.35rem .5rem', fontSize: '.85rem', fontFamily: 'var(--font-mono)',
  }

  return (
    <div
      className="sandbox-field"
      style={{
        display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,260px)', gap: '1rem',
        alignItems: 'start', padding: '.6rem .75rem',
        borderLeft: '2px solid ' + (err ? '#e74c3c' : dirty ? 'var(--accent)' : 'transparent'),
        marginBottom: '.35rem', background: 'rgba(255,255,255,.015)',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: '.85rem', fontFamily: 'var(--font-mono)', wordBreak: 'break-word' }}>
          {field.key}
          {dirty && <span style={{ color: 'var(--accent)', fontSize: '.7rem' }}> changed</span>}
        </div>
        {field.description && (
          <div style={{ fontSize: '.75rem', color: 'var(--muted)', marginTop: '.2rem' }}>{field.description}</div>
        )}
        <div style={{ fontSize: '.68rem', color: 'var(--muted)', opacity: .7, marginTop: '.2rem', fontFamily: 'var(--font-mono)' }}>
          {hints.join(' · ')}
        </div>
      </div>

      <div>
        {field.type === 'boolean' ? (
          <label style={{ display: 'flex', alignItems: 'center', gap: '.55rem', cursor: 'pointer', fontSize: '.85rem' }}>
            <input type="checkbox" checked={!!value} onChange={e => onChange(field, e.target.checked)} />
            {value ? 'Enabled' : 'Disabled'}
          </label>
        ) : field.type === 'enum' ? (
          <select
            className="server-select"
            style={{ width: '100%', margin: 0, padding: '.35rem .5rem', fontSize: '.85rem' }}
            value={String(value)}
            onChange={e => onChange(field, e.target.value)}
          >
            {(field.options ?? []).map(o => (
              <option key={o.value} value={o.value}>{o.label} ({o.value})</option>
            ))}
          </select>
        ) : field.type === 'int' || field.type === 'float' ? (
          <input
            type="number"
            step={field.type === 'int' ? 1 : 'any'}
            min={field.min ?? undefined}
            max={field.max ?? undefined}
            value={String(value)}
            style={inputStyle}
            onChange={e => onChange(field, e.target.value)}
          />
        ) : (
          <input type="text" value={String(value)} style={inputStyle} onChange={e => onChange(field, e.target.value)} />
        )}
        {err && <div style={{ fontSize: '.7rem', color: '#e74c3c', marginTop: '.25rem' }}>{err}</div>}
      </div>
    </div>
  )
}

/** Raw editing, behind a disclosure, because it bypasses every rule above it. */
function RawEditor({ onSaved, backups }: { onSaved: () => void; backups: SandboxBackup[] }) {
  const [content, setContent] = useState('')
  const [result, setResult] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)

  const save = async () => {
    if (!confirm('Save the raw file? This bypasses per-option validation.')) return
    try {
      const res = await api.put<{ backup: string }>('/api/config/sandbox', { content })
      setResult({ text: 'Raw file saved. Backup: ' + res.backup + '. Restart to apply.', kind: 'success' })
      onSaved()
    } catch (e) {
      setResult({ text: e instanceof Error ? e.message : String(e), kind: 'error' })
    }
  }

  return (
    <details style={{ marginTop: '1.5rem' }}>
      <summary style={{ cursor: 'pointer', fontSize: '.88rem', color: 'var(--muted)' }}>
        Advanced: edit raw file / view backups
      </summary>
      <p style={{ fontSize: '.8rem', color: 'var(--muted)', margin: '.85rem 0 .5rem' }}>
        Raw editing bypasses per-option validation — only brace balance is checked. Prefer the form above.
      </p>
      <textarea
        rows={14}
        value={content}
        onChange={e => setContent(e.target.value)}
        placeholder="Paste the full servertest_SandboxVars.lua contents here to replace the file."
        style={{
          width: '100%', fontFamily: 'var(--font-mono)', fontSize: '.78rem', resize: 'vertical',
          boxSizing: 'border-box', whiteSpace: 'pre',
        }}
      />
      <div style={{ marginTop: '.6rem' }}>
        <button className="btn-secondary btn-sm" onClick={save} disabled={!content.trim()}>Save Raw File</button>
      </div>
      {result && <Message text={result.text} kind={result.kind} timeout={null} />}

      <div style={{ marginTop: '1rem' }}>
        <div style={{
          fontSize: '.78rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)',
          textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: '.4rem',
        }}>Backups</div>
        <div style={{ fontSize: '.78rem', color: 'var(--muted)' }}>
          {backups.length
            ? backups.slice(0, 10).map(b => (
              <div key={b.name} className="mono" style={{ fontSize: '.72rem' }}>
                {b.name} <span style={{ opacity: .6 }}>{new Date(b.mtime).toLocaleString()}</span>
              </div>
            ))
            : <span style={{ opacity: .7 }}>No backups yet — one is created on each save.</span>}
        </div>
      </div>
    </details>
  )
}
