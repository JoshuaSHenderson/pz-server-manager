// The scheduled-restart configuration, and the arithmetic behind "next restart in".
//
// Two modes: daily at a given hour:minute, or every N hours at :minute anchored so the configured
// hour is one of the occurrences (hour=4, N=6 gives 04:00, 10:00, 16:00, 22:00). The anchoring is
// the part worth having written down - without it "every 6 hours" would drift to wherever the
// manager happened to start.
//
// The clock this runs on is the container's, which is why the image installs tzdata: alpine ships
// no zone database, so TZ=America/New_York would otherwise stay silently on UTC and every
// scheduled restart would fire at the wrong time.

const { schedPath } = require('../paths')
const { readJson, writeJson } = require('../util/fsx')

/** @typedef {import('../paths').Server} Server */

const INTERVAL_CHOICES = [2, 6, 12, 24]

const DEFAULT_SCHEDULE = { enabled: false, mode: 'daily', hour: 4, minute: 0, intervalHours: 24 }

/** @param {Server} s */
function readSchedule(s) {
  const saved = readJson(schedPath(s), null)
  if (!saved) return Object.assign({}, DEFAULT_SCHEDULE)
  // Only mode and intervalHours are defaulted over a saved file: a schedule written before those
  // fields existed is a daily one, and assuming enabled:false for it would silently switch off a
  // restart the operator had configured.
  return Object.assign({ mode: 'daily', intervalHours: 24 }, saved)
}

/** @param {Server} s @param {any} sched */
function writeSchedule(s, sched) { writeJson(schedPath(s), sched) }

// Minutes until the next scheduled restart occurrence.
// daily: once a day at hour:minute. interval: every N hours at :minute,
// anchored so hour is one of the occurrences (e.g. hour=4, N=6 → 4,10,16,22).
function minutesUntilRestart(sched, totalNow) {
  const m = parseInt(sched.minute) || 0
  if (sched.mode === 'interval') {
    const iv = INTERVAL_CHOICES.includes(parseInt(sched.intervalHours)) ? parseInt(sched.intervalHours) : 24
    const anchor = ((parseInt(sched.hour) || 0) % iv + iv) % iv
    let best = Infinity
    for (let h = anchor; h < 24; h += iv) {
      const d = ((h * 60 + m - totalNow) + 1440) % 1440
      if (d < best) best = d
    }
    return best
  }
  const target = ((parseInt(sched.hour) || 4) * 60 + m)
  return ((target - totalNow) + 1440) % 1440
}

module.exports = { readSchedule, writeSchedule, minutesUntilRestart, INTERVAL_CHOICES, DEFAULT_SCHEDULE }
