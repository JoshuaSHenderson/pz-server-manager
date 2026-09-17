// The small shared pieces. Each one existed in the original as a string of HTML built inline in
// several places; the only change is that they are now written once.

import { useEffect, type ReactNode } from 'react'

export type MessageKind = 'success' | 'error' | 'info' | 'warn'

export interface MessageProps {
  text: string
  kind?: MessageKind
  /** Clears itself after this many ms. Errors default to staying until replaced. */
  timeout?: number | null
  onClear?: () => void
}

export function Message({ text, kind = 'info', timeout, onClear }: MessageProps) {
  // An error the operator has not read yet must not vanish on a timer — the old UI cleared every
  // message after five seconds regardless, including the ones explaining why something failed.
  const ms = timeout === undefined ? (kind === 'error' ? null : 5000) : timeout

  useEffect(() => {
    if (!ms || !onClear) return
    const t = setTimeout(onClear, ms)
    return () => clearTimeout(t)
  }, [ms, onClear, text])

  return <div className={'msg msg-' + kind}>{text}</div>
}

/** Renders nothing when there is no message, so callers can drop it in unconditionally. */
export function MessageSlot({ message, onClear }: {
  message: { text: string; kind: MessageKind } | null
  onClear?: () => void
}) {
  if (!message) return null
  return <Message text={message.text} kind={message.kind} onClear={onClear} />
}

export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={'badge badge-' + kind}>{children}</span>
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

export function Stat({ value, label, style }: { value: ReactNode; label: string; style?: React.CSSProperties }) {
  return (
    <div className="stat">
      <div className="stat-value" style={style}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>
}

export function PaneHead({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="pane-head">
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </div>
  )
}

/**
 * A sortable table header cell.
 *
 * The arrow is drawn for the active column only, which is how the original showed sort direction.
 */
export function SortHeader<K extends string>({ label, column, sort, onSort, style }: {
  label: string
  column: K
  sort: { key: K; dir: 1 | -1 }
  onSort: (key: K) => void
  style?: React.CSSProperties
}) {
  const active = sort.key === column
  return (
    <th
      onClick={() => onSort(column)}
      style={{ cursor: 'pointer', userSelect: 'none', ...(active ? { color: 'var(--text)' } : {}), ...style }}
    >
      {label}{active ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
    </th>
  )
}

/** Bytes, formatted the way the server formats them, for the few places the UI does its own. */
export function humanBytes(n: number): string {
  if (!n || n < 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i]
}

/** A timestamp as the operator reads it, or an em dash when there is not one. */
export function when(iso: string | null | undefined): string {
  if (!iso) return '—'
  const t = Date.parse(iso)
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '—'
}
