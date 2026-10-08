import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { gameReady, switchView } from '../src/lib/switch-status.ts'
import { permissions } from '../src/lib/admin.ts'

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

const workshopHelpers = source.statements
  .filter(
    (node) =>
      ts.isFunctionDeclaration(node) &&
      [
        'el',
        'say',
        'timing',
        'sessionLine',
        'describeGame',
        'describeWorkshop',
        'renderModes',
        'renderProgress',
      ].includes(node.name?.text),
  )
  .map((node) => node.getText(source))
  .join('\n')
const workshopCode = ts.transpileModule(workshopHelpers, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText

test('real admin cards keep Game available during Workshop restart/error/test and preserve role gates', () => {
  const dom = new JSDOM('<p id="mode-progress"></p><div id="mode-options"></div>', {
    runScripts: 'outside-only',
  })
  try {
    const window = dom.window
    window.gameReady = gameReady
    window.switchView = switchView
    window.$ = (selector) => window.document.querySelector(selector)
    window.ago = () => 'только что'
    window.MAP_NAMES = {}
    window.WORKSHOP_PLACES = {}
    for (const action of ['cancelSwitch', 'recoverWorkshop', 'resumeWorkshop', 'startWorkshop'])
      window[action] = () => {}
    window.eval(workshopCode)
    window.button = (label, action, className) =>
      window.el('button', { textContent: label, onclick: action, className })
    for (const role of ['builder', 'moderator', 'admin', 'owner']) {
      window.can = (permission) => permissions(role).includes(permission)
      for (const phase of ['workshop', 'test', 'STARTING', 'ERROR']) {
        window.controller = {
          schema: 1,
          revision: 4,
          phase,
          gate: phase === 'workshop' ? 'builders' : phase === 'test' ? 'testers' : 'closed',
          desired: { profile: phase === 'test' ? 'test' : 'workshop' },
          game: { phase: 'game', gate: 'public', release: 'v2.68.0' },
        }
        const rooms = { available: true, rooms: [{ id: 'match' }] }
        assert.equal(window.describeGame(window.controller, rooms).title, 'Игра работает')
        const workshop = window.describeWorkshop(window.controller, null, null)
        window.renderModes(workshop, rooms)
        const options = window.document.querySelectorAll('.option')
        assert.equal(options.length, 2)
        assert.equal(options[0].querySelector('.badge').textContent, 'Вход открыт')
        const labels = [...options[1].querySelectorAll('button')].map((b) => b.textContent)
        if (role === 'builder') assert.deepEqual(labels, [])
        else if (phase === 'ERROR')
          assert.deepEqual(labels, role === 'moderator' ? [] : ['Восстановить мастерскую'])
        else if (phase === 'test') assert.deepEqual(labels, ['Вернуться в мастерскую'])
        else if (phase === 'STARTING') assert.deepEqual(labels, ['Отменить смену режима'])
        else assert.deepEqual(labels, ['Выбрать сеанс и карты'])
        assert.equal(window.document.body.textContent.includes('Вернуть игровой режим'), false)
      }
    }
    window.controller = { schema: 1, phase: 'workshop', gate: 'builders' }
    assert.equal(
      window.describeGame(window.controller, { available: true, rooms: [] }).title,
      'Готовность игры не подтверждена',
    )
    window.renderModes(window.describeWorkshop(window.controller, null, null), { available: true })
    assert.equal(
      window.document.querySelectorAll('button').length,
      0,
      'no mutation without a valid controller revision',
    )
    assert.equal(window.document.querySelector('.badge').textContent, 'Готовность не подтверждена')
    window.controller.game = { phase: 'game', gate: 'public', release: 'v2.68.0' }
    const maintenance = { maintenance: { message: 'Вход закрыт' } }
    assert.equal(window.describeGame(window.controller, maintenance).title, 'Вход в игру закрыт')
    window.renderModes(window.describeWorkshop(window.controller, null, null), maintenance)
    assert.equal(
      window.document.querySelector('.badge').textContent,
      'Готовность не подтверждена',
      'public file also fails closed',
    )
  } finally {
    dom.window.close()
  }
})
