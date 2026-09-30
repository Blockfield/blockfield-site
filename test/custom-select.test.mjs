import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

// customSelect() paints a button + listbox over a native <select> and re-syncs them on every call
// (e.g. after the options or the selected value change). Regression test for a production bug: the
// redraw path rebuilt the listbox's <li>s by hand instead of calling the listbox's own setItems(),
// which never updated its internal item count — so the popup could never open at all (the admin
// panel's role select, every select on /leaderboard, etc. were all affected).
const dom = new JSDOM('<!doctype html><html><body></body></html>')
dom.window.HTMLElement.prototype.scrollIntoView = () => {} // jsdom does not implement layout, so it has no scrollIntoView
Object.assign(globalThis, {
  document: dom.window.document,
  Event: dom.window.Event,
  KeyboardEvent: dom.window.KeyboardEvent,
})

const { customSelect } = await import('../src/lib/custom-select.ts')

function select(options, selected = 0) {
  const el = document.createElement('select')
  for (const [value, text] of options) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = text
    el.append(option)
  }
  el.selectedIndex = selected
  return el
}

test('customSelect: the popup still opens after a redraw (value or options changed)', () => {
  const el = select(
    [
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
    ],
    1,
  )
  document.body.append(el)
  customSelect(el)
  const button = el.nextElementSibling.querySelector('.cselect-btn')
  const list = el.nextElementSibling.querySelector('.cselect-list')

  // First open works even before any redraw.
  button.click()
  assert.equal(list.hidden, false, 'listbox opens on first click')
  button.click()
  assert.equal(list.hidden, true, 'listbox closes on second click')

  // Redraw (as loadTeam()/renderBalance() do on every re-render) must not break future opens.
  el.selectedIndex = 2
  customSelect(el)
  button.click()
  assert.equal(list.hidden, false, 'listbox still opens after a redraw')
  assert.equal(list.children.length, 3, 'redraw keeps all options')
})

test('customSelect: native change, reset and disabled state stay in sync', async () => {
  const form = document.createElement('form')
  const el = select([
    ['a', 'A'],
    ['b', 'B'],
  ])
  form.append(el)
  document.body.append(form)
  customSelect(el)
  const button = el.nextElementSibling.querySelector('.cselect-btn')
  const list = el.nextElementSibling.querySelector('.cselect-list')

  el.value = 'b'
  el.dispatchEvent(new Event('change', { bubbles: true }))
  assert.equal(button.textContent, 'B')
  form.reset()
  await Promise.resolve()
  assert.equal(el.value, 'a')
  assert.equal(button.textContent, 'A')

  button.click()
  assert.equal(list.hidden, false)
  el.disabled = true
  customSelect(el)
  assert.equal(button.disabled, true)
  assert.equal(list.hidden, true)
  button.click()
  assert.equal(list.hidden, true)

  el.disabled = false
  customSelect(el)
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.equal(el.value, 'b')
  assert.equal(button.textContent, 'B')
  assert.equal(list.hidden, true)
})
