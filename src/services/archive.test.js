// Run: node --test src/
const assert = require('assert')
const { unsafeMembers, kindOf } = require('./archive')

// --- what a real PZ backup looks like: all of this must pass ---
assert.deepStrictEqual(unsafeMembers([
  'Saves/Multiplayer/servertest/map_t.bin',
  'Server/servertest.ini',
  'Server/servertest_SandboxVars.lua',
  'db/servertest.db',
  './Server/servertest.ini',
  'mods/Some Mod With Spaces/mod.info'
]), [])
assert.deepStrictEqual(unsafeMembers([]), [])
assert.deepStrictEqual(unsafeMembers(undefined), [])
// Blank lines from the tool's output are not members and must not be reported as escapes.
assert.deepStrictEqual(unsafeMembers(['', '   ']), [])

// --- escapes ---
assert.deepStrictEqual(unsafeMembers(['../etc/passwd']), ['../etc/passwd'])
assert.deepStrictEqual(unsafeMembers(['a/../../b']), ['a/../../b'])
assert.deepStrictEqual(unsafeMembers(['/etc/passwd']), ['/etc/passwd'])
assert.deepStrictEqual(unsafeMembers(['C:/Windows/x']), ['C:/Windows/x'])
assert.deepStrictEqual(unsafeMembers(['..\\x']), ['..\\x'])
assert.deepStrictEqual(unsafeMembers(['a\\b']), ['a\\b'])
assert.deepStrictEqual(unsafeMembers(['\\\\server\\share']), ['\\\\server\\share'])

// A '..' must be a whole segment to count — these are ordinary names.
assert.deepStrictEqual(unsafeMembers(['a/..b/c', 'x..y', 'Server/..hidden']), [])

// One bad member in an otherwise fine archive is still reported, and only it.
assert.deepStrictEqual(
  unsafeMembers(['Server/servertest.ini', '../../root/.ssh/authorized_keys', 'db/servertest.db']),
  ['../../root/.ssh/authorized_keys'])

// --- kindOf ---
assert.strictEqual(kindOf('x.tar.gz'), 'tar.gz')
assert.strictEqual(kindOf('x.TAR.GZ'), 'tar.gz')
assert.strictEqual(kindOf('x.tgz'), 'tar.gz')
assert.strictEqual(kindOf('x.zip'), 'zip')
assert.strictEqual(kindOf('no-extension'), 'zip')

console.log('archive: all assertions passed')
