import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { JSDOM } from 'jsdom'

test('site menu closes on resize, Escape and navigation and releases the page', () => {
  const dom = new JSDOM(
    `<button class="site-header__burger" aria-expanded="false"></button>
     <div id="mobile-menu" hidden><a href="#content">Скачать</a></div>
     <main id="content"></main><footer class="site-footer"></footer>`,
    { runScripts: 'outside-only' },
  )
  let resize
  dom.window.matchMedia = () => ({
    addEventListener: (event, callback) => {
      assert.equal(event, 'change')
      resize = callback
    },
  })
  const source = readFileSync(
    new URL('../src/components/SiteHeader.astro', import.meta.url),
    'utf8',
  )
  dom.window.eval(stripTypeScriptTypes(source.match(/<script>([\s\S]*?)<\/script>/)[1]))
  const { document, KeyboardEvent } = dom.window
  const burger = document.querySelector('button')
  const menu = document.querySelector('#mobile-menu')
  const content = document.querySelector('main')
  const footer = document.querySelector('footer')

  for (const close of [
    () => resize(),
    () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })),
    () => menu.querySelector('a').click(),
  ]) {
    burger.click()
    assert.equal(menu.hidden, false)
    assert.equal(burger.getAttribute('aria-expanded'), 'true')
    assert.equal(document.body.style.overflow, 'hidden')
    assert.equal(content.inert, true)
    assert.equal(footer.inert, true)
    close()
    assert.equal(menu.hidden, true)
    assert.equal(burger.getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.style.overflow, '')
    assert.equal(content.inert, false)
    assert.equal(footer.inert, false)
  }
  dom.window.close()
})
