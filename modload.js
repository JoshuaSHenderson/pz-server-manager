// Checking Mods= against what the game actually loaded.
//
// The disk cannot answer this question, which is why missingProviders() did not catch any of it.
// A B42 mod folder carries one mod.info per version folder ("common", "42.0", "42.13"), and
// authors rename id= between them: SpongieCharacterCustomisation is SpnCharCustom in 42.0 and
// SPNCC in 42.13; Hot Brass is zHBVCEF at the root and HBVCEFb42 in 42.15. PZ registers the id
// from the highest version folder that is not newer than the running build, so an ini entry
// naming any of the other copies is dead — the mod is installed, the folder is there, the id is
// real somewhere in the tree, and nothing loads. findModInfo() returns the first mod.info it
// happens to see, so it reports one of those other copies and the entry passes every check.
//
// A B41-only mod fails the same way from the other direction: a flat folder with no version
// subfolder at all is simply skipped by a B42 server, with no error.
//
// Both were live on this server: thirteen entries sat dead in Mods= across every restart for
// weeks, announcing nothing. The only component that knows the truth is the game, which prints
// "loading <id>." for each mod it registers. So read that instead of guessing.

// The same event reaches us in two shapes, and only one of them has the trailing period:
//
//   Logs/<date>_DebugLog-server.txt   [12-09-26 02:12:47.953] LOG  : Mod  f:0 st:454,760,170> loading CVI.
//   docker logs zomboid                                       LOG  : Mod  f:0 st:907,558,156> loading CVI
//
// The file writer stamps each line and appends "." to it; the container's stdout does neither.
// Requiring the period matched the file and silently matched nothing from docker logs, which is
// the source reportDeadMods actually reads — so accept either and strip one period if it is there.
// Ids legitimately contain "." (Frockin Splendor! Vol.2), spaces, apostrophes and "!", so the
// capture has to be greedy and the period removed afterwards rather than excluded from the class.
const LOADING_RE = /\bLOG\s*:\s*Mod\b.*>\s*loading\s+(.+?)\s*$/

function loadedModIds(logText) {
  const ids = new Set()
  for (const line of String(logText || '').split('\n')) {
    const m = line.match(LOADING_RE)
    if (!m) continue
    const id = m[1].replace(/\.$/, '').trim()
    if (id) ids.add(id)
  }
  return ids
}

// enabled: the Mods= list. logText: this run's server log, from container start.
//
// known:false means the log cannot answer — it was truncated, the boot failed before the mod
// phase, or the wrong run was read. Callers must treat that as "no information" and stay quiet:
// reporting all 171 enabled mods as dead because a grep came back empty is the one failure this
// must never have.
function reconcileMods(enabled, logText) {
  const loaded = loadedModIds(logText)
  if (!loaded.size) return { known: false, loaded: [], dead: [], extra: [] }

  const want = []
  for (const raw of enabled || []) {
    const id = String(raw).trim()
    if (id && !want.includes(id)) want.push(id)
  }
  return {
    known: true,
    loaded: [...loaded],
    // Enabled and did not load. This is the alert.
    dead: want.filter(id => !loaded.has(id)),
    // Loaded without being listed — a dependency the game pulled in itself. Normal, reported
    // only so the two lists add up when someone reads the log.
    extra: [...loaded].filter(id => !want.includes(id)),
  }
}

module.exports = { reconcileMods, loadedModIds }
