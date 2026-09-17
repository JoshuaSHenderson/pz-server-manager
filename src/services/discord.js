// The Discord status card.
//
// One webhook message per manager, edited in place rather than reposted, so a channel does not
// fill with a new card every five minutes. Everything on it is auto-detected — the external IP,
// each server's running game version, its player count and its mod collections — because a card
// that has to be kept up to date by hand stops being true within a week.
//
// The edit is a PATCH to the stored message id. A 404 means someone deleted the message, which is
// recoverable: the id is cleared and the next pass posts a fresh one.

const https = require('https')
const registry = require('../registry/servers')
const { getIniList, getIniValue } = require('../domain/ini')
const { getTitles } = require('../infra/steam')
const { readCollections } = require('./collections')
const { readNotifConfig, writeNotifConfig } = require('./notify')
const { getExternalIp } = require('../infra/net')
const { getServerVersion } = require('./version')
const { onlinePlayersFor } = require('./playerlog')
const docker = require('../infra/docker')

/** @typedef {import('../paths').Server} Server */

const allServers = registry.all
const serverLabel = registry.serverLabel

// Workshop URLs for the collections a server tracks, so players can subscribe to the whole mod
// list in one click instead of being handed a list of ids.
function collectionUrls(s) {
  try {
    return readCollections(s).map(c => 'https://steamcommunity.com/sharedfiles/filedetails/?id=' + c.id)
  } catch { return [] }
}
// Markdown form for the rich embed, titled where a title is known.
function collectionLinks(s) {
  try {
    return readCollections(s)
      .map(c => '[' + (c.title || 'Server Collection') + '](https://steamcommunity.com/sharedfiles/filedetails/?id=' + c.id + ')')
      .join(' · ')
  } catch { return '' }
}

// --- Discord Status helpers ---
function discordRequest(method, urlPath, body, cb) {
  const data = body ? JSON.stringify(body) : null
  const opts = {
    hostname: 'discord.com', path: '/api/v10' + urlPath, method,
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'PZServerManager/1.0' }
  }
  if (data) opts.headers['Content-Length'] = Buffer.byteLength(data)
  const req = https.request(opts, r => {
    let out = ''
    r.on('data', c => out += c)
    r.on('end', () => { try { cb(null, JSON.parse(out), r.statusCode) } catch { cb(null, out, r.statusCode) } })
  })
  req.on('error', e => cb(e))
  if (data) req.write(data)
  req.end()
}

function parseWebhookUrl(url) {
  const m = (url || '').match(/webhooks\/(\d+)\/([^/?#\s]+)/)
  return m ? { id: m[1], token: m[2] } : null
}

function updateDiscordStatus(cb) {
  const cfg = readNotifConfig()
  if (!cfg.discord || !cfg.discord.enabled || !cfg.discord.webhookUrl) return cb && cb()
  const wh = parseWebhookUrl(cfg.discord.webhookUrl)
  if (!wh) return cb && cb()
  const servers = allServers()
  getExternalIp(externalIp => {
    docker.inspect(servers.map(x => x.container), '{{.Name}}|{{.State.Status}}|{{.State.StartedAt}}', (err, out) => {
      const states = {}
      for (const line of (out || '').trim().split('\n')) {
        const [name, status, startedAt] = line.replace(/^\//, '').split('|')
        states[name] = { status, startedAt }
      }

      let pending = servers.length || 1
      const versions = {}
      const done = () => sendCard(versions)
      if (!servers.length) return done()
      for (const s of servers) {
        getServerVersion(s, v => { versions[s.id] = v; if (--pending <= 0) done() })
      }

      function sendCard(versions) {
        // Discord accepts either `content` (plain) or `embeds` (rich card), and `avatar_url` is
        // added to whichever shape was built.
        /** @type {{ content?: string, embeds?: object[], avatar_url?: string }} */
        let body
        if (cfg.discord.richCard) {
          // One embed per server, its description a list of "**Key** : value" lines. Embed fields
          // were tried first but always render the name on its own line above the value.
          const embeds = []
          for (const s of servers) {
            const st = states[s.container] || {}
            const isOnline = st.status === 'running'
            let uptime = '—'
            if (isOnline && st.startedAt) {
              const ms = Date.now() - new Date(st.startedAt).getTime()
              const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000)
              uptime = h > 0 ? h + 'h ' + m + 'm' : m + 'm'
            }
            let modCount = '—', port = '', maxPlayers = ''
            try {
              modCount = String(getIniList(s, 'WorkshopItems').length)
              port = getIniValue(s, 'DefaultPort', '')
              maxPlayers = getIniValue(s, 'MaxPlayers', '')
            } catch {}
            const players = isOnline ? onlinePlayersFor(s) : []
            const version = versions[s.id]

            // "**Key** : value" on one line each. Embed fields put the name on its own line above
            // the value, which is what this replaces.
            const row = (k, v) => '**' + k + '** : ' + v
            const lines = [
              row('Status', isOnline ? '🟢 Online' : '🔴 Offline'),
              row('Players', players.length + (maxPlayers ? ' / ' + maxPlayers : '')),
              row('Uptime', isOnline ? uptime : '—'),
              row('Connect', (externalIp && port) ? '`' + externalIp + ':' + port + '`' : '—'),
              row('Mods', modCount),
              row('Version', version ? '`' + version + '`' : '—')
            ]
            if (players.length) {
              lines.push(row('Online now', players.slice(0, 20).join(', ') + (players.length > 20 ? ', …' : '')))
            }
            // Tracked collections, so people can subscribe to the server's mod list from Discord
            // rather than being sent a list of Workshop ids.
            const collLinks = collectionLinks(s)
            if (collLinks) lines.push(row('Mod Collection', collLinks))

            const embed = {
              title: serverLabel(s),
              color: isOnline ? 5763719 : 15548997,
              description: lines.join('\n')
            }
            // Discord fetches this URL itself, so it has to be reachable from the internet —
            // the manager's own /server-icon.png is LAN-only and would render broken.
            if (cfg.discord.iconUrl) embed.thumbnail = { url: cfg.discord.iconUrl }
            embeds.push(embed)
          }
          // Discord shows the timestamp under the last embed only, so it goes there.
          if (embeds.length) embeds[embeds.length - 1].timestamp = new Date().toISOString()
          body = { embeds: embeds.length ? embeds : [{ title: 'Project Zomboid Servers', description: 'No servers found.', color: 15548997 }] }
        } else {
          const stats = servers.map(s => {
            const isOnline = (states[s.container] || {}).status === 'running'
            const n = isOnline ? onlinePlayersFor(s).length : 0
            const version = versions[s.id]
            const coll = collectionUrls(s)[0]
            let port = '', maxPlayers = '', modCount = ''
            try {
              port = getIniValue(s, 'DefaultPort', '')
              maxPlayers = getIniValue(s, 'MaxPlayers', '')
              modCount = String(getIniList(s, 'WorkshopItems').length)
            } catch {}
            const bits = [serverLabel(s) + (version ? ' v' + version : '')]
            bits.push(isOnline ? '🟢 ' + n + (maxPlayers ? '/' + maxPlayers : '') + ' online' : '🔴 offline')
            if (externalIp && port) bits.push(externalIp + ':' + port)
            if (modCount) bits.push(modCount + ' mods')
            if (coll) bits.push('mods: ' + coll)
            return bits.join(' · ')
          }).join(' | ')
          const template = cfg.discord.template || 'Project Zomboid Server: <ZomboidServerStats>'
          const content = template
            .replace('<ZomboidServerStats>', stats)
            .replace('<LastUpdated>', new Date().toUTCString())
          body = { content }
        }
        // Webhook avatar. Only honoured when the message is first posted — Discord ignores
        // username/avatar_url on a PATCH — so an icon change shows up after the message is
        // recreated, not on the next edit.
        if (cfg.discord.iconUrl) body.avatar_url = cfg.discord.iconUrl

        const save = id => { cfg.discord.messageId = id; writeNotifConfig(cfg) }
        if (cfg.discord.messageId) {
          discordRequest('PATCH', '/webhooks/' + wh.id + '/' + wh.token + '/messages/' + cfg.discord.messageId, body, (e, data, status) => {
            if (status === 404) { save(''); updateDiscordStatus(cb) }
            else cb && cb(null, data)
          })
        } else {
          discordRequest('POST', '/webhooks/' + wh.id + '/' + wh.token + '?wait=true', body, (e, data, status) => {
            if (data && data.id) save(data.id)
            cb && cb(null, data)
          })
        }
      }
    })
  })
}

module.exports = { updateDiscordStatus, discordRequest, parseWebhookUrl, collectionUrls, collectionLinks }
