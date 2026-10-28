import { test } from 'node:test'
import assert from 'node:assert/strict'
import { finalDamageVsMatchKit, MATCH_KIT } from '../src/lib/gun-damage.ts'

test('AK case: damage 9, armor_ignore 0.3, head x1.5 hits 5.48 against the match kit', () => {
  const head = finalDamageVsMatchKit({
    damage: 9,
    armorIgnore: 0.3,
    headMult: 1.5,
    bodyMult: 1,
    part: 'head',
  })
  assert.ok(Math.abs(head - 5.48) < 0.01, `head ${head}`)
  // Тело без пластины: 9 x 0.3 пробивающего и остаток через броню.
  const body = finalDamageVsMatchKit({
    damage: 9,
    armorIgnore: 0.3,
    headMult: 1.5,
    bodyMult: 1,
    part: 'torso',
  })
  assert.ok(Math.abs(body - 3.65) < 0.01, `body ${body}`)
  assert.equal(MATCH_KIT.plate, 30)
})
