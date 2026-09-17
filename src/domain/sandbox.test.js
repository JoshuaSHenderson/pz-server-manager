// Run: node --test src/
//
// A wrong answer here is written back into servertest_SandboxVars.lua. The failure mode is not a
// bad form field — it is a world that will not load — so the shapes PZ actually writes are the
// cases worth pinning down.
const assert = require('assert')
const {
  parseSandboxComments, classifySandboxValue, parseSandbox,
  validateSandboxValue, formatSandboxValue, sandboxStructureOk,
} = require('./sandbox')

// An excerpt in the exact shape PZ writes: a root table, nested sections, a prose comment, a
// "Min:/Max:/Default:" line, and enum options as "-- N = Label".
const FILE = [
  'SandboxVars = {',
  '    VERSION = 5,',
  '    -- How fast zombies move.',
  '    -- 1 = Sprinters',
  '    -- 2 = Fast Shamblers',
  '    -- 3 = Shamblers',
  '    ZombieSpeed = 3,',
  '    -- Multiplier for loot. Min: 0.0 Max: 10.0 Default: 1.0',
  '    LootMultiplier = 1.5,',
  '    PVP = true,',
  '    ServerWelcomeMessage = "Welcome!",',
  '    Map = {',
  '        -- Days before a house is looted again.',
  '        -- Min: 0 Max: 365 Default: 0',
  '        HoursForLootRespawn = 24,',
  '    },',
  '    ZombieLore = {',
  '        Cognition = 2,',
  '    },',
  '}',
].join('\n')

const parsed = parseSandbox(FILE)
const byName = Object.fromEntries(parsed.sections.map(s => [s.name, s]))
const field = (section, key) => byName[section].fields.find(f => f.key === key)

// --- sections ---
assert.deepStrictEqual(Object.keys(byName).sort(), ['General', 'Map', 'ZombieLore'])
// A nested table becomes its own section, and the keys after it belong to the parent again.
assert.deepStrictEqual(byName.Map.fields.map(f => f.key), ['HoursForLootRespawn'])
assert.deepStrictEqual(byName.ZombieLore.fields.map(f => f.key), ['Cognition'])

// --- line numbers: the writer replaces by line, so an off-by-one here corrupts a different key ---
assert.strictEqual(field('General', 'VERSION').line, 2)
assert.strictEqual(field('General', 'ZombieSpeed').line, 7)
assert.strictEqual(field('Map', 'HoursForLootRespawn').line, 15)
// The 1-based line must point at the key it describes.
for (const sec of parsed.sections) {
  for (const f of sec.fields) {
    assert.ok(FILE.split('\n')[f.line - 1].includes(f.key + ' ='), f.key + ' line is wrong')
  }
}

// --- types ---
assert.strictEqual(field('General', 'PVP').type, 'boolean')
assert.strictEqual(field('General', 'PVP').value, true)
assert.strictEqual(field('General', 'LootMultiplier').type, 'float')
assert.strictEqual(field('General', 'LootMultiplier').value, 1.5)
assert.strictEqual(field('General', 'VERSION').type, 'int')
assert.strictEqual(field('General', 'ServerWelcomeMessage').type, 'string')
assert.strictEqual(field('General', 'ServerWelcomeMessage').value, 'Welcome!')
// An integer with labelled options is an enum choice, not a number field.
assert.strictEqual(field('General', 'ZombieSpeed').type, 'enum')
assert.deepStrictEqual(field('General', 'ZombieSpeed').options,
  [{ value: '1', label: 'Sprinters' }, { value: '2', label: 'Fast Shamblers' }, { value: '3', label: 'Shamblers' }])

// --- comment metadata ---
assert.strictEqual(field('General', 'LootMultiplier').min, 0)
assert.strictEqual(field('General', 'LootMultiplier').max, 10)
assert.strictEqual(field('General', 'LootMultiplier').default, '1.0')
// Prose before the Min:/Max: run stays as the description.
assert.strictEqual(field('General', 'LootMultiplier').description, 'Multiplier for loot.')
assert.strictEqual(field('General', 'ZombieSpeed').description, 'How fast zombies move.')
// A comment block belongs only to the key that follows it — a blank line clears it.
assert.strictEqual(field('General', 'PVP').description, '')

// --- parseSandboxComments on its own ---
assert.deepStrictEqual(parseSandboxComments([]),
  { description: '', options: null, min: null, max: null, default: null })
assert.strictEqual(parseSandboxComments(['-- Min: -5 Max: 5']).min, -5)
assert.strictEqual(parseSandboxComments(['-- Default = 7']).default, '7')

// --- classify ---
assert.deepStrictEqual(classifySandboxValue('true', {}), { type: 'boolean', value: true })
assert.deepStrictEqual(classifySandboxValue('"x"', {}), { type: 'string', value: 'x' })
assert.deepStrictEqual(classifySandboxValue('-3', {}), { type: 'int', value: -3 })
assert.deepStrictEqual(classifySandboxValue('-0.5', {}), { type: 'float', value: -0.5 })
// Anything unrecognised is 'raw', which validate refuses rather than guessing at.
assert.strictEqual(classifySandboxValue('{1, 2}', {}).type, 'raw')

// --- validation: the point is that a bad value never reaches the file ---
const intField = { section: 'Map', key: 'HoursForLootRespawn', type: 'int', min: 0, max: 365 }
assert.strictEqual(validateSandboxValue(intField, 24), null)
assert.strictEqual(validateSandboxValue(intField, '24'), null)
assert.match(validateSandboxValue(intField, 1.5), /whole number/)
assert.match(validateSandboxValue(intField, -1), /at least 0/)
assert.match(validateSandboxValue(intField, 400), /at most 365/)
assert.match(validateSandboxValue(intField, 'abc'), /whole number/)

const boolField = { section: 'General', key: 'PVP', type: 'boolean' }
assert.strictEqual(validateSandboxValue(boolField, false), null)
assert.match(validateSandboxValue(boolField, 'true'), /true or false/)

const enumField = { section: 'General', key: 'ZombieSpeed', type: 'enum', options: [{ value: '1' }, { value: '2' }] }
assert.strictEqual(validateSandboxValue(enumField, '2'), null)
assert.match(validateSandboxValue(enumField, '9'), /not a valid option/)

// A string must not be able to close its own quote, add a line, or escape — all three would make
// the rewritten line invalid Lua.
const strField = { section: 'General', key: 'ServerWelcomeMessage', type: 'string', min: null, max: null }
assert.strictEqual(validateSandboxValue(strField, 'hello'), null)
assert.match(validateSandboxValue(strField, 'say "hi"'), /double quotes/)
assert.match(validateSandboxValue(strField, 'a\nb'), /line breaks/)
assert.match(validateSandboxValue(strField, 'a\\b'), /backslashes/)
assert.match(validateSandboxValue({ section: 'X', key: 'Y', type: 'raw' }, 1), /raw mode/)

// --- formatting back to Lua ---
assert.strictEqual(formatSandboxValue(boolField, true), 'true')
assert.strictEqual(formatSandboxValue(boolField, false), 'false')
assert.strictEqual(formatSandboxValue(intField, '24'), '24')
assert.strictEqual(formatSandboxValue(strField, 'hi'), '"hi"')
// A float that happens to be whole keeps its decimal point, or the field silently becomes an int.
assert.strictEqual(formatSandboxValue({ type: 'float' }, 2), '2.0')
assert.strictEqual(formatSandboxValue({ type: 'float' }, 2.5), '2.5')

// --- structure check: the last gate before the file is written ---
assert.strictEqual(sandboxStructureOk(FILE), true)
assert.strictEqual(sandboxStructureOk('SandboxVars = {'), false)
assert.strictEqual(sandboxStructureOk('}'), false)
assert.strictEqual(sandboxStructureOk(''), true)

// --- a round trip through the writer's own procedure leaves every other byte alone ---
const lines = FILE.split('\n')
const target = field('General', 'LootMultiplier')
lines[target.line - 1] = lines[target.line - 1].replace(
  /=\s*(.+?),?\s*$/, '= ' + formatSandboxValue(target, 2.5) + ',')
const rewritten = lines.join('\n')
assert.strictEqual(sandboxStructureOk(rewritten), true)
assert.strictEqual(parseSandbox(rewritten).sections[0].fields.find(f => f.key === 'LootMultiplier').value, 2.5)
// Everything except that one line is byte-identical.
const before = FILE.split('\n')
rewritten.split('\n').forEach((l, i) => {
  if (i !== target.line - 1) assert.strictEqual(l, before[i], 'line ' + (i + 1) + ' changed')
})

console.log('sandbox: all assertions passed')
