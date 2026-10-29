import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { JSDOM } from 'jsdom'

// The owner report: «Панель» intermittently hidden while /admin works.
// SSR bakes the decision into HTML once (stale on cached pages or transient
// account/DB failures); the header must converge to the exact /admin gate.
const header = readFileSync(new URL('../src/components/SiteHeader.astro', import.meta.url), 'utf8')
const scriptSource = () => stripTypeScriptTypes(header.match(/<script>([\s\S]*?)<\/script>/)[1])

async function renderHeader(meStatus) {
  const dom = new JSDOM(
    `<a class="site-header__console" href="/admin" data-admin-link hidden>Панель</a>
     <button class="site-header__burger" aria-expanded="false"></button>
     <div id="mobile-menu" hidden></div><main id="content"></main><footer class="site-footer"></footer>`,
    { url: 'https://blockfield.test/', runScripts: 'outside-only' },
  )
  try {
    dom.window.matchMedia = () => ({ addEventListener: () => {} })
    dom.window.fetch = async () => ({ ok: meStatus === 200 })
    dom.window.eval(scriptSource())
    await new Promise((resolve) => setTimeout(resolve, 10))
    return dom.window.document.querySelector('[data-admin-link]').hidden
  } finally {
    dom.window.close()
  }
}

test('denied SSR render keeps the link and rechecks the /admin gate', () => {
  assert.match(header, /data-admin-link/, 'denied SSR keeps the link for recheck')
  assert.match(
    header,
    /hidden=\{!identity\?\.hasAdminAccess\}/,
    'SSR still hides the link without proven access',
  )
  assert.match(header, /\/api\/admin\/me/, 'recheck uses the /admin authorization endpoint')
})

test('stale SSR denial converges: /api/admin/me 200 reveals, 403 keeps hidden', async () => {
  assert.equal(await renderHeader(200), false, 'owner (/admin lets in) sees Панель')
  assert.equal(await renderHeader(403), true, 'non-staff still does not see Панель')
})

test('legal pages are not publicly cacheable (per-user header HTML)', () => {
  const legal = readFileSync(new URL('../src/layouts/Legal.astro', import.meta.url), 'utf8')
  assert.match(legal, /Cache-Control.+no-store/, 'privacy/terms must send no-store')
})
