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
 * Runs a command with an argument array — never a shell string.
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeout
 * @param {(err: Error|null, stdout: string, stderr: string) => void} cb
 */
function run(cmd, args, timeout, cb) {
  let out = ''
  let err = ''
  let done = false
  const finish = (/** @type {Error|null} */ e) => {
    if (done) return
    done = true
    cb(e, out, err)
  }
  const child = spawn(cmd, args, { timeout })
  child.stdout.on('data', d => { if (out.length < 1_000_000) out += d.toString() })
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
    return run('tar', ['-tzf', file], 30000, (e, out, errOut) => {
      if (e) return cb(e, [], errOut)
      cb(null, out.split('\n').map(l => l.trim()).filter(Boolean), out)
    })
  }
  // `unzip -Z1` prints one member name per line and nothing else. Plain `-l` wraps the names in a
  // table that has to be re-parsed, and busybox's table format is not the same as Info-ZIP's.
  run('unzip', ['-Z1', file], 30000, (e, out, errOut) => {
    if (e) return cb(e, [], errOut)
    cb(null, out.split('\n').map(l => l.trim()).filter(Boolean), out)
  })
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
    const args = tar ? ['-xzf', file, '-C', dest] : ['-o', file, '-d', dest]
    run(cmd, args, 300000, (e, _out, errOut) => {
      if (e) return cb(new Error(e.message + (errOut ? ': ' + errOut.trim().slice(0, 500) : '')))
      cb(null, { members: names.length })
    })
  })
}

module.exports = { unsafeMembers, listMembers, extractInto, kindOf, MAX_UPLOAD_BYTES }
