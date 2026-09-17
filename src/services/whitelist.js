// The player whitelist: who may join, at what access level, and who is banned.
//
// Two schemas, because B42 replaced B41's flat admin/moderator/banned/accesslevel columns with a
// role table. Every function here picks the right one, so nothing above this layer has to know
// which build a given server is running — `isB42` is asked per call rather than cached, since one
// manager can front a B41 and a B42 server at once and a server can be upgraded under it.
//
// All SQL is built through db.literal()/db.int(). The sqlite3 CLI has no bind parameters outside
// its interactive mode, so those two functions are the only sanctioned way to get a value into a
// statement, and every caller validates before it reaches them anyway.

const db = require('../infra/db')

/** @typedef {import('../paths').Server} Server */

const B41_LIST =
  'SELECT username, accesslevel, admin, moderator, banned, lastConnection, displayName ' +
  'FROM whitelist ORDER BY lastConnection DESC'

// The same columns, reconstructed from the role table so the API shape does not change with the
// game build — the UI renders one row type either way.
const B42_LIST =
  "SELECT w.username, COALESCE(r.name,'user') AS accesslevel, " +
  "(COALESCE(r.name,'')='admin') AS admin, (COALESCE(r.name,'')='moderator') AS moderator, " +
  "(COALESCE(r.name,'')='banned') AS banned, w.lastConnection, w.displayName " +
  'FROM whitelist w LEFT JOIN role r ON r.id = w.role ORDER BY w.lastConnection DESC'

/**
 * @param {Server} s
 * @returns {any[]}
 */
function list(s) {
  return db.all(s, db.isB42(s) ? B42_LIST : B41_LIST)
}

/**
 * @param {Server} s
 * @param {string} username already validated by the caller
 * @param {string} accesslevel one of db.ACCESS_LEVELS
 */
function add(s, username, accesslevel) {
  const u = db.literal(username)
  if (db.isB42(s)) {
    return db.run(s, 'INSERT OR IGNORE INTO whitelist (username, role, world) VALUES (' +
      u + ', ' + db.int(db.B42_ROLE[accesslevel] || db.B42_ROLE.user) + ", 'servertest')")
  }
  db.run(s, 'INSERT OR IGNORE INTO whitelist (username, accesslevel, admin, moderator, banned, world) VALUES (' +
    u + ', ' + db.literal(accesslevel) + ', ' +
    db.int(accesslevel === 'admin' ? 1 : 0) + ', ' +
    db.int(accesslevel === 'moderator' ? 1 : 0) + ", 0, 'servertest')")
}

/**
 * Change an access level, a ban, or both.
 *
 * On B42 the two are the same field — a ban *is* a role — so setting an access level on a banned
 * player unbans them, and that is the game's own model, not a simplification made here.
 *
 * @param {Server} s
 * @param {string} username
 * @param {{ accesslevel?: string, banned?: boolean }} changes
 * @returns {{ ok: true }|{ ok: false, error: string }}
 */
function update(s, username, changes) {
  const { accesslevel, banned } = changes || {}
  if (accesslevel !== undefined && !db.ACCESS_LEVELS.includes(accesslevel)) {
    return { ok: false, error: 'Invalid accesslevel' }
  }
  const where = ' WHERE username=' + db.literal(username)

  if (db.isB42(s)) {
    let role
    if (banned !== undefined) role = banned ? db.B42_ROLE.banned : db.B42_ROLE.none
    if (accesslevel !== undefined) role = db.B42_ROLE[accesslevel] || db.B42_ROLE.none
    if (role === undefined) return { ok: false, error: 'Nothing to update' }
    db.run(s, 'UPDATE whitelist SET role=' + db.int(role) + where)
    return { ok: true }
  }

  const fields = []
  if (accesslevel !== undefined) {
    fields.push(
      'accesslevel=' + db.literal(accesslevel),
      'admin=' + db.int(accesslevel === 'admin' ? 1 : 0),
      'moderator=' + db.int(accesslevel === 'moderator' ? 1 : 0))
  }
  if (banned !== undefined) fields.push('banned=' + db.int(banned ? 1 : 0))
  if (!fields.length) return { ok: false, error: 'Nothing to update' }
  db.run(s, 'UPDATE whitelist SET ' + fields.join(', ') + where)
  return { ok: true }
}

/**
 * @param {Server} s
 * @param {string} username
 */
function remove(s, username) {
  db.run(s, 'DELETE FROM whitelist' + ' WHERE username=' + db.literal(username))
}

module.exports = { list, add, update, remove }
