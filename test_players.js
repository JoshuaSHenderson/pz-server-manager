// Run: node test_players.js
const assert = require('assert')
const { makeState, applyLine, replay, onlineNames } = require('./players')

const ID = '76561198036178683'
const ID2 = '76561198072495346'

// --- current B42 shape: id-only disconnects. This is the one that silently stopped working. ---
let r = replay([
  '[04-08-26 21:36:02.020] Connection add index=0 guid=945756253659280813 id=null.',
  '[04-08-26 21:36:03.633] ' + ID + ' "Rick" allowed to join.',
  '[04-08-26 21:37:07.087] Connection disconnect index=0 guid=945756253659280813 id=' + ID + '.',
  '[04-08-26 21:37:07.091] Connection remove index=0 guid=945756253659280813 id=' + ID + '.'
].join('\n'))
assert.deepStrictEqual(r.events.map(e => e.type + ':' + e.name), ['join:Rick', 'leave:Rick'],
  'id-only disconnect must produce exactly one leave, named from the join line')
assert.deepStrictEqual(r.online, [])

// --- older name-carrying shape ---
r = replay([
  '[14-07-26 22:39:23.200] ' + ID2 + ' "Henderson" allowed to join.',
  '[14-07-26 22:40:54.104] ' + ID2 + ' "Henderson" fully connected (10098,8258,1).',
  '[14-07-26 22:49:11.177] ' + ID2 + ' "Henderson" removed connection index=0.',
  '[14-07-26 22:49:11.189] ' + ID2 + ' "Henderson" disconnected player (10096,8261,0).'
].join('\n'))
assert.deepStrictEqual(r.events.map(e => e.type + ':' + e.name),
  ['join:Henderson', 'spawn:Henderson', 'leave:Henderson'])
assert.deepStrictEqual(r.online, [])

// --- the original bug: "fully connected" repeats on respawn and must never be a join ---
r = replay([
  ID + ' "Rick" allowed to join.',
  ID + ' "Rick" fully connected (1,2,3).',
  'user Rick died at (1,2,3) (non pvp).',
  ID + ' "Rick" fully connected (4,5,6).'
].join('\n'))
assert.deepStrictEqual(r.events.map(e => e.type), ['join', 'spawn', 'spawn'],
  'respawn is a spawn, never a second join')
assert.deepStrictEqual(r.online, ['Rick'])

// The second spawn of a session is flagged as a respawn so the alert can say so.
const spawns = r.events.filter(e => e.type === 'spawn')
assert.strictEqual(spawns[0].respawn, false)
assert.strictEqual(spawns[1].respawn, true)
assert.strictEqual(spawns[0].name, 'Rick')

// A fresh session starts over: the first spawn after rejoining is not a respawn.
r = replay([
  ID + ' "Rick" allowed to join.',
  ID + ' "Rick" fully connected (1,2,3).',
  'Connection remove index=0 guid=1 id=' + ID + '.',
  ID + ' "Rick" allowed to join.',
  ID + ' "Rick" fully connected (1,2,3).'
].join('\n'))
assert.deepStrictEqual(r.events.filter(e => e.type === 'spawn').map(e => e.respawn), [false, false])

// --- two players, independent sessions ---
r = replay([
  ID + ' "Rick" allowed to join.',
  ID2 + ' "Paul" allowed to join.',
  'Connection disconnect index=0 guid=1 id=' + ID + '.'
].join('\n'))
assert.deepStrictEqual(r.events.map(e => e.type + ':' + e.name), ['join:Rick', 'join:Paul', 'leave:Rick'])
assert.deepStrictEqual(r.online, ['Paul'])

// --- a disconnect for someone we never saw join is not a leave event ---
r = replay('Connection disconnect index=0 guid=1 id=' + ID + '.')
assert.deepStrictEqual(r.events, [])

// --- rejoin after leaving works ---
r = replay([
  ID + ' "Rick" allowed to join.',
  'Connection remove index=0 guid=1 id=' + ID + '.',
  ID + ' "Rick" allowed to join.'
].join('\n'))
assert.deepStrictEqual(r.events.map(e => e.type), ['join', 'leave', 'join'])
assert.deepStrictEqual(r.online, ['Rick'])

// --- duplicate join lines do not double-notify ---
r = replay([ID + ' "Rick" allowed to join.', ID + ' "Rick" allowed to join.'].join('\n'))
assert.deepStrictEqual(r.events.map(e => e.type), ['join'])

// --- seeding: state built from history, then a later leave still resolves ---
// This is the manager-restart case — without seeding, the leave has no name to report.
const seeded = replay(ID + ' "Rick" allowed to join.').state
assert.deepStrictEqual(onlineNames(seeded), ['Rick'])
const ev = applyLine(seeded, 'Connection disconnect index=0 guid=1 id=' + ID + '.')
assert.deepStrictEqual(ev, { type: 'leave', name: 'Rick', steamId: ID })

// --- noise must not throw or register ---
for (const junk of ['', 'Connection add index=0 guid=1 id=null.', 'random text', 'Saving players']) {
  assert.strictEqual(applyLine(makeState(), junk), null)
}
assert.deepStrictEqual(replay(undefined).online, [])
assert.deepStrictEqual(replay('').online, [])

console.log('players: all assertions passed')
