// This box's external address.
//
// Cached for fifteen minutes because a home WAN IP changes rarely and the Discord card asks for it
// every five. Failure is not an error worth propagating: the card simply omits the address.

const https = require('https')

// --- External IP detection (cached — this box's WAN IP rarely changes) ---
let externalIpCache = { ip: '', at: 0 }
const EXTERNAL_IP_TTL = 15 * 60 * 1000
function getExternalIp(cb) {
  if (externalIpCache.ip && Date.now() - externalIpCache.at < EXTERNAL_IP_TTL) return cb(externalIpCache.ip)
  const req = https.request({ hostname: 'api.ipify.org', path: '/', method: 'GET' }, r => {
    let out = ''
    r.on('data', c => out += c)
    r.on('end', () => {
      const ip = out.trim()
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) externalIpCache = { ip, at: Date.now() }
      cb(externalIpCache.ip)
    })
  })
  req.on('error', () => cb(externalIpCache.ip)) // fall back to last-known value on error
  req.end()
}

module.exports = { getExternalIp, EXTERNAL_IP_TTL }
