// The player whitelist, which lives in the game's own SQLite database.
//
// Queried through the sqlite3 CLI rather than a driver: the alpine image already has it, and
// adding a native module to a container that currently installs one dependency is a poor trade for
// two tables' worth of access.
//
// The CLI has no bind parameters outside its interactive `.parameter` mode, so values are still
// interpolated into SQL. That makes the input rules the whole defence, which is why they live here,
// next to the only code that can use them, instead of a thousand lines away from two of their three
// call sites. `ident()` and `literal()` are the only sanctioned ways to build a fragment.

const { execFileSync } = require('child_process')
const { dbPath } = require('../paths')

/** @typedef {import('../paths').Server} Server */

// PZ usernames are Steam display names as the game recorded them. The allowed set is deliberately
// narrower than what Steam permits — a name outside it simply cannot be managed from here, which is
// a better failure than an unquoted apostrophe reaching the database.
const USERNAME_RE = /^[\w. -]{1,50}$/

const ACCESS_LEVELS = ['none', 'observer', 'gm', 'overseer', 'moderator', 'admin']

// B42 replaced the flat admin/moderator/banned/accesslevel columns with a role table.
const B42_ROLE = { none: 2, user: 2, observer: 4, gm: 5, overseer: 5, moderator: 6, admin: 7, banned: 1 }

/** @param {unknown} u */
function validUsername(u) { return typeof u === 'string' && USERNAME_RE.test(u) }

/**
 * A string literal for SQL. Doubling the quote is SQLite's own escape, and it is applied to every
 * value regardless of whether the caller already validated it — defence in depth is cheap here.
 * @param {string} v
 */
function literal(v) { return "'" + String(v).replace(/'/g, "''") + "'" }

/**
 * An integer literal. Anything that is not a finite integer is a programming error, not a value.
 * @param {number} n
 */
function int(n) {
  if (!Number.isInteger(n)) throw new Error('Expected an integer, got ' + JSON.stringify(n))
  return String(n)
}

/**
 * Rows for a SELECT. Returns [] on any failure — a missing database (a server that has never
 * booted) is an ordinary state here, not an error worth propagating.
 *
 * @param {Server} s
 * @param {string} sql
 * @returns {any[]}
 */
function all(s, sql) {
  try {
    // Argument array, so the database path and the SQL are never parsed by a shell.
    const out = execFileSync('sqlite3', ['-json', dbPath(s), sql], { maxBuffer: 16 * 1024 * 1024 })
    return JSON.parse(out.toString().trim() || '[]')
  } catch { return [] }
}

/**
 * A statement that changes something. Deliberately allowed to throw: a failed write must reach the
 * caller so the API can answer 500 rather than claiming success.
 * @param {Server} s
 * @param {string} sql
 */
function run(s, sql) {
  execFileSync('sqlite3', [dbPath(s), sql], { maxBuffer: 4 * 1024 * 1024 })
}

/** @param {Server} s */
function isB42(s) {
  return all(s, "SELECT 1 FROM pragma_table_info('whitelist') WHERE name='role'").length > 0
}

module.exports = { all, run, isB42, validUsername, literal, int, ACCESS_LEVELS, B42_ROLE, USERNAME_RE }
