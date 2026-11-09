import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { NAV_GROUPS, resolveTab } from '../src/lib/admin-navigation.ts'
import { settingsReceipt } from '../src/lib/settings-form.ts'
import {
  DEFAULT_STREAK_ENTRIES,
  entriesToRows,
  parseStreakEntries,
  rowsToEntries,
  streakCycle,
  streakPeriod,
} from '../src/lib/streak-table.ts'
const streakLib = {
  parseStreakEntries,
  entriesToRows,
  rowsToEntries,
  streakCycle,
  streakPeriod,
  DEFAULT_STREAK_ENTRIES,
}
const streakState = () =>
  `let streakRows = [], streakBase = '', streakError = null, streakReset = false, lastSettingsSnapshot = null, streakOptionsLoaded = false; const streakLabels = new Map(), customCombo = () => {};`
const streakFns = [
  'el',
  'streakTableOf',
  'streakSerialized',
  'streakBaseOf',
  'streakEditingActive',
  'readStreakForSave',
  'streakStored',
  'itemLabel',
  'resolveItemId',
  'refreshStreakPreview',
  'validateStreakDraft',
  'updateStreakNote',
  'renderStreakTable',
  'attachStreakCombos',
  'loadStreakItemOptions',
  'commitStreak',
]

const page = readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8')
// SITE95-U2: section helpers live in typed modules; extract from all sources.
const libs = [
  '../src/lib/admin-shell.ts',
  '../src/lib/admin-settings.ts',
  '../src/lib/admin-workshop.ts',
  '../src/lib/admin-overview.ts',
  '../src/lib/admin-players.ts',
  '../src/lib/admin-stats.ts',
  '../src/lib/admin-journal.ts',
  '../src/lib/admin-health.ts',
  '../src/lib/admin-console.ts',
  '../src/lib/admin-tabs.ts',
]
  .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
  .join('\n')
const script = page.split('<script>')[1].split('</script>')[0] + '\n' + libs
const source = ts.createSourceFile('admin.ts', script, ts.ScriptTarget.Latest, true)
const functions = (names) =>
  ts.transpileModule(
    source.statements
      .filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
      .map((node) => node.getText(source))
      .join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText

const markup = page.slice(page.indexOf('<main'), page.indexOf('<style'))
test('sidebar routing keeps role fallback, active link and heading focus', () => {
  const dom = new JSDOM(markup, {
    url: 'https://blockfield.test/admin#settings',
    runScripts: 'outside-only',
  })
  try {
    Object.assign(dom.window, {
      scrollTo: () => {},
      NAV_GROUPS,
      resolveTab,
      me: { role: 'moderator', permissions: ['view', 'moderate'] },
    })
    dom.window.eval(
      `const $ = (s) => document.querySelector(s); const can = (p) => me.permissions.includes(p); const sendPresence = () => {}; ${functions(['el', 'renderNav', 'showTab'])}`,
    )
    dom.window.HTMLElement.prototype.scrollIntoView = () => {}
    dom.window.renderNav()
    dom.window.showTab('settings', true)
    const { document, location } = dom.window
    assert.equal(location.hash, '#players')
    assert.equal(document.querySelector('#tabs [aria-current]').hash, '#players')
    assert.equal(document.activeElement.id, 'players-title')
    assert.equal(document.querySelectorAll('.admin-content > section:not([hidden])').length, 1)
    assert.equal(document.querySelector('#tabs a[href="#settings"]'), null)
    assert.ok(document.querySelector('[data-presence-slot="players"]'))
    assert.ok(document.querySelector('#n-online'))
  } finally {
    dom.window.close()
  }
})

test('settings receipt shows the editor name from an identity object', async () => {
  const dom = new JSDOM(markup, { runScripts: 'outside-only' })
  try {
    Object.assign(dom.window, {
      settingsReceipt,
      ...streakLib,
      structuredClone,
      api: async () => ({
        settings: { revision: 3, updatedAt: Date.now(), updatedBy: { name: 'Nether' } },
        applied: { revision: 3, attemptedRevision: 3, errors: [] },
        balance: {},
      }),
    })
    dom.window.eval(
      `const $ = (s) => document.querySelector(s); let gunOverrides = {}, selectedGun, remoteSettingsName; let lastApplied, gunRevision = 3, observedSettingsRevision = 0, rules, settingsLoaded = false, settingsRevision = 3; const ago = () => 'только что'; ${streakState()} ${functions(['say', 'settingsStatus', 'loadSettings', ...streakFns])}`,
    )
    await dom.window.loadSettings(0, true)
    assert.equal(
      dom.window.document.querySelector('#settings-state').textContent,
      'применено · Nether · только что',
    )
  } finally {
    dom.window.close()
  }
})

test('accepted action stays pending until application is confirmed', async () => {
  const dom = new JSDOM('<p id="status"></p>', { runScripts: 'outside-only' })
  try {
    dom.window.eval(functions(['say', 'run']))
    const line = dom.window.document.querySelector('#status')
    await dom.window.run(line, async () => 'применяем…')
    assert.equal(line.classList.contains('pending'), true)
    assert.equal(line.classList.contains('ok'), false)
  } finally {
    dom.window.close()
  }
})

test('live sidebar shows unavailable, empty and scored matches without placeholder text', async () => {
  const dom = new JSDOM(markup, { runScripts: 'outside-only' })
  try {
    let rooms = { available: false }
    Object.assign(dom.window, {
      api: async () => ({ status: { phase: 'game' }, rooms }),
      can: () => false,
    })
    dom.window.eval(
      `const $ = (s) => document.querySelector(s); let controller, session, lastWorkshop; const setController = (v) => controller = v; const PHASES = { VOTING: 'Голосование за карту' }; const describeGame = () => ({ tone: 'bad', title: 'недоступно', detail: '' }); const describeWorkshop = describeGame; const say = () => {}; const ago = () => 'только что'; const renderModes = () => {}; const renderRooms = () => {}; const renderWorkshopCard = () => {}; ${functions(['el', 'renderRoomSummary', 'renderGameOverview', 'renderOverview', 'loadOverview'])}`,
    )
    await dom.window.loadOverview()
    const box = dom.window.document.querySelector('#side-now')
    assert.equal(box.textContent, 'Сейчас на серверенедоступно')
    rooms = { available: true, online: 0, rooms: [] }
    await dom.window.loadOverview()
    assert.equal(box.textContent, 'Сейчас на сервереМатчей нет')
    rooms = {
      available: true,
      online: 5,
      rooms: [{ map: 'Поля', mode: 'Ranked', battle: { red: 118, blue: 87 } }],
    }
    await dom.window.loadOverview()
    assert.equal(box.querySelector('.score').textContent, '118 : 87')
    assert.equal(dom.window.document.querySelector('#s-online').textContent, '5')
    assert.equal(dom.window.document.querySelector('#s-matches').textContent, '1')
  } finally {
    dom.window.close()
  }
})

function liveDom(extra = '') {
  const dom = new JSDOM(markup, {
    url: 'https://blockfield.test/admin#settings',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  dom.window.eval(`
    const $ = s => document.querySelector(s);
    const me = { uuid: 'self', name: 'Nether', permissions: [] };
    const can = () => false;
    ${functions(['el', 'say', 'avatar', 'renderPresence', 'toast', 'controlKey', 'controlValue', 'editingSetting', 'rememberSettingsControls', 'flashSetting', 'replaceSettingsFields'])}
    const mapAvailabilityWaiters = new Set(); const settingValues = new Map(), busyControls = new WeakSet(), queuedSettings = new Map(); let remoteSettingsName = 'Kira';
    ${extra}
  `)
  Object.assign(dom.window, streakLib)
  return dom
}

test('presence excludes self, sorts names and caps sidebar avatars at three', () => {
  const dom = liveDom()
  try {
    dom.window.document.querySelector('#tabs').innerHTML =
      '<span data-presence-slot="settings"></span><span data-presence-slot="players"></span>'
    dom.window.renderPresence([
      { uuid: 'self', name: 'Nether', tab: 'settings' },
      ...['Zed', 'Kira', 'Bobr', 'Anna'].map((name) => ({ uuid: name, name, tab: 'settings' })),
      { uuid: 'player', name: 'Player', tab: 'players' },
    ])
    const doc = dom.window.document
    assert.deepEqual(
      [...doc.querySelectorAll('#who .av')].map((a) => a.title),
      ['Anna', 'Bobr', 'Kira', 'Player', 'Zed'],
    )
    assert.equal(doc.querySelectorAll('[data-presence-slot="settings"] .av').length, 3)
    assert.equal(doc.querySelector('[data-presence-slot="players"] .av').title, 'Player')
    const avatar = doc.querySelector('#who .av')
    assert.match(avatar.dataset.c, /^[1-4]$/)
    dom.window.renderPresence([{ uuid: 'Anna', name: 'Anna', tab: 'players' }])
    assert.equal(doc.querySelector('#who .av').dataset.c, avatar.dataset.c)
  } finally {
    dom.window.close()
  }
})

test('audit events prepend, deduplicate ids and retain at most 200 rows', () => {
  const dom = liveDom(`
    const sentence = a => ['выгнал', 'выгнать', ' игрока ' + a.target];
    const friendly = () => 'ошибка'; const date = () => 'UTC'; const ago = () => 'только что';
    ${functions(['auditRow', 'prependAudit'])}
  `)
  try {
    const entry = {
      id: 1,
      actorName: 'Bobr',
      action: 'rcon:kick',
      target: 'Griefer_01',
      ok: 1,
      at: Date.now(),
      detail: '{}',
    }
    dom.window.prependAudit(entry)
    dom.window.prependAudit(entry)
    assert.equal(dom.window.document.querySelectorAll('#audit-list li').length, 1)
    assert.match(
      dom.window.document.querySelector('#audit-list').textContent,
      /Bobr выгнал игрока Griefer_01/,
    )
    for (let id = 2; id <= 205; id++) dom.window.prependAudit({ ...entry, id })
    const rows = dom.window.document.querySelectorAll('#audit-list li')
    assert.equal(rows.length, 200)
    assert.equal(rows[0].dataset.auditId, '205')
    assert.equal(rows[199].dataset.auditId, '6')
  } finally {
    dom.window.close()
  }
})

test('remote settings flash changed rows and keep focused or dirty controls', () => {
  const dom = liveDom()
  try {
    const doc = dom.window.document
    const box = doc.querySelector('#room-fields')
    box.innerHTML =
      '<div class="field"><input name="maxRooms" value="2"><span class="state"></span></div>'
    dom.window.rememberSettingsControls()
    const row = () => {
      const fresh = doc.createElement('div')
      fresh.className = 'field'
      fresh.innerHTML = '<input name="maxRooms" value="6"><span class="state"></span>'
      return fresh
    }
    dom.window.replaceSettingsFields(box, true, row())
    assert.equal(box.querySelector('input').value, '6')
    assert.equal(box.querySelector('.state').textContent, 'Kira · только что')
    assert.equal(box.querySelector('.field').classList.contains('flash'), true)
    const input = box.querySelector('input')
    input.focus()
    input.value = '7'
    const fresh = row()
    fresh.querySelector('input').value = '8'
    dom.window.replaceSettingsFields(box, true, fresh)
    assert.equal(doc.activeElement, input)
    assert.equal(input.value, '7')
    input.blur()
    dom.window.replaceSettingsFields(box, true, row())
    assert.equal(box.querySelector('input'), input)
    assert.equal(input.value, '7')
  } finally {
    dom.window.close()
  }
})

test('EventSource transitions connection tone and resolves follow from request event', async () => {
  const dom = liveDom(`
    let stream;
    class EventSource extends EventTarget {
      constructor(url) { super(); if (url !== '/api/admin/events') throw Error(url); stream = this; }
      close() {}
    }
    const pendingRequests = new Map(), followTokens = new WeakMap(), requestResults = new Map();
    let presenceTimer, tpsTimer;
    const api = () => { throw Error('Unexpected recovery GET'); };
    let refreshes = 0;
    const refreshCurrentTab = () => refreshes++;
    const visibleTimers = () => {};
    const renderOverview = async () => {}; const renderRooms = () => {}; const renderRoomSummary = () => {};
    const settingsEvent = async () => {}; const prependAudit = () => {};
    ${functions(['startEvents', 'follow', 'requestResult'])}
    window.emit = (type, data) => stream.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(data) }));
    window.refreshCount = () => refreshes;
  `)
  try {
    dom.window.startEvents()
    dom.window.emit('open')
    const conn = dom.window.document.querySelector('#conn')
    assert.equal(conn.dataset.tone, 'live')
    assert.equal(conn.textContent, 'live')
    dom.window.emit('error')
    assert.equal(conn.dataset.tone, 'bad')
    assert.equal(conn.textContent, 'нет связи')
    dom.window.emit('open')
    assert.equal(conn.dataset.tone, 'live')
    assert.equal(dom.window.refreshCount(), 1)
    const line = dom.window.document.querySelector('#mode-progress')
    const done = dom.window.follow(line, 'request-1', 'применено')
    assert.equal(line.textContent, 'применяем…')
    dom.window.emit('request', { id: 'request-1', result: { ok: true } })
    await done
    assert.equal(line.textContent, 'применено')
    assert.equal(line.classList.contains('ok'), true)
  } finally {
    dom.window.close()
  }
})

test('settings event advances the revision, flashes once and keeps a focused control', async () => {
  const dom = liveDom(`
    const LOBBY = [], DEATHMATCH = [], CLASS_COSTS = {}, CLASS_NAMES = {}, PARCOOL_ACTIONS = [], PARCOOL_FILE_DEFAULT = [];
    const ROOMS = [{key:'maxRooms', label:'Матчей одновременно', min:1, max:16, def:2}];
    let rules = {}, defaults = {}, balance = {}, hadLocks, extraLocks, fieldId = 0;
    let lastApplied, gunRevision = 0, gunOverrides = {}, selectedGun; const renderGun = () => {}; let kitCatalog; let settingsLoaded = false, settingsRevision = 0, observedSettingsRevision = 0;
    const number = String, customSelect = () => {}, renderScopes = () => {}, renderBalance = () => {};
    const settingsReceipt = () => 'applied', ago = () => 'только что';
    const api = async () => ({settings:{revision:1, rooms:{maxRooms:2}}, applied:{revision:1}, balance:{}});
    const loadGunBalance = async () => {}; const ask = () => { throw Error('Unexpected discard prompt'); };
    ${functions(['field', 'numberField', 'settingsMeta', 'settingsStatus', 'loadSettings', 'settingsEvent', ...streakFns])}
    ${streakState()}
    window.structuredClone = value => JSON.parse(JSON.stringify(value));
  `)
  try {
    await dom.window.loadSettings()
    const event = (revision, maxRooms) => ({
      settings: {
        revision,
        rooms: { maxRooms },
        updatedBy: { name: 'Kira' },
        updatedAt: Date.now(),
      },
      applied: { revision },
    })
    await dom.window.settingsEvent(event(2, 6))
    const doc = dom.window.document
    assert.equal(doc.querySelector('[name=maxRooms]').value, '6')
    assert.equal(
      doc.querySelector('[name=maxRooms]').closest('.field').querySelector('.state').textContent,
      'Kira · только что',
    )
    assert.equal(doc.querySelector('#settings-meta').textContent, 'ревизия 2')
    assert.equal(doc.querySelector('#settings-state').textContent, 'применено · Kira · только что')
    assert.equal(doc.querySelector('.toast').textContent, 'Kira: настройки обновлены')
    await dom.window.settingsEvent(event(2, 6))
    assert.equal(doc.querySelectorAll('.toast').length, 1)
    const input = doc.querySelector('[name=maxRooms]')
    input.focus()
    await dom.window.settingsEvent(event(3, 8))
    assert.equal(doc.activeElement, input)
    assert.equal(input.value, '6')
    assert.equal(doc.querySelector('#settings-meta').textContent, 'ревизия 3')
    assert.equal(doc.querySelector('#settings-state').textContent, 'применено · Kira · только что')
    assert.equal(doc.querySelector('#settings-applied-by').textContent, 'Kira')
    await dom.window.settingsEvent(event(3, 8))
    assert.equal(doc.querySelectorAll('.toast').length, 2)
  } finally {
    dom.window.close()
  }
})

test('mode progress carries the step and timing without repeating the option badge', () => {
  const dom = new JSDOM(markup, { runScripts: 'outside-only' })
  try {
    dom.window.eval(
      `const $ = s => document.querySelector(s); const timing = () => 'началось только что'; ${functions(['say', 'renderProgress'])}`,
    )
    dom.window.renderProgress({ busy: true, step: 'Сохраняем мир' })
    const text = dom.window.document.querySelector('#mode-progress').textContent
    assert.equal(text, 'Сохраняем мир · началось только что')
    assert.equal(text.includes('применяем'), false)
    const legend = dom.window.document.querySelector('#role-legend')
    assert.ok(legend.closest('.group'))
  } finally {
    dom.window.close()
  }
})

test('rooms event renders the real Game headline, lamp, detail and mode readiness without fetching', () => {
  const dom = new JSDOM(markup, { runScripts: 'outside-only' })
  try {
    dom.window.eval(`
      const $ = s => document.querySelector(s);
      let controller = { schema:1, phase:'workshop', revision:1, game:{phase:'game',gate:'public'} }, session, lastWorkshop;
      const can = () => false, ago = () => 'только что';
      const gameReady = state => state.game.phase === 'game' && state.game.gate === 'public';
      const switchView = () => ({ busy:false });
      const describeWorkshop = () => ({title:'Мастерская открыта',detail:'',tone:'ok'});
      const renderRooms = () => {}, renderProgress = () => {};
      const getLastWorkshop = () => lastWorkshop;
      ${functions(['el', 'describeGame', 'renderRoomSummary', 'renderGameOverview', 'renderModes', 'workshopActions'])}
      window.handlers = {};
      const events = { addEventListener: (name, handler) => window.handlers[name] = handler };
      ${ts.transpileModule(script.slice(script.indexOf("  events.addEventListener('rooms'"), script.indexOf("  events.addEventListener(\n    'settings'", script.indexOf("  events.addEventListener('rooms'"))), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}
    `)
    const send = (rooms) => dom.window.handlers.rooms({ data: JSON.stringify({ rooms }) })
    send({ available: true, rooms: [], online: 0 })
    assert.equal(dom.window.document.querySelector('#server-headline').textContent, 'Игра работает')
    assert.equal(dom.window.document.querySelector('#lamp').dataset.tone, 'ok')
    assert.match(dom.window.document.querySelector('#mode-options').textContent, /Вход открыт/)
    send({ available: false, lobby: true })
    assert.equal(
      dom.window.document.querySelector('#server-headline').textContent,
      'Игровой сервер не отвечает',
    )
    assert.equal(dom.window.document.querySelector('#lamp').dataset.tone, 'bad')
    assert.match(
      dom.window.document.querySelector('#server-detail').textContent,
      /матчи сейчас недоступны/,
    )
    assert.match(
      dom.window.document.querySelector('#mode-options').textContent,
      /Готовность не подтверждена/,
    )
  } finally {
    dom.window.close()
  }
})
