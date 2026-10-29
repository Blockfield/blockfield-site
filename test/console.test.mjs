import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dangerousCommand, rawCommand, rconTarget } from '../src/lib/console.ts'

test('raw console takes exactly one line and drops the leading slash', () => {
  assert.equal(rawCommand('  /time set day '), 'time set day')
  for (const bad of ['', '  / ', 'say hi\nstop', 'say\u0000', 'x'.repeat(1001), 42, null])
    assert.throws(() => rawCommand(bad))
  assert.equal(rawCommand('x'.repeat(1000)).length, 1000)
})

test('rconTarget accepts exact enum game|workshop, defaults to game, and rejects unknown targets', () => {
  assert.equal(rconTarget(undefined), 'game')
  assert.equal(rconTarget(null), 'game')
  assert.equal(rconTarget(''), 'game')
  assert.equal(rconTarget('game'), 'game')
  assert.equal(rconTarget('workshop'), 'workshop')

  for (const bad of ['GAME', 'Workshop', 'hub', 'all', '127.0.0.1', 42, true, {}, []]) {
    assert.throws(() => rconTarget(bad), /Неизвестная цель консоли\./)
  }
})

test('server-wide or irreversible commands ask for confirmation', () => {
  for (const command of [
    'stop',
    'op Bob',
    'DEOP Bob',
    'whitelist off',
    'kill @a',
    'execute as @a run stop',
  ])
    assert.ok(dangerousCommand(command), command)
  for (const command of ['list', 'say stopping soon', 'whitelist list', 'tick query', 'stopwatch'])
    assert.ok(!dangerousCommand(command), command)
})

import {
  consoleLogPage,
  consoleSince,
  consoleSuggestPage,
  suggestInput,
} from '../src/lib/console.ts'

test('console log cursor is a non-negative integer defaulting to 0', () => {
  assert.equal(consoleSince(undefined), 0)
  assert.equal(consoleSince(''), 0)
  assert.equal(consoleSince('12'), 12)
  for (const bad of ['-1', 'nope', 1.5, -2, {}, []])
    assert.throws(() => consoleSince(bad), /Некорректный курсор журнала\./)
})

test('completion input may be empty but stays one line under 1000 chars', () => {
  assert.equal(suggestInput(''), '')
  assert.equal(suggestInput('/time set '), 'time set ')
  assert.equal(suggestInput('x'.repeat(1000)).length, 1000)
  for (const bad of ['a\nb', 'x'.repeat(1001), 42, null]) assert.throws(() => suggestInput(bad))
})

test('console link pages are validated and capped, never passed through raw', () => {
  assert.deepEqual(consoleLogPage({ entries: [], next: 0 }), { entries: [], next: 0 })
  const page = consoleLogPage({
    entries: [{ seq: 3, at: 9, level: 'warn', logger: 'net.Foo', message: 'hi' }, 42],
    next: 3,
  })
  assert.deepEqual(page.entries[0], {
    seq: 3,
    at: 9,
    level: 'WARN',
    logger: 'net.Foo',
    message: 'hi',
  })
  assert.deepEqual(page.entries[1], { seq: 0, at: 0, level: '', logger: '', message: '' })
  for (const bad of [null, {}, { entries: [], next: -1 }, { entries: {}, next: 0 }])
    assert.throws(() => consoleLogPage(bad), /Журнал недоступен\./)
  assert.deepEqual(consoleSuggestPage({ from: 5, suggestions: [] }), {
    from: 5,
    suggestions: [],
  })
  const many = Array.from({ length: 60 }, (_, i) => ({ text: `s${i}`, hint: 'u' }))
  assert.equal(consoleSuggestPage({ from: 0, suggestions: many }).suggestions.length, 50)
  for (const bad of [null, { from: -1, suggestions: [] }, { from: 0 }])
    assert.throws(() => consoleSuggestPage(bad), /Подсказки недоступны\./)
})
