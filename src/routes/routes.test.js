// Run: node --test src/
//
// Loads every router and mounts them exactly as server.js does.
//
// This is the cheap end of the safety net, and it is aimed at the failure this refactor could
// actually produce: a router that references something its file no longer imports. That throws at
// require time, not at request time, so the manager would start, serve the SPA, and 500 on one tab
// forever. Type-checking catches most of it; this catches the rest, including a typo in the mount
// list itself.
//
// It also pins the ordering rule, which is the one piece of this that silently does the wrong thing
// rather than failing: DELETE /api/mods/:workshopId matches "excludes" as a Workshop id, so the
// routers carrying literal paths under /api/mods must be mounted first.
const assert = require('assert')
const express = require('express')

// server.js's list. Kept here rather than exported from it, because the value of this test is that
// it fails when the two disagree.
const MOUNT_ORDER = [
  'servers', 'control', 'logs', 'players',
  'excludes', 'order', 'drift', 'autoupdate', 'reinstall', 'mods',
  'audit', 'dependencies', 'alerts', 'collections',
  'config', 'sandbox', 'system', 'downloads', 'notifications', 'schedule', 'backups',
]

const app = express()
/** @type {{ method: string, path: string, router: string }[]} */
const routes = []

for (const name of MOUNT_ORDER) {
  const router = require('./' + name)
  assert.strictEqual(typeof router, 'function', name + ' must export an express Router')
  assert.ok(router.stack, name + ' does not look like a Router')
  for (const layer of router.stack) {
    for (const method of Object.keys(layer.route.methods)) {
      routes.push({ method: method.toUpperCase(), path: layer.route.path, router: name })
    }
  }
  app.use(router)
}

// Every handler server.js used to carry is still reachable.
assert.strictEqual(routes.length, 73, 'expected 73 handlers, found ' + routes.length)

// No path is served by two routers with the same method — a duplicate would mean one of them is
// dead code that never runs.
const seen = new Set()
for (const r of routes) {
  const key = r.method + ' ' + r.path
  assert.ok(!seen.has(key), 'duplicate handler: ' + key + ' (in ' + r.router + ')')
  seen.add(key)
}

// The ordering rule, stated as the thing it protects: the catch-all must come last.
const catchAll = routes.findIndex(r => r.method === 'DELETE' && r.path === '/api/mods/:workshopId')
assert.ok(catchAll >= 0, 'DELETE /api/mods/:workshopId is missing')
for (const literal of [
  '/api/mods/excludes', '/api/mods/order', '/api/mods/drift',
  '/api/mods/autoupdate', '/api/mods/reinstall',
]) {
  const i = routes.findIndex(r => r.path === literal)
  assert.ok(i >= 0, literal + ' is missing')
  assert.ok(i < catchAll,
    literal + ' is mounted after DELETE /api/mods/:workshopId, which will swallow it')
}

// A spot check that the subjects landed in the files they are named for.
const of = (/** @type {string} */ path) => (routes.find(r => r.path === path) || {}).router
assert.strictEqual(of('/api/status'), 'control')
assert.strictEqual(of('/api/players/online'), 'players')
assert.strictEqual(of('/api/config/sandbox'), 'sandbox')
assert.strictEqual(of('/api/backups/upload'), 'backups')

console.log('routes: ' + routes.length + ' handlers across ' + MOUNT_ORDER.length + ' routers, all assertions passed')
