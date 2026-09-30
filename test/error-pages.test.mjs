import assert from 'node:assert/strict'
import fs from 'node:fs'
import { test } from 'node:test'
import { JSDOM, VirtualConsole } from 'jsdom'
import { ESLint } from 'eslint'

const html = fs.readFileSync(new URL('../ops/error-pages/blockfield.html', import.meta.url), 'utf8')

test('shared 404 keeps recovery links and readable fallback when canvas is unavailable', async () => {
  let script
  for (const [lang, heading] of [
    ['ru', 'Здесь страницы нет'],
    ['uk', 'Тут сторінки немає'],
    ['en', 'There’s no page here'],
  ]) {
    const errors = []
    const console = new VirtualConsole()
    console.on('jsdomError', (error) => errors.push(error.message))
    const dom = new JSDOM(html, {
      url: 'https://bot.blockfield.pro/missing',
      runScripts: 'dangerously',
      virtualConsole: console,
      beforeParse(window) {
        Object.defineProperty(window.navigator, 'languages', { value: [lang] })
        window.HTMLCanvasElement.prototype.getContext = () => null
      },
    })
    const document = dom.window.document
    script = document.querySelector('script').textContent
    assert.deepEqual(errors, [])
    assert.equal(document.documentElement.lang, lang)
    assert.equal(document.querySelector('h1').textContent, heading)
    assert.equal(document.getElementById('host').textContent, 'bot.blockfield.pro')
    assert.equal(document.getElementById('website').href, 'https://blockfield.pro/')
    assert.equal(document.getElementById('play').getAttribute('href'), 'blockfield://join/lobby')
    assert.equal(document.querySelector('.code').textContent, '404')
    assert.equal(document.querySelector('.stage').classList.contains('enhanced'), false)
    assert.equal(document.querySelectorAll('script[src], link[rel="stylesheet"]').length, 0)
    dom.window.close()
  }
  const [result] = await new ESLint().lintText(script, {
    filePath: 'ops/error-pages/particles.mjs',
  })
  assert.deepEqual(result.messages, [])
})
