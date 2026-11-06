import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { JSDOM } from 'jsdom'

// Server status UI (index.astro refreshRooms): while a deploy runs /api/rooms
// carries deploying:true (rooms.ts currentRooms) and the page must show
// «Идёт деплой» instead of the dead-server message.
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

const down = { available: false, checkedAt: Date.now(), rooms: [], lobby: false }

test('deploying shows «Идёт деплой», not the dead-server message', async () => {
  assert.match(
    index,
    /roomStatus\.textContent = 'Идёт деплой'/,
    'script renders the deploying copy',
  )
  const state = await renderRoomsStatus({ ...down, deploying: true, stale: true })
  assert.equal(state.text, 'Идёт деплой')
  assert.equal(state.hidden, false, 'deploying status is visible without an invite')
  assert.equal(state.children, 0, 'no stale rooms rendered as live')
})

test('plain outage keeps the dead-server message (no deploying flag)', async () => {
  const state = await renderRoomsStatus(down)
  assert.equal(state.text, 'Не удалось получить список матчей. Повторим запрос автоматически.')
})

test('deploying with the lobby open keeps the lobby guidance', async () => {
  const state = await renderRoomsStatus({ ...down, lobby: true, deploying: true, stale: true })
  assert.match(state.text, /обновляется/, 'lobby-open deploy still points at the lobby')
})
