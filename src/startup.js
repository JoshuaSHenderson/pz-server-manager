// One-time fixes applied to each managed server when the manager boots.
//
// These exist because both settings are things an operator only discovers they needed after losing
// something. Neither takes effect until the game server's next restart, which is why they are
// applied at boot rather than offered as a button someone has to remember to press.
//
// A server whose data directory is not mounted yet is skipped rather than treated as an error: a
// container can legitimately exist before its volume has been provisioned.

const fs = require('fs')
const crypto = require('crypto')
const { iniPath, backupDirs } = require('./paths')
const { getIniValue, setIniValue } = require('./domain/ini')

/** @param {import('./paths').Server[]} servers */
function applyStartupFixes(servers) {
  for (const s of servers) {
    if (!fs.existsSync(iniPath(s))) {
      console.log('[startup] ' + s.name + ': no ini yet, skipping fixes')
      continue
    }

    try { fs.mkdirSync(backupDirs(s).manual, { recursive: true }) } catch {}

    // The game's own periodic backups. Raised, never lowered: an operator who has deliberately set
    // a longer period or a larger count keeps it.
    try {
      const period = parseInt(getIniValue(s, 'BackupsPeriod', '0')) || 0
      const count = parseInt(getIniValue(s, 'BackupsCount', '5')) || 5
      if (period < 60) setIniValue(s, 'BackupsPeriod', '60')
      if (count < 10) setIniValue(s, 'BackupsCount', '10')
    } catch (e) { console.error('[startup] ' + s.name + ' BackupsPeriod fix failed:', e.message) }

    // Without an RCON password this manager cannot ask the game to save before a restart, cannot
    // send the in-game countdown, and cannot ask how many players are connected — which is what
    // the auto-updater waits on. Generated rather than prompted for, because the alternative is a
    // manager that silently does none of those things.
    try {
      if (!getIniValue(s, 'RCONPassword', '')) {
        setIniValue(s, 'RCONPassword', crypto.randomBytes(12).toString('hex'))
        console.log('[RCON] ' + s.name + ': auto-set password. Restart PZ server to activate in-game warnings.')
      }
    } catch (e) { console.error('[startup] ' + s.name + ' RCON setup failed:', e.message) }
  }
}

module.exports = { applyStartupFixes }
