// The two log streams.
//
// One component, rendered twice, because the panes differ only in which endpoint they tail — the
// old UI had two copies of every function (startLog/startManagerLog, clearLog/clearManagerLog, and
// an appendLogLine that took the id of whichever filter box it should read).
//
// They stay separate streams so pausing or filtering one does not affect the other, which is the
// whole reason the manager's own output is shown beside the game's: when a mod fails to install,
// the reason is in the manager's log, not the server's.

import { useCallback, useEffect, useRef, useState } from 'react'
import { logStream } from '../../api/client'
import { Card } from '../../components/Card'
import { PaneHead } from '../../components/ui'

// Enough history to scroll back through an incident, bounded so a server that logs continuously
// cannot grow the tab until the browser gives up.
const MAX_LINES = 3000
const TAIL = 300

type LineClass = 'log-default' | 'log-error' | 'log-warn' | 'log-info'

function classify(line: string): LineClass {
  const lower = line.toLowerCase()
  if (lower.includes('error') || lower.includes('exception') || lower.includes('fatal')) return 'log-error'
  if (lower.includes('warn')) return 'log-warn'
  if (lower.includes('info') || lower.includes('started') || lower.includes('listening')) return 'log-info'
  return 'log-default'
}

const TIMESTAMPED = /^(\d{4}-\d{2}-\d{2}T[\d:.Z]+)\s+(.*)$/

function LogLine({ line }: { line: string }) {
  const cls = classify(line)
  const stamped = TIMESTAMPED.exec(line)
  if (stamped) {
    return (
      <div className="log-line">
        <span className="log-ts">{stamped[1]}</span>
        <span className={cls}>{stamped[2]}</span>
      </div>
    )
  }
  return <div className="log-line"><span className={cls}>{line}</span></div>
}

function LogPane({ title, path, cardId }: { title: string; path: string; cardId: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const outRef = useRef<HTMLDivElement>(null)

  // Read inside the SSE handler, which is created once — without a ref, pausing would have no
  // effect until the stream was torn down and rebuilt.
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    const source = logStream(path, TAIL)
    source.onmessage = e => {
      if (pausedRef.current) return
      let line: string
      try { line = JSON.parse(e.data) as string } catch { return }
      setLines(prev => (prev.length >= MAX_LINES ? [...prev.slice(1), line] : [...prev, line]))
    }
    source.onerror = () => {
      setLines(prev => [...prev, '--- connection lost, reconnecting... ---'])
    }
    // Closed on unmount, which is what makes leaving the tab stop the stream. The old UI relied on
    // switchTab remembering to call stopLog().
    return () => source.close()
  }, [path])

  const shown = filter
    ? lines.filter(l => l.toLowerCase().includes(filter.toLowerCase()))
    : lines

  // Pinned to the bottom unless the operator has scrolled up to read something.
  const atBottomRef = useRef(true)
  const onScroll = useCallback(() => {
    const el = outRef.current?.parentElement
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }, [])

  useEffect(() => {
    const el = outRef.current?.parentElement
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [shown.length])

  return (
    <div className="card" style={{ paddingBottom: '1rem' }}>
      <Card id={cardId} title={title}>
        <div className="log-controls" style={{ marginTop: '.9rem' }}>
          <button className="btn-secondary btn-sm" onClick={() => setPaused(p => !p)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn-secondary btn-sm" onClick={() => setLines([])}>Clear</button>
          <input
            type="text"
            placeholder="Filter..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ width: 200 }}
          />
          <span className="text-muted" style={{ fontSize: '.8rem' }}>{shown.length} lines</span>
        </div>
        <div className="terminal" onScroll={onScroll}>
          <div ref={outRef}>
            {shown.map((l, i) => <LogLine key={i} line={l} />)}
          </div>
        </div>
      </Card>
    </div>
  )
}

export function Logs() {
  return (
    <div className="tab-pane active">
      <PaneHead title="Logs" subtitle="Live server output stream" />
      <LogPane cardId="log-server" title="PZ Server Log" path="/api/logs" />
      {/* The manager's own output: SteamCMD launches, download reconciliation, auto-sync, RCON,
          schedule and Express errors. When a mod fails to install, the reason is in here. */}
      <LogPane cardId="log-manager" title="PZ Server Manager Logs" path="/api/manager-logs" />
    </div>
  )
}
