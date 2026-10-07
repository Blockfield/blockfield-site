import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dangerousCommand, rawCommand } from '../src/lib/console.ts'

test('raw console takes exactly one line and drops the leading slash', () => {
  assert.equal(rawCommand('  /time set day '), 'time set day')
  for (const bad of ['', '  / ', 'say hi\nstop', 'say\u0000', 'x'.repeat(1001), 42, null])
    assert.throws(() => rawCommand(bad))
  assert.equal(rawCommand('x'.repeat(1000)).length, 1000)
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
