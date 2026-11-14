// Disk space and directory sizes.
//
// Both were shell one-liners: `df -hP /workshop | tail -1` parsed back out of a human-formatted
// table, and `du -sb <path>` with the path interpolated into a command string. The df parse also
// silently reported 0 for any unit it did not recognise, which on a petabyte-scale or
// kilobyte-scale line meant the low-disk alert quietly stopped working.

const { execFile, execFileSync } = require('child_process')
const fs = require('fs')

/**
 * Bytes available on the filesystem holding `p`.
 *
 * statfs is the same number df prints, without a table to parse or a unit suffix to interpret.
 * @param {string} p
 * @returns {number} 0 when the path cannot be stat'd
 */
function freeBytes(p) {
  try {
    const st = fs.statfsSync(p)
    return st.bavail * st.bsize
  } catch { return 0 }
}

/**
 * Total bytes on the filesystem holding `p`.
 * @param {string} p
 */
function totalBytes(p) {
  try {
    const st = fs.statfsSync(p)
    return st.blocks * st.bsize
  } catch { return 0 }
}

/**
 * Size of a directory tree, in bytes.
 *
 * `du` is still the right tool — it is one syscall-heavy walk in C rather than tens of thousands of
 * round trips through Node — but the path is an argv element now, and the caller chooses whether to
 * block.
 *
 * @param {string} p
 * @returns {number} 0 when the path is missing or unreadable
 */
function dirSizeSync(p) {
  try {
    const out = execFileSync('du', ['-sb', p], { timeout: 20000, maxBuffer: 1024 * 1024 }).toString()
    return parseInt(out.split(/\s+/)[0], 10) || 0
  } catch { return 0 }
}

/**
 * The same measurement without blocking the event loop.
 *
 * The disk audit calls this once per orphaned item. Done synchronously, a server with a few large
 * abandoned mods stalled every other request — including the SSE log streams — for the length of
 * the whole walk.
 *
 * @param {string} p
 * @param {(bytes: number) => void} cb
 */
function dirSize(p, cb) {
  execFile('du', ['-sb', p], { timeout: 20000, maxBuffer: 1024 * 1024 }, (err, out) => {
    if (err) return cb(0)
    cb(parseInt(String(out).split(/\s+/)[0], 10) || 0)
  })
}

/**
 * Measures several paths concurrently and hands back a path -> bytes map.
 * @param {string[]} paths
 * @param {(sizes: Record<string, number>) => void} cb
 */
function dirSizes(paths, cb) {
  /** @type {Record<string, number>} */
  const out = {}
  let pending = paths.length
  if (!pending) return cb(out)
  for (const p of paths) {
    dirSize(p, bytes => {
      out[p] = bytes
      if (--pending === 0) cb(out)
    })
  }
}

/**
 * Human-readable bytes. Lives here because every caller of it is reporting one of the numbers
 * above. Formatting is unchanged from the original — "5.0 GB", not "5 GB" — because these strings
 * are what the UI prints and the point of this refactor is not to move them around.
 * @param {number} n
 */
function humanBytes(n) {
  if (!n || n < 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i]
}

/**
 * `df -hP <path>`, parsed into its columns.
 *
 * Kept because the dashboard prints df's own strings ("9.1G", "83%") and an operator recognises
 * them from a shell. Previously `df ... | tail -1` through a shell; the last line is picked out
 * here instead, and the header line is skipped rather than assumed away.
 *
 * @param {string} p
 * @param {(cols: { size: string, used: string, avail: string, pct: string }) => void} cb
 */
function df(p, cb) {
  const empty = { size: '—', used: '—', avail: '—', pct: '—' }
  execFile('df', ['-hP', p], { timeout: 10000 }, (err, out) => {
    if (err) return cb(empty)
    const lines = String(out).trim().split('\n').filter(Boolean)
    const last = lines[lines.length - 1]
    if (!last || lines.length < 2) return cb(empty)
    const cols = last.trim().split(/\s+/)
    cb({ size: cols[1] || '—', used: cols[2] || '—', avail: cols[3] || '—', pct: cols[4] || '—' })
  })
}

module.exports = { freeBytes, totalBytes, dirSizeSync, dirSize, dirSizes, humanBytes, df }
