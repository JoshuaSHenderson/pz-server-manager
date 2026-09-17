// Data-fetching hooks.
//
// Small on purpose. The manager has no websocket for state (only the two log SSE streams), so the
// UI polls — and the rules that matter are about *not* polling: a hidden tab and a background
// window are both wasted requests against a box that is also running a game server.
//
// The old UI polled four endpoints unconditionally from module scope, including one that reads
// every mod.info on disk and calls Steam, fired on page load regardless of which tab was open.

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, UnauthenticatedError } from './client'

export interface AsyncState<T> {
  data: T | null
  error: string | null
  loading: boolean
  /** Refetch now. Safe to call from an event handler. */
  reload: () => void
}

/**
 * Fetches once on mount, and again whenever `deps` change or `reload()` is called.
 *
 * `enabled: false` skips the fetch entirely, which is how a tab's data is left alone until the tab
 * is actually opened.
 */
export function useApi<T>(
  path: string,
  options: { enabled?: boolean; pollMs?: number; deps?: unknown[] } = {},
): AsyncState<T> {
  const { enabled = true, pollMs, deps = [] } = options
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [nonce, setNonce] = useState(0)

  // Held in a ref so a slow response that lands after the component unmounted, or after the path
  // changed, cannot overwrite newer state.
  const live = useRef(0)

  const reload = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    if (!enabled) { setLoading(false); return }
    const generation = ++live.current
    let cancelled = false

    const run = async () => {
      try {
        const result = await api.get<T>(path)
        if (cancelled || generation !== live.current) return
        setData(result)
        setError(null)
      } catch (e) {
        if (cancelled || generation !== live.current) return
        // The app shell has already swapped to the login form; a per-panel error would just be
        // noise behind it.
        if (e instanceof UnauthenticatedError) return
        setError(e instanceof ApiError ? e.message : String(e))
      } finally {
        if (!cancelled && generation === live.current) setLoading(false)
      }
    }

    void run()

    if (!pollMs) return () => { cancelled = true }

    const timer = setInterval(() => {
      // Nothing is worth fetching for a tab nobody is looking at.
      if (document.hidden) return
      void run()
    }, pollMs)
    return () => { cancelled = true; clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, enabled, pollMs, nonce, ...deps])

  return { data, error, loading, reload }
}

/**
 * Runs `fn` on an interval while `enabled`, skipping ticks while the page is hidden.
 * For the polls that are not a plain GET — the reinstall progress watcher, for instance.
 */
export function useInterval(fn: () => void, ms: number | null, enabled = true): void {
  const saved = useRef(fn)
  saved.current = fn

  useEffect(() => {
    if (ms === null || !enabled) return
    const timer = setInterval(() => {
      if (document.hidden) return
      saved.current()
    }, ms)
    return () => clearInterval(timer)
  }, [ms, enabled])
}

export interface ActionState {
  /** Runs an async action, reporting failure through the message returned. */
  run: (fn: () => Promise<unknown>, successMessage?: string) => Promise<boolean>
  busy: boolean
  message: { text: string; kind: 'success' | 'error' | 'info' } | null
  setMessage: (m: { text: string; kind: 'success' | 'error' | 'info' } | null) => void
}

/**
 * The shared shape of "press a button, call the API, say what happened".
 *
 * Every action in this UI needs the same three things — a busy flag so it cannot be double-fired, a
 * message area, and the server's own error text shown verbatim rather than reworded.
 */
export function useAction(): ActionState {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<ActionState['message']>(null)

  const run = useCallback(async (fn: () => Promise<unknown>, successMessage?: string) => {
    setBusy(true)
    try {
      await fn()
      if (successMessage) setMessage({ text: successMessage, kind: 'success' })
      return true
    } catch (e) {
      if (e instanceof UnauthenticatedError) return false
      const detail = e instanceof ApiError && e.detail ? ' — ' + e.detail : ''
      setMessage({ text: (e instanceof Error ? e.message : String(e)) + detail, kind: 'error' })
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  return { run, busy, message, setMessage }
}
