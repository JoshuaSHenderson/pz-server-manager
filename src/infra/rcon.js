// The RCON client: Source RCON framing over a TCP socket to the game server.
//
// Worth having in its own file because it is a wire protocol, not application logic, and because
// everything the manager does that the *game* has to know about goes through it — the in-game
// restart countdown, the connected-player count, and the pre-shutdown save that is the only reason
// a restart does not roll the world back to its last autosave (see lib/save.js).

const net = require('net')
const { getIniValue } = require('../domain/ini')

/** @typedef {import('../paths').Server} Server */

// ===== RCON =====

const AUTH_ID = 1
const CMD_ID = 2

function rconCommand(s, command, cb) {
  const pass = getIniValue(s, 'RCONPassword', '')
  const port = parseInt(getIniValue(s, 'RCONPort', '27015')) || 27015
  if (!pass) return cb && cb(new Error('RCON not configured'))

  const client = net.createConnection(port, s.container)
  let buf = Buffer.alloc(0)
  let authed = false
  let done = false
  let responseBody = ''

  const finish = (err) => {
    if (done) return
    done = true
    try { client.destroy() } catch {}
    if (cb) cb(err || null, responseBody)
  }

  const makePacket = (id, type, body) => {
    const bodyBuf = Buffer.from(body, 'utf8')
    const size = 4 + 4 + bodyBuf.length + 1 + 1
    const pkt = Buffer.alloc(4 + size)
    pkt.writeInt32LE(size, 0)
    pkt.writeInt32LE(id, 4)
    pkt.writeInt32LE(type, 8)
    bodyBuf.copy(pkt, 12)
    return pkt
  }

  client.setTimeout(5000, () => finish(new Error('RCON timeout')))
  client.on('error', finish)
  client.on('connect', () => client.write(makePacket(AUTH_ID, 3, pass)))
  client.on('data', (data) => {
    buf = Buffer.concat([buf, data])
    while (buf.length >= 12) {
      const size = buf.readInt32LE(0)
      if (buf.length < 4 + size) break
      const id = buf.readInt32LE(4)
      const type = buf.readInt32LE(8)
      const bodyLen = Math.max(0, size - 10)
      const pktBody = buf.slice(12, 12 + bodyLen).toString('utf8')
      buf = buf.slice(4 + size)
      // PZ answers an auth with an empty RESPONSE_VALUE (type 0) *before* the AUTH_RESPONSE
      // (type 2). Counting that first packet as the auth, and then the auth response as the
      // command's output, is why every command used to come back with an empty body — harmless
      // for servermsg, useless for anything whose answer we actually need.
      if (!authed) {
        if (type !== 2) continue
        if (id === -1) return finish(new Error('RCON auth failed'))
        authed = true
        client.write(makePacket(CMD_ID, 2, command))
        continue
      }
      // ponytail: first response packet wins. PZ splits replies over 4096 bytes, which `players`
      // would only reach at ~500 connected names; reassemble on the empty-packet sentinel if a
      // command that big ever needs reading.
      if (id === CMD_ID) {
        responseBody += pktBody
        finish(null)
      }
    }
  })
}

module.exports = { rconCommand, AUTH_ID, CMD_ID }
