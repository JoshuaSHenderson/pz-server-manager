// Run: node test_excludes.js
const assert = require('assert')
const { excludedFolders, isExcluded, allExcludes, addExclude, removeExclude, removalTargets, validFolder, validWorkshopId } = require('./excludes')

const MARZ = { '3722134990': ['GunsOfMarzPreviousVersion'] }

// The live case: one item, one poisoned folder.
assert.deepStrictEqual(excludedFolders(MARZ, '3722134990'), ['GunsOfMarzPreviousVersion'])
assert.strictEqual(isExcluded(MARZ, '3722134990', 'GunsOfMarzPreviousVersion'), true)

// The sibling folder shipping the same mod id must NOT be swept up with it.
assert.strictEqual(isExcluded(MARZ, '3722134990', 'GunsOfMarz'), false)

// Unknown item, missing map, junk value -> empty, never a throw.
assert.deepStrictEqual(excludedFolders(MARZ, '9999'), [])
assert.deepStrictEqual(excludedFolders(null, '3722134990'), [])
assert.deepStrictEqual(excludedFolders({ '1': 'notanarray' }, '1'), [])

// The list applyExcludes() walks.
assert.deepStrictEqual(allExcludes(MARZ), [{ workshopId: '3722134990', folder: 'GunsOfMarzPreviousVersion' }])
assert.deepStrictEqual(allExcludes({}), [])
assert.deepStrictEqual(allExcludes({ '1': ['a', 'b'], '2': ['c'] }), [
  { workshopId: '1', folder: 'a' },
  { workshopId: '1', folder: 'b' },
  { workshopId: '2', folder: 'c' },
])

// Add is idempotent — re-excluding an already-excluded folder must not duplicate the entry,
// because applyExcludes() would then log the same removal twice on every restart.
assert.deepStrictEqual(addExclude(MARZ, '3722134990', 'GunsOfMarzPreviousVersion'), MARZ)
assert.deepStrictEqual(addExclude({}, '1', 'a'), { '1': ['a'] })
assert.deepStrictEqual(addExclude({ '1': ['a'] }, '1', 'b'), { '1': ['a', 'b'] })

// Neither mutator touches its argument: a rejected write can't leave the cached map half-updated.
const before = { '1': ['a'] }
addExclude(before, '1', 'b')
removeExclude(before, '1', 'a')
assert.deepStrictEqual(before, { '1': ['a'] })

// Removing the last folder drops the key rather than leaving an empty array behind.
assert.deepStrictEqual(removeExclude({ '1': ['a'] }, '1', 'a'), {})
assert.deepStrictEqual(removeExclude({ '1': ['a', 'b'] }, '1', 'a'), { '1': ['b'] })
// Removing something that was never there is a no-op, not an error.
assert.deepStrictEqual(removeExclude({ '1': ['a'] }, '1', 'zzz'), { '1': ['a'] })
assert.deepStrictEqual(removeExclude({}, '1', 'a'), {})

// Folder names become paths under the mods directory, so anything that could escape it is refused.
assert.strictEqual(validFolder('GunsOfMarz'), true)
assert.strictEqual(validFolder('a/b'), false)
assert.strictEqual(validFolder('a' + String.fromCharCode(92) + 'b'), false)
assert.strictEqual(validFolder('..'), false)
assert.strictEqual(validFolder('.'), false)
assert.strictEqual(validFolder(''), false)
assert.strictEqual(validFolder(null), false)
assert.throws(() => addExclude({}, '1', '../../etc'), /Invalid folder/)

// Workshop ids are digits only — the id is interpolated into a path too.
assert.strictEqual(validWorkshopId('3722134990'), true)
assert.strictEqual(validWorkshopId('37a'), false)
assert.strictEqual(validWorkshopId(''), false)
assert.strictEqual(validWorkshopId(3722134990), false)
assert.throws(() => addExclude({}, '../x', 'a'), /Invalid workshopId/)

// removalTargets — the guard that decides whether a mod keeps its files.
// Nothing else ships the folder: both the item's own trees and the shared <data>/mods copy go.
assert.deepStrictEqual(removalTargets('3722134990', 'GunsOfMarzPreviousVersion', []), [
  { root: 'item', parts: ['3722134990', 'mods', 'GunsOfMarzPreviousVersion'] },
  { root: 'mods', parts: ['GunsOfMarzPreviousVersion'] },
])

// The one that must never regress: another installed item ships a folder by the same name, so the
// shared <data>/mods copy is off limits — deleting it would strip that other mod from the save.
assert.deepStrictEqual(removalTargets('3722134990', 'Shared', ['9999']), [
  { root: 'item', parts: ['3722134990', 'mods', 'Shared'] },
])
assert.deepStrictEqual(removalTargets('1', 'Shared', ['2', '3']).length, 1)

// A missing/undefined provider list is treated as "nobody else ships it", matching [].
assert.deepStrictEqual(removalTargets('1', 'a', undefined).length, 2)

console.log('excludes: all tests passed')
