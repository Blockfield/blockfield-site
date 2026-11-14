import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { JSDOM } from 'jsdom'

// Server status UI (index.astro refreshRooms): rooms come from CP
// (/api/rooms); the page shows the maintenance message or the dead-server
// message. No lobby/deploying branches remain (CP-only rooms.ts).
const index = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8')
const scriptSource = () => stripTypeScriptTypes(index.match(/<script>([\s\S]*?)<\/script>/)[1])

async function renderRoomsStatus(payload, url = 'https://blockfield.test/') {
  const dom = new JSDOM(
    '<section id="rooms" hidden><p id="rooms-status" role="status"></p><div id="rooms-list"></div>' +
      '<a id="lobby-join" href="#">x</a><p id="room-launch-status" hidden></p></section>' +
      '<div class="hero"></div><div class="hero__art"><img></div>',
    { url, runScripts: 'outside-only' },
  )
  try {
    dom.window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    dom.window.fetch = async () => ({ ok: true, json: async () => payload })
    dom.window.eval(scriptSource())
    await new Promise((resolve) => setTimeout(resolve, 50))
    const doc = dom.window.document
    return {
      text: doc.querySelector('#rooms-status').textContent,
      hidden: doc.querySelector('#rooms').hidden,
      children: doc.querySelector('#rooms-list').childElementCount,
    }
  } finally {
    dom.window.close()
  }
}

const down = { available: false, checkedAt: Date.now(), rooms: [] }

test('no lobby or deploying branches remain in the refresh script', () => {
  assert.doesNotMatch(index, /status\.lobby/, 'no lobby branch')
  assert.doesNotMatch(index, /status\.deploying/, 'no deploying branch')
  assert.doesNotMatch(index, /Идёт деплой/, 'no deploying copy')
})

test('plain outage keeps the dead-server message', async () => {
  const state = await renderRoomsStatus(down)
  assert.equal(state.text, 'Не удалось получить список матчей. Повторим запрос автоматически.')
})

test('maintenance message is shown when the gate is closed', async () => {
  const state = await renderRoomsStatus({
    ...down,
    maintenance: { message: 'Техработы', since: null },
  })
  assert.equal(state.text, 'Техработы')
})
