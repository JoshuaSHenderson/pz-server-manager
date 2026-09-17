// The sign-in form.
//
// New, because the API was previously open to anything that could reach the port. The token is
// exchanged for a session cookie by POST /api/login and never stored by this page — a token in
// localStorage would outlive the session it was meant to establish, and would be readable by
// anything else running on the origin.

import { useState, type FormEvent } from 'react'
import { login } from '../api/client'
import { Message } from './ui'

export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!token.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await login(token.trim())
      onSignedIn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem',
    }}>
      <form className="card" onSubmit={submit} style={{ width: 'min(420px, 100%)' }}>
        <div className="brand" style={{ marginBottom: '1.25rem' }}>
          <div className="brand-mark"><img src="/server-icon.png" alt="" /></div>
          <div className="logo">PZ Server<small>Manager // Ops</small></div>
        </div>

        <label
          htmlFor="manager-token"
          style={{
            display: 'block', fontSize: '.72rem', color: 'var(--muted)', marginBottom: '.35rem',
            fontFamily: 'var(--font-mono)', textTransform: 'uppercase', letterSpacing: '.1em',
          }}
        >
          Manager token
        </label>
        <input
          id="manager-token"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={token}
          onChange={e => setToken(e.target.value)}
          style={{ width: '100%', fontFamily: 'var(--font-mono)' }}
          placeholder="from MANAGER_TOKEN, or the manager's startup log"
        />

        <p style={{ fontSize: '.75rem', color: 'var(--muted)', margin: '.75rem 0 1rem' }}>
          Set <span className="mono">MANAGER_TOKEN</span> in docker-compose to choose it. Otherwise one
          is generated on first run and printed to the manager's log — <span className="mono">docker logs mod-manager</span>.
        </p>

        {error && <Message text={error} kind="error" />}

        <button className="btn-primary" type="submit" disabled={busy || !token.trim()} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
