// The operator-visible activity log.
//
// Anything this manager does that changes state gets a line here, so the Manager Logs pane answers
// "what did it just do?" without anyone reading the source. That pane is the primary diagnostic:
// when a mod fails to install, the reason is almost always in this stream rather than in the game
// server's own log.
//
// No timestamps — the log is read through `docker logs --timestamps`, which adds them. Printing
// our own would double them up.

const registry = require('./registry/servers')

/** @typedef {import('./paths').Server} Server */

/**
 * @param {Server|null} s the server this line is about, or null for the manager itself
 * @param {string} msg
 */
function logFor(s, msg) {
  console.log('[' + (s ? registry.serverLabel(s) : 'manager') + '] ' + msg)
}

module.exports = { logFor }
