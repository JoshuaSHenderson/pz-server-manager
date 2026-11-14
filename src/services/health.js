// The two boot-time checks that answer "did this server actually come up correctly".
//
// They look similar and are deliberately separate, because they detect opposite failures:
//
//   reportDeadMods   mods that are enabled and never loaded. The server knows - it prints
//                    "loading <id>" per mod - so this reads the boot log. The disk cannot answer
//                    it, which is why thirteen entries sat dead in Mods= for weeks announcing
//                    nothing. See lib/modload.js.
//   reportModDrift   mods that load perfectly well here but no client can download. Nothing is
//                    wrong in the log at all; the first symptom is a player being told the mod
//                    "is not installed" with an empty WorkshopID and bouncing. See lib/moddrift.js.
//
// Both run once the readiness marker is up, so they surface before anyone tries to join.

const registry = require('../registry/servers')
const { getIniList } = require('../domain/ini')
const { modDriftReport } = require('../domain/inventory')
const { readNotifConfig, pushoverFor } = require('./notify')
const { reconcileMods } = require('../../lib/modload')
const docker = require('../infra/docker')
const { logFor } = require('../log')

/** @typedef {import('../paths').Server} Server */

const serverLabel = registry.serverLabel

// Enabled mods no client can download — see moddrift.js. Deliberately separate from
// reportDeadMods(): these load perfectly well on the server, so the boot log shows nothing wrong,
// and the first symptom is a player being told the mod "is not installed" with an empty
// WorkshopID. Checked at boot so it surfaces before someone tries to join, not after.
function reportModDrift(s) {
  let report
  try { report = modDriftReport(s) } catch (e) { return console.error('[drift]', e.message) }
  if (report.stale.length) {
    logFor(s, report.stale.length + ' local mod copy(ies) behind the Workshop: ' +
      report.stale.map(t => t.folder + ' ' + (t.local || 'none') + '->' + t.workshop).join(', '))
  }
  if (!report.issues.length) {
    console.log('[drift] ' + serverLabel(s) + ': all ' + report.ok.length + ' enabled mods are obtainable by clients')
    return
  }
  const list = report.issues.map(i => i.id + (i.suggest.length === 1 ? ' -> ' + i.suggest[0] : ' (' + i.kind + ')')).join(', ')
  logFor(s, 'clients cannot download ' + report.issues.length + ' enabled mod(s): ' + list)
  const cfg = readNotifConfig()
  if (cfg.enabled && cfg.events && cfg.events.modDrift !== false) {
    pushoverFor(s, 'PZ Mods Unobtainable',
      report.issues.length + ' enabled mod(s) cannot be downloaded by players: ' + list)
  }
}

// Mods that are enabled but never registered — see modload.js for why the disk cannot answer this
// and the boot log can. Runs once the ready marker is up, because by then the mod phase is over and
// the log is complete for this run.
//
// An empty result means "no information" to reconcileMods, not "every mod is dead", so a failed or
// truncated read stays silent instead of paging. That was true of `grep`'s exit 1 and stays true of
// filtering the text: both hand back nothing.
function reportDeadMods(s, since) {
  docker.logsContaining(s.container, ['--since', since], '> loading ',
    { maxBuffer: 8 * docker.MB }, (err, lines) => {
      const r = reconcileMods(getIniList(s, 'Mods'), lines.join('\n'))
      if (!r.known) return
      if (!r.dead.length) {
        console.log('[mods] ' + serverLabel(s) + ': all ' + r.loaded.length + ' enabled mods loaded')
        return
      }
      const list = r.dead.join(', ')
      logFor(s, 'enabled but did not load: ' + list)
      const cfg = readNotifConfig()
      if (cfg.enabled && cfg.events && cfg.events.modsNotLoaded !== false) {
        pushoverFor(s, 'PZ Mods Not Loaded',
          r.dead.length + ' enabled mod' + (r.dead.length > 1 ? 's' : '') + ' did not load: ' + list)
      }
    })
}

module.exports = { reportModDrift, reportDeadMods }
