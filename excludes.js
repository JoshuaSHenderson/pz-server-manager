// Per-Workshop-item lists of mod folders that must never reach the server.
//
// A Workshop item may ship several mod folders, and some of them are actively harmful. Item
// 3722134990 (Guns of Marz) ships GunsOfMarzPreviousVersion alongside GunsOfMarz, and both
// mod.info files declare the same `id=MarzGuns`. PZ takes whichever it scans first, so the same
// server boots differently on consecutive starts — which is why a restart "needed" a second
// restart to come up right. That folder's AnimSet XML also refers to itself in lowercase, which
// resolves on Windows and throws FileNotFoundException on a Linux server.
//
// There is no upstream fix to wait for: Steam re-ships the folder on every download, so the
// exclusion has to be reapplied after each one rather than done by hand once.
//
// Shape on disk (/pz-data/mod-excludes.json): { "<workshopId>": ["<folder>", ...] }

// Folder names are matched against real directory names, so anything that could escape the mods
// directory or name a parent is rejected outright rather than sanitised into something else.
function validFolder(folder) {
  return typeof folder === 'string' && folder.length > 0 && folder.length <= 255 &&
    !/[\/\\]/.test(folder) && folder !== '.' && folder !== '..'
}

function validWorkshopId(id) {
  return typeof id === 'string' && /^\d+$/.test(id)
}

function excludedFolders(excludes, workshopId) {
  const list = (excludes || {})[workshopId]
  return Array.isArray(list) ? list.slice() : []
}

function isExcluded(excludes, workshopId, folder) {
  return excludedFolders(excludes, workshopId).includes(folder)
}

// Every {workshopId, folder} pair in the map, flattened — what applyExcludes() iterates.
function allExcludes(excludes) {
  const out = []
  for (const [workshopId, list] of Object.entries(excludes || {})) {
    if (!Array.isArray(list)) continue
    for (const folder of list) out.push({ workshopId, folder })
  }
  return out
}

// Both mutators return a new map and never mutate the argument, so a rejected write can't leave
// the in-memory copy half-updated.
function addExclude(excludes, workshopId, folder) {
  if (!validWorkshopId(workshopId)) throw new Error('Invalid workshopId')
  if (!validFolder(folder)) throw new Error('Invalid folder name')
  const next = Object.assign({}, excludes)
  const list = excludedFolders(next, workshopId)
  if (!list.includes(folder)) list.push(folder)
  next[workshopId] = list
  return next
}

function removeExclude(excludes, workshopId, folder) {
  const next = Object.assign({}, excludes)
  const list = excludedFolders(next, workshopId).filter(f => f !== folder)
  // Drop the key entirely when its last folder goes, so the file doesn't fill with empty arrays.
  if (list.length) next[workshopId] = list
  else delete next[workshopId]
  return next
}

// Where one exclusion is allowed to delete from. Split out from the filesystem work because this
// is the rule that decides whether a mod survives: the per-item trees are ours to delete outright,
// but <data>/mods is a single flat directory shared by every item, so a folder name another
// installed item also ships must be left alone there. Deleting it would take that other mod's
// only copy with it, and a server that boots without a mod deletes that mod's items from the save.
//
// Returns descriptors rather than paths so the caller keeps ownership of path joining:
//   { root: 'item' } -> <installTree|workshopTree>/<workshopId>/mods/<folder>
//   { root: 'mods' } -> <data>/mods/<folder>
function removalTargets(workshopId, folder, otherProviders) {
  const targets = [{ root: 'item', parts: [workshopId, 'mods', folder] }]
  if (!(otherProviders || []).length) targets.push({ root: 'mods', parts: [folder] })
  return targets
}

module.exports = { excludedFolders, isExcluded, allExcludes, addExclude, removeExclude, removalTargets, validFolder, validWorkshopId }
