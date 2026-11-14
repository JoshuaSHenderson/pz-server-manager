// Reading and extracting backup archives.
//
// Three problems with how this used to work, all in one place:
//
//   1. The archive was extracted without ever looking inside it. A member named `../../etc/thing`
//      or `/etc/thing` writes outside the server's data directory. GNU tar refuses `..` members,
//      busybox tar and busybox unzip — which is what the alpine image actually ships — do not, so
//      "tar is safe by default" was never true here.
//   2. The path was interpolated into a shell string. Backup names are constrained, but the whole
//      class goes away by not using a shell at all.
//   3. The upload endpoint had no size limit, so a single request could fill the volume the game
//      server is writing its world to.
//
// Member validation is pure and tested (archive.test.js) because it is the thing standing between
// an uploaded file and the rest of the filesystem.

const { spawn } = require('child_process')
const path = require('path')

// Enough for a world save plus config. Large, but bounded — the point is that it is not infinite.
const MAX_UPLOAD_BYTES = Number(process.env.MAX_BACKUP_UPLOAD_BYTES || 4 * 1024 * 1024 * 1024)

/**
 * Members that would write outside the extraction directory.
 *
 * Rejected: absolute paths, Windows drive letters, any `..` segment, and anything with a
 * backslash (a member named `..\x` is a parent reference on the machine an operator may later
 * unpack it on, and nothing legitimate in a PZ backup contains one).
 *
 * @param {string[]} names
 * @returns {string[]} the offending names, empty when the archive is safe
 */
function unsafeMembers(names) {
  return (names || []).filter(raw => {
    const name = String(raw || '').trim()
    if (!name) return false
    if (name.startsWith('/') || name.startsWith('\\')) return true
    if (/^[A-Za-z]:/.test(name)) return true
    if (name.includes('\\')) return true
    return name.split('/').includes('..')
  })
}

/** @param {string} file @returns {'tar.gz'|'zip'} */
function kindOf(file) {
  return /\.tar\.gz$|\.tgz$/i.test(String(file)) ? 'tar.gz' : 'zip'
}

/**
 * Member names from `unzip -lq` output. The image ships busybox unzip, which has no `-Z1`; its
 * `-l` table matches Info-ZIP's (length, MM-DD-YYYY, HH:MM, name), so this parses either. The
 * header, separator and totals rows don't match the date pattern and drop out.
 * @param {string} out
 * @returns {string[]}
 */
function parseZipListing(out) {
  const names = []
  for (const line of String(out).split('\n')) {
    const m = /^\s*\d+\s+\d{2}-\d{2}-\d{4}\s+\d{2}:\d{2}\s+(.+?)\r?$/.exec(line)
    if (m) names.push(m[1])
  }
  return names
}

/**
 * Runs a command with an argument array — never a shell string.
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeout
 * @param {(err: Error|null, stdout: string, stderr: string) => void} cb
 * @param {number} [maxOut] stdout kept; a listing must keep all of it, or members go unchecked
 */
function run(cmd, args, timeout, cb, maxOut = 1_000_000) {
  let out = ''
  let err = ''
  let done = false
  const finish = (/** @type {Error|null} */ e) => {
    if (done) return
    done = true
    cb(e, out, err)
  }
  const child = spawn(cmd, args, { timeout })
  child.stdout.on('data', d => { if (out.length < maxOut) out += d.toString() })
  child.stderr.on('data', d => { if (err.length < 100_000) err += d.toString() })
  child.on('error', finish)
  child.on('close', code => finish(code === 0 ? null : new Error(cmd + ' exited with code ' + code)))
}

/**
 * Member names inside an archive.
 * @param {string} file
 * @param {(err: Error|null, names: string[], raw: string) => void} cb
 */
function listMembers(file, cb) {
  if (kindOf(file) === 'tar.gz') {
    return run('tar', ['-tzf', file], 120000, (e, out, errOut) => {
      if (e) return cb(e, [], errOut)
      cb(null, out.split('\n').map(l => l.trim()).filter(Boolean), out)
    }, Infinity)
  }
  // A real world save is ~520k members (~40 MB of listing), hence no stdout cap.
  run('unzip', ['-lq', file], 120000, (e, out, errOut) => {
    if (e) return cb(e, [], errOut)
    cb(null, parseZipListing(out), out)
  }, Infinity)
}

/**
 * Validates every member, then extracts into destDir. Refuses the whole archive if any single
 * member would escape — a partial extraction of a hostile archive is still a compromised one.
 *
 * @param {string} file
 * @param {string} destDir
 * @param {(err: Error|null, info?: { members: number }) => void} cb
 */
function extractInto(file, destDir, cb) {
  listMembers(file, (err, names) => {
    if (err) return cb(err)
    if (!names.length) return cb(new Error('Archive is empty or unreadable'))

    const bad = unsafeMembers(names)
    if (bad.length) {
      return cb(new Error(
        'Refusing to extract: ' + bad.length + ' entr' + (bad.length === 1 ? 'y' : 'ies') +
        ' would be written outside ' + destDir + ' — ' + bad.slice(0, 5).join(', ') +
        (bad.length > 5 ? ', ...' : '')
      ))
    }

    const dest = destDir.endsWith(path.sep) || destDir.endsWith('/') ? destDir : destDir + '/'
    const tar = kindOf(file) === 'tar.gz'
    const cmd = tar ? 'tar' : 'unzip'
    const args = tar ? ['-xzf', file, '-C', dest] : ['-oq', file, '-d', dest]
    run(cmd, args, 300000, (e, _out, errOut) => {
      if (e) return cb(new Error(e.message + (errOut ? ': ' + errOut.trim().slice(0, 500) : '')))
      cb(null, { members: names.length })
    })
  })
}

module.exports = { unsafeMembers, listMembers, extractInto, kindOf, parseZipListing, MAX_UPLOAD_BYTES }
