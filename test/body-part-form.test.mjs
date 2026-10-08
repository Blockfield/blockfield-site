import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { renderBodyPartField } from '../src/lib/body-part-form.ts'
import { BODY_PARTS } from '../src/lib/gun-fields.ts'

const field = {
  type: 'object',
  nullable: false,
  fields: Object.fromEntries(
    BODY_PARTS.map((part) => [part, { type: 'number', nullable: false, min: 0, max: 10 }]),
  ),
}

function form(t, enabled = false) {
  const dom = new JSDOM('<form></form>'),
    previous = globalThis.document
  globalThis.document = dom.window.document
  t.after(() => {
    globalThis.document = previous
    dom.window.close()
  })
  const control = renderBodyPartField(
    Object.fromEntries(BODY_PARTS.map((part) => [part, 1])),
    field,
    enabled,
  )
  dom.window.document.querySelector('form').append(control.node)
  return { ...control, window: dom.window }
}

test('malformed stored body data remains resettable instead of crashing the page', (t) => {
  const { window } = form(t)
  const control = renderBodyPartField(null, field, true)
  assert.equal(control.node.querySelector('#body-part-head').value, '')
  assert.throws(control.read, /Голова/)
  const toggle = control.node.querySelector('[type=checkbox]')
  toggle.checked = false
  toggle.dispatchEvent(new window.Event('change'))
  assert.equal(control.read(), undefined)
})

test('real body controls expose six labelled numeric fields, start disabled, and preserve draft values when toggled', (t) => {
  const { node, read, window } = form(t),
    toggle = node.querySelector('[type=checkbox]'),
    inputs = [...node.querySelectorAll('[type=number]')]
  assert.equal(inputs.length, 6)
  assert.equal(node.querySelector('textarea'), null)
  assert.equal(read(), undefined)
  for (const input of inputs) {
    assert.equal(input.disabled, true)
    assert.equal(input.value, '1')
    assert.equal(input.min, '0')
    assert.equal(input.max, '10')
    assert.ok(node.querySelector(`label[for="${input.id}"]`).textContent)
    assert.ok(node.querySelector(`#${input.getAttribute('aria-describedby')}`))
  }
  toggle.checked = true
  toggle.dispatchEvent(new window.Event('change'))
  inputs[0].value = '2.5'
  inputs[2].value = '0'
  assert.equal(
    inputs.every((input) => !input.disabled),
    true,
  )
  assert.equal(read().head, 2.5)
  assert.equal(read().left_arm, 0)
  toggle.checked = false
  toggle.dispatchEvent(new window.Event('change'))
  assert.equal(read(), undefined)
  toggle.checked = true
  toggle.dispatchEvent(new window.Event('change'))
  assert.equal(read().head, 2.5)
})

test('body control refuses empty and out-of-range drafts before save and remains valid at both bounds', (t) => {
  const { node, read } = form(t, true),
    head = node.querySelector('#body-part-head')
  assert.equal(node.open, true)
  for (const value of ['', '-0.1', '10.1', '1e999']) {
    head.value = value
    assert.throws(read, /Голова/)
  }
  head.value = '0'
  assert.equal(read().head, 0)
  head.value = '10'
  assert.equal(read().head, 10)
  assert.equal(node.closest('form').checkValidity(), true)
})
