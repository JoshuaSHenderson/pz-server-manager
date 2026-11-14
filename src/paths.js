// Every path this manager reads or writes for one server, derived from that server's three
// mounts: s.data (/pz-data), s.workshop (/workshop) and s.install (/pz-install, optional).
//
// Gathered in one file on purpose. Nine of these were declared next to the feature that used them,
// several hundred lines apart, so "which files on disk does this manager own" could only be
// answered by grepping for `s.data +`. It is also the list you need when moving a server, backing
// one up, or working out what a wiped volume loses.
//
// Nothing here touches the filesystem — they are string builders, which is why they need no tests.

/**
 * A managed server, as resolved by src/registry/servers.js.
 * @typedef {{ id: string, container: string, data: string, workshop: string, install?: string|null,
 *             name?: string, state?: string }} Server
 */

// Per-server derived paths
function iniPath(s)   { return s.data + '/Server/servertest.ini' }
function modsDir(s)   { return s.data + '/mods' }
function dbPath(s)    { return s.data + '/db/servertest.db' }
function logDir(s)    { return s.data + '/Logs' }
function schedPath(s) { return s.data + '/schedule.json' }
function workshopContent(s) { return s.workshop + '/content/108600' }
// The only tree the game actually loads from — SteamCMD's force_install_dir. The manager needs it
// mounted read-write to purge an item while the server is down; `docker exec` can't reach a
// stopped container. Null when unmounted: everything else still works, reinstall refuses.
function installContent(s) { return s.install ? s.install + '/steamapps/workshop/content/108600' : null }
function backupDirs(s) {
  return {
    startup: s.data + '/backups/startup',
    version: s.data + '/backups/version',
    manual:  s.data + '/backups/manual',
  }
}

function sandboxPath(s) { return s.data + '/Server/servertest_SandboxVars.lua' }

function autoSyncPath(s) { return s.data + '/collection-autosync.json' }

function autoUpdatePath(s) { return s.data + '/mod-autoupdate.json' }

function depIgnorePath(s) { return s.data + '/dependency-ignores.json' }

function modOrderBackupDir(s) { return s.data + '/backups/mod-order' }

function reinstallDir(s) { return s.data + '/backups/mod-reinstall' }

function excludesPath(s) { return s.data + '/mod-excludes.json' }

function queuePath(s) { return s.data + '/download-queue.json' }

function collectionsPath(s) { return s.data + '/collections.json' }

module.exports = {
  iniPath, modsDir, dbPath, logDir, schedPath, workshopContent, installContent, backupDirs,
  collectionsPath, queuePath, excludesPath, reinstallDir, modOrderBackupDir, depIgnorePath,
  autoUpdatePath, autoSyncPath, sandboxPath,
}
