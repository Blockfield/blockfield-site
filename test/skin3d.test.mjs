import { test } from 'node:test'
import assert from 'node:assert/strict'
import { faces, parts } from '../src/lib/skin3d.ts'

test('грани головы берутся из стандартной развёртки 8×8×8', () => {
  const uv = faces(0, 0, 8, 8, 8).map((f) => [f.u, f.v, f.w, f.h])
  assert.deepEqual(uv, [
    [8, 8, 8, 8],
    [24, 8, 8, 8],
    [0, 8, 8, 8],
    [16, 8, 8, 8],
    [8, 0, 8, 8],
    [16, 0, 8, 8],
  ])
  assert.deepEqual(
    faces(0, 0, 10, 16, 1).map((f) => [f.u, f.v]),
    [
      [1, 1],
      [12, 1],
      [0, 1],
      [11, 1],
      [1, 0],
      [11, 0],
    ],
  )
})

test('тонкая модель сдвигает правую руку, старый скин зеркалит конечности', () => {
  const slim = parts(true, false)
  assert.equal(slim[2].x, 1)
  assert.equal(slim[3].W, 3)
  const legacy = parts(false, true)
  assert.ok(legacy[3].mirror && legacy[5].mirror)
  assert.deepEqual([legacy[3].u, legacy[3].v], [40, 16])
  assert.ok(legacy.slice(1).every((p) => !p.over))
  assert.ok(parts(false, false).every((p) => p.over))
})

test('отсутствующий или недоступный скин заменяется Стивом с обычными руками', async (t) => {
  const { JSDOM } = await import('jsdom')
  const { drawFigure } = await import('../src/lib/skin-figure.ts')
  const { readFileSync } = await import('node:fs')
  const png = readFileSync(new URL('../public/skins/steve.png', import.meta.url))
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [64, 64])
  const dom = new JSDOM('<div id="stage"><div id="figure"></div></div>')
  t.after(() => dom.window.close())
  globalThis.document = dom.window.document
  t.after(() => {
    delete globalThis.document
    delete globalThis.Image
  })
  let image
  globalThis.Image = class {
    constructor() {
      image = this
    }
  }
  const stage = document.querySelector('#stage'),
    figure = document.querySelector('#figure')
  const checkSteve = () => {
    assert.equal(figure.style.getPropertyValue('--tex'), 'url("/skins/steve.png")')
    assert.equal(figure.children[2].style.width, 'calc(4 * var(--s))')
    assert.equal(figure.classList.contains('blank'), false)
  }
  drawFigure(stage, figure, { skinUrl: null, slim: true })
  checkSteve()
  drawFigure(stage, figure, { skinUrl: '/custom.png', slim: true })
  image.height = 64
  image.onload()
  assert.equal(figure.style.getPropertyValue('--tex'), 'url("/custom.png")')
  assert.equal(figure.children[2].style.width, 'calc(3 * var(--s))')
  image.onerror()
  checkSteve()
})
