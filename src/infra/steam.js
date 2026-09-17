// The Steam Workshop web API, and the cache in front of it.
//
// Two public endpoints, no API key. Everything is batched because a PZ server here tracks ~180
// items and Steam accepts them in one call; the title cache exists so opening the Mods tab does
// not re-ask for all of them on every page load.
//
// Nothing here reads or writes the filesystem, and nothing knows what a server is — these are
// Workshop ids in, Workshop facts out.

const https = require('https')
const querystring = require('querystring')

// --- Steam Workshop API ---
// Both endpoints below are public and need no API key.

// Titles (and file size) for arbitrary Workshop item IDs. Batched; Steam accepts many per call.
function steamFileDetails(ids, cb) {
  if (!ids.length) return cb(null, {})
  const form = { itemcount: ids.length }
  ids.forEach((id, i) => { form['publishedfileids[' + i + ']'] = id })
  const data = querystring.stringify(form)
  const req = https.request({
    hostname: 'api.steampowered.com',
    path: '/ISteamRemoteStorage/GetPublishedFileDetails/v1/',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
  }, r => {
    let out = ''
    r.on('data', c => out += c)
    r.on('end', () => {
      try {
        const files = (JSON.parse(out).response || {}).publishedfiledetails || []
        const map = {}
        for (const f of files) {
          if (f.publishedfileid) map[f.publishedfileid] = {
            title: f.title || '',
            fileSize: parseInt(f.file_size) || 0,
            // Steam's own last-updated stamp — the signal the auto-updater compares against.
            timeUpdated: parseInt(f.time_updated) || 0,
            // Workshop tags: "Vehicles", "Build 42", "Audio", "Multiplayer", ...
            tags: (f.tags || []).map(t => t.tag).filter(Boolean),
            ok: f.result === 1
          }
        }
        cb(null, map)
      } catch (e) { cb(e) }
    })
  })
  req.on('error', cb)
  req.write(data); req.end()
}

// Child item IDs for one or more collections. Returns { collectionId: [childIds] } and only
// includes entries that are genuinely collections (result 1 with children) — this is also how
// we detect that a "mod" ID is really a nested collection.
function steamCollectionDetails(ids, cb) {
  if (!ids.length) return cb(null, {})
  const form = { collectioncount: ids.length }
  ids.forEach((id, i) => { form['publishedfileids[' + i + ']'] = id })
  const data = querystring.stringify(form)
  const req = https.request({
    hostname: 'api.steampowered.com',
    path: '/ISteamRemoteStorage/GetCollectionDetails/v1/',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
  }, r => {
    let out = ''
    r.on('data', c => out += c)
    r.on('end', () => {
      try {
        const details = (JSON.parse(out).response || {}).collectiondetails || []
        const map = {}
        for (const c of details) {
          const kids = (c.children || []).map(k => k.publishedfileid)
          if (c.result === 1 && kids.length) map[c.publishedfileid] = kids
        }
        cb(null, map)
      } catch (e) { cb(e) }
    })
  })
  req.on('error', cb)
  req.write(data); req.end()
}

function getCollectionChildren(collectionId, cb) {
  steamCollectionDetails([collectionId], (err, map) => {
    if (err) return cb(err)
    const kids = map[collectionId]
    if (!kids) return cb(new Error('Not a collection, or collection is empty'))
    cb(null, kids)
  })
}

// Recursively resolves a collection to its leaf (non-collection) Workshop item IDs.
// A PZ collection frequently contains other collections — installing those IDs directly is
// what previously produced "mods" that were really collection stubs with no game content.
function resolveCollectionLeaves(collectionId, cb) {
  const leaves = new Set()
  const seen = new Set()
  const nested = []
  function walk(ids, depth, done) {
    const todo = ids.filter(id => !seen.has(id))
    todo.forEach(id => seen.add(id))
    if (!todo.length || depth > 4) return done()
    steamCollectionDetails(todo, (err, map) => {
      if (err) return done(err)
      const childIds = []
      for (const id of todo) {
        if (map[id]) { nested.push(id); childIds.push(...map[id]) }
        else leaves.add(id)
      }
      if (!childIds.length) return done()
      walk(childIds, depth + 1, done)
    })
  }
  steamCollectionDetails([collectionId], (err, map) => {
    if (err) return cb(err)
    const top = map[collectionId]
    if (!top) return cb(new Error('Not a collection, or collection is empty'))
    seen.add(collectionId)
    walk(top, 1, (e) => e ? cb(e) : cb(null, Array.from(leaves), nested))
  })
}

// --- Workshop title cache (avoids re-hitting Steam on every page load) ---
const titleCache = {} // id -> { title, at }
const TITLE_TTL = 6 * 60 * 60 * 1000
// Workshop tags for an id, from the same cache getTitles() fills. Returns [] until that cache is
// warm, so callers must run this inside/after a getTitles() callback rather than standalone.
function getCachedTags(id) { return (titleCache[id] || {}).tags || [] }

function getTitles(ids, cb) {
  const now = Date.now()
  const missing = ids.filter(id => !titleCache[id] || now - titleCache[id].at > TITLE_TTL)
  const out = () => {
    const map = {}
    for (const id of ids) map[id] = (titleCache[id] || {}).title || ''
    cb(map)
  }
  if (!missing.length) return out()
  let pending = 0
  const chunks = []
  for (let i = 0; i < missing.length; i += 50) chunks.push(missing.slice(i, i + 50))
  pending = chunks.length
  for (const chunk of chunks) {
    steamFileDetails(chunk, (err, map) => {
      if (!err) for (const [id, d] of Object.entries(map)) titleCache[id] = { title: d.title, tags: d.tags || [], at: Date.now() }
      if (--pending <= 0) out()
    })
  }
}

// Steam stamps for every registered item, batched like getTitles does.
function fetchWorkshopTimes(ids, cb) {
  const out = {}
  if (!ids.length) return cb(out)
  const chunks = []
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50))
  let pending = chunks.length
  for (const chunk of chunks) {
    steamFileDetails(chunk, (err, map) => {
      if (!err) for (const [id, d] of Object.entries(map)) if (d.ok && d.timeUpdated) out[id] = d.timeUpdated
      if (--pending <= 0) cb(out)
    })
  }
}

module.exports = {
  steamFileDetails, steamCollectionDetails, getCollectionChildren, resolveCollectionLeaves,
  getTitles, getCachedTags, fetchWorkshopTimes, titleCache, TITLE_TTL,
}
