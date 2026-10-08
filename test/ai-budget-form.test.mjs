import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { renderAiBudgetForm } from '../src/lib/ai-budget-form.ts'

const SESSION = '11111111-1111-4111-8111-111111111111'
const A = '22222222-2222-4222-8222-222222222222'
const B = '33333333-3333-4333-8333-333333333333'
function form(t, session = true) {
  const dom = new JSDOM('<main></main>'),
    previous = globalThis.document
  globalThis.document = dom.window.document
  t.after(() => {
    globalThis.document = previous
    dom.window.close()
  })
  const control = renderAiBudgetForm(
    {
      schema: 1,
      revision: 3,
      currency: 'USD',
      mode: 'session',
      sessions: { [SESSION]: 10_000_000 },
      builders: { [A]: 1_000_000, [B]: 2_000_000 },
    },
    {
      session: session ? { id: SESSION, name: 'Текущий сеанс' } : undefined,
      builders: [
        { id: A, name: 'Строитель А' },
        { id: B, name: 'Строитель Б' },
      ],
    },
  )
  dom.window.document.querySelector('main').append(control.node)
  return { ...control, window: dom.window }
}

test('real budget form preserves both grant maps across mode/member changes and advances revision without losing edits', (t) => {
  const { node, read, saved, window } = form(t),
    mode = node.querySelector('#ai-budget-mode'),
    target = node.querySelector('#ai-budget-target'),
    amount = node.querySelector('#ai-budget-amount')
  amount.value = '12.500001'
  mode.value = 'builder'
  mode.dispatchEvent(new window.Event('change'))
  assert.equal(amount.value, '1')
  amount.value = '1,250001'
  target.value = B
  target.dispatchEvent(new window.Event('change'))
  assert.equal(amount.value, '2')
  amount.value = '0'
  assert.deepEqual(read(), {
    expectedRevision: 3,
    mode: 'builder',
    sessions: { [SESSION]: 12_500_001 },
    builders: { [A]: 1_250_001, [B]: 0 },
  })
  saved(4)
  amount.value = '3'
  assert.equal(read().expectedRevision, 4)
  assert.equal(read().builders[B], 3_000_000)
  assert.equal(node.querySelector('textarea'), null)
})

test('invalid dollars preserve the current scope and draft; absent session disables its amount without fabricating a grant', (t) => {
  const { node, read, window } = form(t),
    mode = node.querySelector('#ai-budget-mode'),
    amount = node.querySelector('#ai-budget-amount')
  amount.value = '0.0000001'
  mode.value = 'builder'
  mode.dispatchEvent(new window.Event('change'))
  assert.equal(mode.value, 'session')
  assert.equal(amount.value, '0.0000001')
  assert.match(node.querySelector('.form-status').textContent, /шести/)
  assert.throws(read)
})

test('without an active session only the chosen mode is saved; existing historical grants stay intact', (t) => {
  const { node, read } = form(t, false)
  assert.equal(node.querySelector('#ai-budget-amount').disabled, true)
  assert.equal(node.querySelector('#ai-budget-target').disabled, true)
  assert.equal(read().sessions[SESSION], 10_000_000)
})
