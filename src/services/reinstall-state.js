// The in-flight reinstall, and the two questions everyone else asks about it.
//
// Split out from the reinstall flow itself to break a genuine cycle: the reinstall needs
// registerInstalledMod() from the downloads service, and the downloads service must not do its
// bookkeeping while a reinstall owns the ini — so each would have to import the other.
//
// The distinction between the two predicates matters and is easy to get backwards:
//
//   busy()           a reinstall is running at all. Refuses a second one.
//   holdsContainer() the downtime window only, from the stop to the start. During the download
//                    phase the server is still up and reconcileDownloads() must keep running to do
//                    its bookkeeping; during the swap phase it must not, because the swap needs
//                    sole ownership of servertest.ini and of <data>/mods.
//
// One reinstall per server at a time. Keyed by server id, never global: two managed servers can
// legitimately be reinstalling different items at once.

/**
 * Progress for one server's reinstall. Fields after `quarantine` are set only by the outcomes that
 * produce them, and the UI branches on which are present.
 *
 * @typedef {{
 *   workshopId: string, step: string, startedAt: string, finishedAt: string|null,
 *   ok: boolean, error: string|null, quarantine: string|null,
 *   holdsContainer?: boolean, addedModIds?: string[], rolledBack?: boolean, strandedDown?: boolean
 * }} ReinstallState
 */

/** @type {Record<string, ReinstallState>} */
const REINSTALL = {}

// How many quarantined copies of previous reinstalls to keep. They are the undo for a reinstall
// that produced a worse mod than it replaced, and they are full copies, so this is a disk budget.
const QUARANTINE_KEEP = 3

// SteamCMD is slow on large items and the reinstall waits for it with the server still up. Long
// enough for a multi-gigabyte item on a slow link; short enough that a wedged download does not
// hold the flow open forever.
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

/** @param {import('../paths').Server} s */
function get(s) { return REINSTALL[s.id] || null }

/** @param {import('../paths').Server} s @param {ReinstallState} state */
function set(s, state) { REINSTALL[s.id] = state; return state }

/**
 * A reinstall is running for this server.
 * @param {import('../paths').Server} s
 */
function busy(s) {
  const r = REINSTALL[s.id]
  return !!(r && !r.finishedAt)
}

/**
 * The reinstall currently owns the container and the ini — the downtime window only.
 * @param {import('../paths').Server} s
 */
function holdsContainer(s) {
  const r = REINSTALL[s.id]
  return !!(r && !r.finishedAt && r.holdsContainer)
}

module.exports = { get, set, busy, holdsContainer, QUARANTINE_KEEP, DOWNLOAD_TIMEOUT_MS }
