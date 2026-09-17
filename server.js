// PZ Server Manager — wiring only.
//
// Everything this file used to do lives under src/:
//   src/routes/      one router per subject; they may use services and domain, never child_process
//   src/services/    the stateful work — downloads, reinstall, notifications, the monitors' bodies
//   src/domain/      what a mod.info means, what Mods= means, what a sandbox file means
//   src/infra/       docker, sqlite, steam, rcon, disk, net — the only files that touch the outside
//   src/registry/    which servers exist and which one a request is about
//   lib/             pure decision logic, unit-tested, no I/O at all
//
// Registration order below is load-bearing in two places, both marked.

const express = require('express')
const auth = require('./src/auth')
const registry = require('./src/registry/servers')
const monitors = require('./src/monitors')
const { installErrorHandler, installProcessGuards } = require('./src/http')
const { applyStartupFixes } = require('./src/startup')
const { logFor } = require('./src/log')
const { getIniList } = require('./src/domain/ini')
const { readAutoUpdate } = require('./src/services/autoupdate')
const { readAutoSync } = require('./src/services/collection-sync')
const { readCollections } = require('./src/services/collections')
const { readNotifConfig } = require('./src/services/notify')

installProcessGuards()

const app = express()
app.use(express.json())

// The built SPA, served before authentication so the login form can load at all. It carries no
// secrets — every byte of state it renders comes from an /api call that is authenticated.
// WEB_DIST exists so a dev build can be pointed somewhere else while iterating.
const WEB_DIST = process.env.WEB_DIST || 'dist'
app.use(express.static(WEB_DIST))

// ORDER MATTERS (1): Express runs middleware in registration order, so anything registered above
// this line is reachable without a token. Everything below it is not.
const MANAGER_AUTH = auth.install(app)

// One scan before anything is served, so the first request does not race the first refresh.
registry.refreshServers()
applyStartupFixes(registry.all())

// Rejects a ?server= that does not resolve, rather than silently acting on a different server.
app.use('/api', registry.guard)

// ORDER MATTERS (2): `mods` carries DELETE /api/mods/:workshopId, which matches "excludes",
// "order", "drift", "autoupdate" and "reinstall" as if they were Workshop ids. Every router with a
// literal path under /api/mods is therefore mounted before it. The rest are in no particular order.
for (const name of [
  'servers', 'control', 'logs', 'players',
  'excludes', 'order', 'drift', 'autoupdate', 'reinstall', 'mods',
  'audit', 'dependencies', 'alerts', 'collections',
  'config', 'sandbox', 'system', 'downloads', 'notifications', 'schedule', 'backups',
]) {
  app.use(require('./src/routes/' + name))
}

// Registered after every route, because Express only reaches an error handler for what was
// registered before it.
installErrorHandler(app)

// Started only once the routes above are mounted: several monitors restart containers, and the
// first tick should not land while the API is still half-wired.
monitors.start()

// 7777 is the port *inside* the container; docker-compose publishes it on the host (7778 in the
// reference compose). Nothing in here can see the host-side mapping, so say which one this is
// rather than printing a bare port that doesn't match the URL people actually use.
app.listen(7777, () => {
  const all = registry.all()
  console.log(
    'PZ Server Manager listening on container port 7777 (published to the host by docker-compose) — servers: ' +
    (all.map(s => s.id + ' "' + registry.serverLabel(s) + '"').join(', ') || 'none found')
  )

  // The operator needs the token to get in, and on a first run `docker logs` is the only place it
  // exists. An operator-set MANAGER_TOKEN is never echoed — they already have it, and printing it
  // would copy a secret they chose deliberately into the log stream the UI displays.
  if (MANAGER_AUTH.source === 'env') {
    logFor(null, 'auth: using MANAGER_TOKEN from the environment')
  } else {
    logFor(null, 'auth: manager token is ' + MANAGER_AUTH.token +
      (MANAGER_AUTH.source === 'file' ? ' (from /pz-data/manager-token)' : ' (generated — set MANAGER_TOKEN to pin it)'))
  }

  // A startup summary, so the Manager Logs pane opens with the state the manager is working from
  // rather than a bare "listening" line and then silence until something happens.
  for (const s of all) {
    try {
      logFor(s, 'container=' + s.container + ' data=' + s.data + ' workshop=' + s.workshop + ' state=' + (s.state || 'unknown'))
      logFor(s, getIniList(s, 'WorkshopItems').length + ' Workshop item(s) registered, ' +
        getIniList(s, 'Mods').length + ' mod(s) in load order')
      const au = readAutoUpdate(s)
      logFor(s, 'mod auto-update ' + (au.enabled ? 'ON (hourly, restart-when-empty ' + (au.restartWhenEmpty ? 'on' : 'off') + ')' : 'off'))
      const as = readAutoSync(s)
      logFor(s, 'collection auto-sync ' + (as.enabled ? 'ON every ' + as.intervalHours + 'h' : 'off') +
        ' · ' + readCollections(s).length + ' collection(s) tracked')
    } catch (e) { logFor(s, 'startup summary unavailable: ' + e.message) }
  }

  const n = readNotifConfig()
  logFor(null, 'notifications ' + (n.enabled ? 'ON' : 'off') +
    ' · Discord status ' + ((n.discord && n.discord.enabled) ? 'ON' : 'off'))
  logFor(null, 'monitors: ' + monitors.CADENCES)
})
