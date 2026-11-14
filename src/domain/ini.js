// Reading and writing servertest.ini.
//
// PZ's ini is a flat `Key=Value` file, and two of its keys — Mods= and WorkshopItems= — are
// semicolon-separated lists that most of this manager exists to edit. Everything that touches the
// file goes through here, so there is one definition of what a list is and one place that writes.
//
// Deliberately read-through rather than cached: the game rewrites this file itself (PublicName,
// and anything changed in-game), so a cached copy would hand back values the server is no longer
// running on, and a write from a stale cache would silently revert them.

const fs = require('fs')
const { iniPath } = require('../paths')

/** @typedef {import('../paths').Server} Server */

// --- INI helpers ---
function readIni(s) { return fs.readFileSync(iniPath(s), 'utf8') }
function getIniList(s, key) {
  const m = readIni(s).match(new RegExp(`^${key}=(.*)$`, 'm'))
  return m ? m[1].split(';').filter(Boolean) : []
}
function setIniList(s, key, values) {
  const ini = readIni(s).replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${values.join(';')}`)
  fs.writeFileSync(iniPath(s), ini)
}

// --- INI single-value helpers ---
function getIniValue(s, key, def) {
  const m = readIni(s).match(new RegExp('^' + key + '=(.*)$', 'm'))
  return m ? m[1].trim() : (def !== undefined ? def : '')
}
function setIniValue(s, key, value) {
  const ini = readIni(s)
  const re = new RegExp('^' + key + '=.*$', 'm')
  const line = key + "=" + value
  fs.writeFileSync(iniPath(s), re.test(ini) ? ini.replace(re, line) : ini + "\n" + line)
}

// Curated fields shown as dedicated controls in the UI; everything else the ini actually
// contains still round-trips through the "Advanced Options" section below (see getFullIni).
const CONFIG_FIELDS = [
  'PublicName','Password','MaxPlayers','PVP','SafetySystem','Open','Public',
  'PauseEmpty','GlobalChat','VoiceEnable','HoursForLootRespawn','SaveWorldEveryMinutes'
]

// Every key=value pair actually present in servertest.ini — lets the UI expose the full
// option set without this file needing to enumerate every possible PZ ini key up front.
function getFullIni(s) {
  const cfg = {}
  for (const line of readIni(s).split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m) cfg[m[1]] = m[2]
  }
  return cfg
}

const INI_KEY_RE = /^\w+$/

module.exports = {
  readIni, getIniList, setIniList, getIniValue, setIniValue, getFullIni,
  CONFIG_FIELDS, INI_KEY_RE,
}
