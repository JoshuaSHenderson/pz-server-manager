// The one way this app talks to the manager.
//
// Three things every call needs, which is why none of them are left to call sites:
//
//   1. ?server=<id>. Every per-server endpoint is scoped by it, and the selected server lives in
//      localStorage. A call that forgets it silently acts on the default server instead.
//   2. A 401 means the session expired or was never established. The app re-renders into the login
//      form rather than each caller inventing its own handling.
//   3. A 404 UNKNOWN_SERVER means the selected server no longer exists. The stale selection is
//      dropped and the page reloads once — otherwise every request keeps failing against an id
//      that will never resolve again.
//
// Errors are thrown as ApiError so a caller can show `err.message` directly: the server's error
// strings are written to be read by an operator, and re-wording them here would lose that.

const SERVER_KEY = 'pz-mgr-server'
const RELOADED_KEY = 'pz-mgr-recovered'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly detail?: string

  constructor(status: number, message: string, code?: string, detail?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

/** Thrown when the session is not valid. The app shell catches this and shows the login form. */
export class UnauthenticatedError extends ApiError {
  constructor() {
    super(401, 'Not signed in')
    this.name = 'UnauthenticatedError'
  }
}

export function currentServer(): string {
  try { return localStorage.getItem(SERVER_KEY) || '' } catch { return '' }
}

export function setCurrentServer(id: string): void {
  try { localStorage.setItem(SERVER_KEY, id) } catch { /* private mode: the default server is used */ }
  location.reload()
}

/** Adds ?server=<id> to a manager URL, preserving any query string it already has. */
export function withServer(url: string): string {
  const id = currentServer()
  if (!id) return url
  return url + (url.includes('?') ? '&' : '?') + 'server=' + encodeURIComponent(id)
}

/** Called by the app shell when a 401 comes back, so the UI can swap to the login form. */
let onUnauthenticated: () => void = () => {}
export function setUnauthenticatedHandler(fn: () => void): void {
  onUnauthenticated = fn
}

function recoverFromUnknownServer(): void {
  // Guarded against a reload loop: if dropping the selection did not help, the next 404 falls
  // through to an ordinary error rather than reloading forever.
  try {
    if (sessionStorage.getItem(RELOADED_KEY)) return
    sessionStorage.setItem(RELOADED_KEY, '1')
    localStorage.removeItem(SERVER_KEY)
  } catch { return }
  location.reload()
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return { error: text.slice(0, 500) } }
}

async function request<T>(method: string, path: string, body?: unknown, init?: RequestInit): Promise<T> {
  const res = await fetch(withServer(path), {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  })

  if (res.status === 401) {
    onUnauthenticated()
    throw new UnauthenticatedError()
  }

  const data = await parse(res) as { error?: string; detail?: string; code?: string } | null

  if (res.status === 404 && data?.code === 'UNKNOWN_SERVER') {
    recoverFromUnknownServer()
    throw new ApiError(404, data.error || 'That server no longer exists', data.code)
  }

  if (!res.ok) {
    throw new ApiError(res.status, data?.error || res.statusText || 'Request failed', data?.code, data?.detail)
  }

  // A successful call clears the reload guard, so a genuinely stale selection later can recover.
  try { sessionStorage.removeItem(RELOADED_KEY) } catch { /* nothing to clear */ }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body),

  /** Raw body upload, for the backup restore. */
  upload: <T>(path: string, file: File, ext: string) =>
    request<T>('POST', path, undefined, {
      body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Backup-Ext': ext },
    }),
}

/**
 * An EventSource for one of the log streams.
 *
 * EventSource cannot set request headers, which is the whole reason authentication also accepts a
 * session cookie — see src/auth.js on the server.
 */
export function logStream(path: string, tail: number): EventSource {
  return new EventSource(withServer(path + '?tail=' + tail))
}

/** Exchanges the manager token for a session cookie. */
export async function login(token: string): Promise<void> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!res.ok) {
    const data = await parse(res) as { error?: string } | null
    throw new ApiError(res.status, data?.error || 'Sign-in failed')
  }
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' })
  location.reload()
}

export async function isAuthenticated(): Promise<boolean> {
  try {
    const res = await fetch('/api/auth')
    const data = await res.json() as { authenticated?: boolean }
    return !!data.authenticated
  } catch { return false }
}
