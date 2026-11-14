// A collapsible card.
//
// Uses <details>/<summary> exactly as the original did, so the CSS that draws the caret and the
// collapsed spacing applies unchanged. The open state is remembered per card id, which the old UI
// carried in a module-level `panelOpen` object that every re-render had to read and write by hand —
// the panels rebuilt themselves with innerHTML on every refresh, so without it every poll silently
// re-opened whatever the operator had closed.
//
// Remembered in sessionStorage rather than component state so it also survives a tab switch, which
// unmounts the card entirely.

import { useCallback, useState, type ReactNode } from 'react'

const KEY_PREFIX = 'pz-mgr-panel:'

function readOpen(id: string, fallback: boolean): boolean {
  try {
    const saved = sessionStorage.getItem(KEY_PREFIX + id)
    return saved === null ? fallback : saved === '1'
  } catch { return fallback }
}

export interface CardProps {
  /** Stable id, used to remember whether this card is open. */
  id: string
  title: ReactNode
  /** Whether it starts open the first time it is ever seen. */
  defaultOpen?: boolean
  /** Rendered to the right of the title inside the summary — a count, a badge, a Refresh button. */
  aside?: ReactNode
  children: ReactNode
}

export function Card({ id, title, defaultOpen = true, aside, children }: CardProps) {
  const [open, setOpen] = useState(() => readOpen(id, defaultOpen))

  const onToggle = useCallback((e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const next = e.currentTarget.open
    setOpen(next)
    try { sessionStorage.setItem(KEY_PREFIX + id, next ? '1' : '0') } catch { /* private mode */ }
  }, [id])

  return (
    <div className="card">
      <details open={open} onToggle={onToggle}>
        <summary>
          <span className="card-title">{title}</span>
          {aside}
        </summary>
        {children}
      </details>
    </div>
  )
}

/** A card that is never collapsible — the same frame without the disclosure behaviour. */
export function PlainCard({ children }: { children: ReactNode }) {
  return <div className="card">{children}</div>
}
