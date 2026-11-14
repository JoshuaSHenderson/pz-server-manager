// The whitelist: who may join, at what access level, and who is banned.
//
// A player name comes from the game, not from this UI, so it is rendered as text and sent in a URL
// path segment — never spliced into anything that will be parsed. The old UI built an inline
// onclick per row and carried the name through it, which is why it needed a percent-encoding
// helper; React removes the category entirely.

import { useState } from 'react'
import { api } from '../../api/client'
import { useAction, useApi } from '../../api/hooks'
import type { Player, PlayersResponse } from '../../api/types'
import { Card } from '../../components/Card'
import { Empty, MessageSlot, PaneHead } from '../../components/ui'

const ACCESS_LEVELS = ['none', 'observer', 'gm', 'overseer', 'moderator', 'admin'] as const

export function Players() {
  const { data, loading, reload } = useApi<PlayersResponse>('/api/players')
  const action = useAction()
  const [username, setUsername] = useState('')
  const [accesslevel, setAccesslevel] = useState<string>('none')

  const players = data?.players ?? []
  const path = (u: string) => '/api/players/' + encodeURIComponent(u)

  const add = async () => {
    const name = username.trim()
    if (!name) return
    const ok = await action.run(
      () => api.post('/api/players', { username: name, accesslevel }),
      'Added ' + name + ' as ' + accesslevel + '.',
    )
    if (ok) { setUsername(''); reload() }
  }

  const setLevel = async (p: Player, level: string) => {
    await action.run(
      () => api.patch(path(p.username), { accesslevel: level }),
      p.username + ' access level set to ' + level + '.',
    )
    reload()
  }

  const setBanned = async (p: Player, banned: boolean) => {
    if (banned && !confirm('Ban ' + p.username + '?')) return
    await action.run(
      () => api.patch(path(p.username), { banned }),
      p.username + (banned ? ' banned.' : ' unbanned.'),
    )
    reload()
  }

  const remove = async (p: Player) => {
    if (!confirm('Remove ' + p.username + ' from whitelist?')) return
    await action.run(() => api.del(path(p.username)), p.username + ' removed.')
    reload()
  }

  return (
    <div className="tab-pane active">
      <PaneHead title="Players" subtitle="Whitelist, access levels, and bans" />
      <MessageSlot message={action.message} onClear={() => action.setMessage(null)} />

      <Card id="players-add" title="Add to Whitelist">
        <div className="row">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void add() }}
          />
          <select value={accesslevel} onChange={e => setAccesslevel(e.target.value)}>
            {ACCESS_LEVELS.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
          <button className="btn-primary" onClick={add} disabled={action.busy || !username.trim()}>Add</button>
        </div>
      </Card>

      <Card
        id="players-list"
        title="Players"
        aside={
          <span className="text-muted" style={{
            fontSize: '.8rem', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap', marginLeft: '1rem',
          }}>{players.length} accounts</span>
        }
      >
        <div style={{ marginTop: '1rem' }}>
          {loading ? <Empty>Loading...</Empty>
            : !players.length ? <Empty>No players</Empty>
              : (
                <table>
                  <thead>
                    <tr>
                      <th>Username</th><th>Access Level</th><th>Status</th><th>Last Seen</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {players.map(p => {
                      const level = p.accesslevel || 'none'
                      return (
                        <tr key={p.username}>
                          <td className="mono">
                            {p.username}
                            {p.displayName && p.displayName !== p.username && (
                              <><br /><span className="text-muted" style={{ fontSize: '.75rem' }}>{p.displayName}</span></>
                            )}
                          </td>
                          <td>
                            <select
                              className="access-sel"
                              value={level}
                              disabled={action.busy}
                              onChange={e => setLevel(p, e.target.value)}
                            >
                              {ACCESS_LEVELS.map(v => <option key={v} value={v}>{v}</option>)}
                            </select>
                          </td>
                          <td>
                            {p.banned
                              ? <span className="badge badge-banned">banned</span>
                              : <span className={'badge badge-' + level}>{level}</span>}
                          </td>
                          <td className="text-muted" style={{ fontSize: '.78rem' }}>
                            {p.lastConnection ? new Date(p.lastConnection).toLocaleString() : '—'}
                          </td>
                          <td>
                            <div className="actions">
                              {p.banned
                                ? <button className="btn-success btn-sm" disabled={action.busy} onClick={() => setBanned(p, false)}>Unban</button>
                                : <button className="btn-warn btn-sm" disabled={action.busy} onClick={() => setBanned(p, true)}>Ban</button>}
                              <button className="btn-danger btn-sm" disabled={action.busy} onClick={() => remove(p)}>Remove</button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
        </div>
      </Card>
    </div>
  )
}
