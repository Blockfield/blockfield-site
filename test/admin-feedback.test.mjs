import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import ts from 'typescript'

// Exercise the real page helpers: a key is shown once and must survive the shared action runner.
const page = readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8')
const script = page.split('<script>')[1].split('</script>')[0]
const source = ts.createSourceFile('admin.ts', script, ts.ScriptTarget.Latest, true)
const helpers = source.statements
  .filter((node) => ts.isFunctionDeclaration(node) && ['say', 'run'].includes(node.name?.text))
  .map((node) => node.getText(source))
  .join('\n')
const code = ts.transpileModule(helpers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

test('action runner preserves one-time feedback and clears only its own busy status', async () => {
  const dom = new JSDOM('<p id="status"></p>', { runScripts: 'outside-only' })
  try {
    dom.window.eval(code)
    const line = dom.window.document.querySelector('#status')
    await dom.window.run(line, async () => {
      const key = dom.window.document.createElement('span')
      key.className = 'secret'
      key.textContent = 'test-only-key'
      line.replaceChildren('Ключ создан: ', key)
    })
    assert.equal(line.querySelector('.secret')?.textContent, 'test-only-key')
    assert.equal(line.classList.contains('pending'), false)
    await dom.window.run(line, async () => {})
    assert.equal(line.textContent, '')
    await dom.window.run(line, async () => {
      throw new Error('Проверочная ошибка')
    })
    assert.equal(line.textContent, 'Проверочная ошибка')
    assert.equal(line.classList.contains('error'), true)
  } finally {
    dom.window.close()
  }
})
