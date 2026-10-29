import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { settingsBody, settingsReceipt } from '../src/lib/settings-form.ts'
import { weaponFields, BODY_PARTS } from '../src/lib/gun-fields.ts'
import { finalDamageVsMatchKit } from '../src/lib/gun-damage.ts'
import { bodyPartSummary, renderBodyPartField } from '../src/lib/body-part-form.ts'

const page = readFileSync(new URL('../src/pages/admin.astro', import.meta.url), 'utf8')
const script = page.split('<script>')[1].split('</script>')[0]
const source = ts.createSourceFile('admin.ts', script, ts.ScriptTarget.Latest, true)
const compile = (text) =>
  ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const names = [
  'el',
  'say',
  'friendly',
  'api',
  'field',
  'numberField',
  'controlKey',
  'controlValue',
  'setControl',
  'editingSetting',
  'rememberSettingsControls',
  'flashSetting',
  'replaceSettingsFields',
  'loadSettings',
  'settingsMeta',
  'settingsStatus',
  'collectBalance',
  'collectSettingsBody',
  'fieldState',
  'lockControl',
  'autosaveError',
  'syncParcool',
  'renderBalance',
  'renderScopes',
  'validation',
  'changeToast',
  'commitSetting',
  'autosaveKeys',
  'checkGunField',
  'commitGun',
  'gunOrphanIds',
  'renderOrphans',
  'removeOrphans',
  'gunText',
  'gunSummary',
  'gunValues',
  'gunShape',
  'renderGun',
  'gunRowValue',
  'requestResult',
  'loadGunBalance',
  'filterGuns',
  'settingsEvent',
  'follow',
  'commitMessage',
  'waitMapAvailability',
  'gunBandInsert',
  'gunBandRemove',
]
const functions = compile(
  source.statements
    .filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
    .map((n) => n.getText(source))
    .join('\n'),
)
const messageHandlers = compile(
  script.slice(
    script.indexOf(
      "    $('#message-form').addEventListener('submit'",
      script.indexOf('let savedMessage'),
    ),
    script.indexOf('    const RANGE:'),
  ),
)

async function setup(options = {}) {
  const dom = new JSDOM(page.slice(page.indexOf('<main'), page.indexOf('<style')), {
    url: 'https://blockfield.test/admin',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  let settings = { revision: 3, rooms: { maxRooms: 4 }, ...options.settings }
  const calls = []
  Object.assign(dom.window, {
    settingsBody,
    settingsReceipt,
    structuredClone,
    weaponFields,
    finalDamageVsMatchKit,
    bodyPartSummary,
    renderBodyPartField: (...args) => {
      const previous = globalThis.document
      globalThis.document = dom.window.document
      try {
        return renderBodyPartField(...args)
      } finally {
        globalThis.document = previous
      }
    },
    fetch: async (url, init) => {
      const path = url.split('/api/admin/')[1],
        body = init.body && JSON.parse(init.body)
      calls.push({ path, method: init.method, body })
      if (options.handle) {
        const result = await options.handle({ path, method: init.method, body, settings })
        if (result)
          return { ok: result.status < 400, status: result.status, json: async () => result.data }
      }
      if (path === 'gun-balance' && init.method === 'GET')
        return {
          ok: true,
          json: async () => ({ available: true, catalog: dom.window.currentGunCatalog() }),
        }
      if (init.method === 'PUT')
        settings = {
          ...body,
          revision: settings.revision + 1,
          updatedBy: { name: 'Nether' },
          updatedAt: Date.now(),
        }
      return {
        ok: true,
        json: async () =>
          path === 'message'
            ? { id: 'message-1' }
            : {
                settings,
                applied: { revision: 3 },
                balance: options.balance ? { power: { type: 'int', min: 1, max: 100 } } : {},
              },
      }
    },
  })
  dom.window.eval(`
    const $ = s => document.querySelector(s);
    const customSelect = () => {}, number = String, ago = () => 'только что';
    const LOBBY = [], DEATHMATCH = [], CLASS_COSTS = {}, CLASS_NAMES = {}, PARCOOL_ACTIONS = [], PARCOOL_FILE_DEFAULT = [];
    const ROOMS = [{key:'maxRooms', label:'Матчей одновременно', min:1, max:16, def:2}, {key:'idleCloseSeconds', label:'Закрывать пустую комнату через', min:30, max:3600, def:600}];
    const SETTING_LABELS = {}, GUN_LABELS = {};
    const GUN_VALUE_LABELS = {}, GUN_GROUP_TITLES = {};
    const gunValueLabel = (v) => v, gunGroupTitle = (t) => t;
    const gunText = value => JSON.stringify(value) ?? 'null';
    const gunPretty = (id) => id.split(':').at(-1).split(/[_/-]+/).filter(Boolean).map((part) => (/\\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1))).join(' ');
    const gunLabel = gun => gun.id; const KIT_GUNS = new Set();
    let rules = {}, defaults = {}, balance = {}, scope = '*', hadLocks, extraLocks = [], fieldId = 0;
    const mapAvailabilityWaiters = new Set(); let kitCatalog; let settingsLoaded = false, settingsRevision = 0, observedSettingsRevision = 0, lastApplied = null;
    let settingsQueue = Promise.resolve(), gunQueue = Promise.resolve(), gunPending = 0, settingsQueueVersion = 0, gunQueueVersion = 0;
    let gunCatalog, selectedGun, gunOverrides = {}, gunRevision = 0;
    const gunReaders = new Map(), settingValues = new Map(), stateTimers = new WeakMap();
    let remoteSettingsName = 'Kira'; const me = {name:'Nether'}, toastMessages = [], toast = text => toastMessages.push(text);
    window.toastMessages = toastMessages;
    const BALANCE_DEFAULTS = {room:{power:10},c:{power:20}}, BALANCE_SCOPES = [{id:'*',name:'Все матчи'},{id:'c',name:'Кампания'}];
    const BALANCE_GROUPS = ${JSON.stringify(options.balance ? [{ title: 'Баланс', fields: [{ key: 'power', label: 'Сила' }] }] : [])};
    const scopeDefault = (key, selectedScope = scope) => selectedScope === '*' ? BALANCE_DEFAULTS.room[key] : balance['*']?.[key] ?? BALANCE_DEFAULTS[selectedScope][key];
    const busyControls = new WeakSet(), queuedSettings = new Map();
    const pendingRequests = new Map(), followTokens = new WeakMap(), requestResults = new Map();
    let savedMessage = ${JSON.stringify(options.message ?? '')}, messageInFlight = false, messageTimer;
    ${functions}
    autosaveKeys($('#settings-form')); autosaveKeys($('#gun-balance-form'));
    $('#settings-form').addEventListener('change', e => commitSetting(e.target));
    ${messageHandlers}
    window.gunSetup = () => { gunCatalog = {fields:{fields:{damage:{type:'number',min:0,max:100,nullable:false},nested:{type:'object',nullable:false,fields:{rate:{type:'integer',nullable:false,min:1,max:10}}}}}}; selectedGun = {id:'bf:test',data:'bf:test',type:'rifle',defaults:{damage:10,nested:{rate:2}},warnings:[],name:'Test'}; gunCatalog.guns = [selectedGun, {id:'bf:other',data:'bf:other',type:'rifle',defaults:{damage:10,nested:{rate:2}},warnings:[],name:'Other'}]; renderGun(); };
    window.gunAliasSetup = () => { gunCatalog.guns.push({id:'bf:test_alias',data:'bf:test',type:'rifle',defaults:{damage:10,nested:{rate:2}},warnings:[],name:'Alias'}); renderGun(); };
    window.gunBulletSetup = () => { gunCatalog = {fields:{fields:{bullet:{type:'object',nullable:false,fields:{damage:{type:'number',nullable:false,min:0,max:100},penetrating:{type:'boolean',nullable:false}}},rpm:{type:'integer',nullable:false,min:1,max:1200}}}}; selectedGun = {id:'bf:test',data:'bf:test',type:'rifle',defaults:{bullet:{damage:8,penetrating:false},rpm:600},warnings:[],name:'Test'}; gunCatalog.guns = [selectedGun]; renderGun(); };
    window.gunComplexSetup = (schemaJson, defaultsJson) => { gunCatalog = {fields:JSON.parse(schemaJson)}; const defaults = JSON.parse(defaultsJson); selectedGun = {id:'tacz:ak47',data:'tacz:ak47_data',type:'rifle',weaponKind:'tacz',sourceId:'tacz:ak47',defaults,warnings:[],name:'Test'}; selectedGun.effective = structuredClone(defaults); gunCatalog.guns = [selectedGun]; renderGun(); };
    window.gunBandFns = { insert: gunBandInsert, remove: gunBandRemove };
    window.bodySetup = (kind) => {
      window.gunSetup();
      const defaults = ${JSON.stringify(Object.fromEntries(BODY_PARTS.map((part) => [part, 1])))};
      gunCatalog.bodyPartsEnabled = false;
      gunCatalog.fields.fields.body_part_multipliers = ${JSON.stringify({ type: 'object', nullable: false, fields: Object.fromEntries(BODY_PARTS.map((part) => [part, { type: 'number', nullable: false, min: 0, max: 10 }])) })};
      const path = kind === 'melee' ? 'dagger' : 'test';
      selectedGun = {id:kind+':lrtactical/'+path,data:kind+':lrtactical/'+path,sourceId:'lrtactical:'+path,weaponKind:kind,type:kind,defaults:{body_part_multipliers:defaults},warnings:[],name:'Test'};
      gunCatalog.guns = [selectedGun];
      renderGun();
    };
    window.currentGunCatalog = () => gunCatalog;
    $('#scope').addEventListener('change', e => {scope=e.target.value;renderScopes();renderBalance();rememberSettingsControls('#balance-fields')});
    window.flush = () => Promise.all([settingsQueue, gunQueue]);
    window.finishMessage = result => requestResult('message-1', result);
    window.receiptCache = () => [...requestResults.keys()];
  `)
  await dom.window.loadSettings()
  calls.length = 0
  return {
    dom,
    calls,
    input: dom.window.document.querySelector('[name=maxRooms]'),
    change(control, value) {
      control.value = value
      control.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    },
  }
}

test('change commits one field, uses revision and undo commits the old value', async () => {
  const { dom, calls, input, change } = await setup()
  try {
    change(input, '6')
    await dom.window.flush()
    assert.equal(calls[0].method, 'PUT')
    assert.equal(calls[0].body.expectedRevision, 3)
    assert.equal(calls[0].body.rooms.maxRooms, 6)
    assert.equal(input.closest('.field').querySelector('.state').textContent, 'сохранено')
    assert.equal(
      dom.window.document.querySelector('.toast').textContent,
      'Матчей одновременно: 4 → 6Отменить',
    )
    dom.window.document.querySelector('.toast button').click()
    await dom.window.flush()
    assert.equal(input.value, '4')
    assert.equal(dom.window.document.activeElement, input)
    assert.equal(calls[1].body.rooms.maxRooms, 4)
    assert.equal(calls[1].body.expectedRevision, 4)
  } finally {
    dom.window.close()
  }
})

test('invalid and empty numbers show a range without a request', async () => {
  const { dom, calls, input, change } = await setup()
  try {
    for (const value of ['17', '']) {
      change(input, value)
      await dom.window.flush()
      assert.equal(calls.length, 0)
      const line = input.closest('.field').querySelector('.state')
      assert.equal(line.textContent, 'от 1 до 16')
      assert.equal(line.dataset.s, 'error')
      assert.equal(line.getAttribute('role'), 'status')
    }
  } finally {
    dom.window.close()
  }
})

test('409 refreshes untouched fields and retries once with the fresh revision', async () => {
  let puts = 0
  const { dom, calls, input, change } = await setup({
    handle: ({ method }) => {
      if (method === 'PUT' && ++puts === 1)
        return { status: 409, data: { error: 'stale revision' } }
      if (method === 'GET' && puts)
        return {
          status: 200,
          data: {
            settings: { revision: 8, rooms: { maxRooms: 5, idleCloseSeconds: 90 } },
            applied: { revision: 8 },
          },
        }
    },
  })
  try {
    change(input, '6')
    await dom.window.flush()
    assert.deepEqual(
      calls.map((c) => c.method),
      ['PUT', 'GET', 'PUT'],
    )
    assert.equal(calls[2].body.expectedRevision, 8)
    assert.equal(calls[2].body.rooms.maxRooms, 6)
    assert.equal(calls[2].body.rooms.idleCloseSeconds, 90)
    assert.equal(input.value, '6')
  } finally {
    dom.window.close()
  }
})

test('second conflict stops retrying and restores the last server value', async () => {
  let puts = 0
  const { dom, calls, input, change } = await setup({
    handle: ({ method }) => {
      if (method === 'PUT') {
        puts++
        return { status: 409, data: { error: 'stale revision' } }
      }
      if (puts)
        return {
          status: 200,
          data: { settings: { revision: 8, rooms: { maxRooms: 5 } }, applied: { revision: 8 } },
        }
    },
  })
  try {
    change(input, '6')
    await dom.window.flush()
    assert.equal(puts, 2)
    assert.equal(calls.length, 3)
    assert.equal(input.value, '5')
    assert.equal(input.closest('.field').querySelector('.state').dataset.s, 'error')
  } finally {
    dom.window.close()
  }
})

test('queued changes use the next revision and exclude another invalid edit', async () => {
  let finish
  const { dom, calls, input, change } = await setup({
    handle: async ({ method }) => {
      if (method === 'PUT' && !finish)
        await new Promise((resolve) => {
          finish = resolve
        })
    },
  })
  try {
    change(input, '6')
    await Promise.resolve()
    const second = dom.window.document.querySelector('[name=idleCloseSeconds]')
    change(second, '90')
    input.value = '17'
    finish()
    await dom.window.flush()
    assert.equal(calls.length, 2)
    assert.equal(calls[1].body.expectedRevision, 4)
    assert.equal(calls[1].body.rooms.maxRooms, 6)
    assert.equal(calls[1].body.rooms.idleCloseSeconds, 90)
  } finally {
    dom.window.close()
  }
})

test('weapon inputs always show the effective value; editing back to default or reset removes the override', async () => {
  const { dom, calls, change } = await setup()
  try {
    dom.window.gunSetup()
    const doc = dom.window.document
    let input = doc.querySelector('#gun-field-damage')
    let row = input.closest('.field')
    assert.equal(input.disabled, false)
    change(input, '20')
    await dom.window.flush()
    assert.equal(calls[0].path, 'gun-balance')
    assert.equal(calls[0].method, 'PUT')
    assert.equal(calls[0].body.expectedRevision, 3)
    assert.equal(calls[0].body.gunBalance['bf:test'].damage, 20)
    assert.equal(row.hasAttribute('data-override'), true)
    assert.equal(row.querySelector('.gun-badge').hidden, false)
    assert.equal(row.querySelector('.gun-reset').hidden, false)
    assert.equal(doc.querySelector('.toast span').textContent, 'damage: 10 → 20')
    doc.querySelector('.toast button').click()
    await dom.window.flush()
    assert.deepEqual(calls[1].body.gunBalance, {})
    input = doc.querySelector('#gun-field-damage')
    row = input.closest('.field')
    change(input, '25')
    await dom.window.flush()
    change(input, '10')
    await dom.window.flush()
    assert.deepEqual(calls[3].body.gunBalance, {})
    assert.equal(calls[3].body.expectedRevision, 6)
    assert.equal(row.hasAttribute('data-override'), false)
    assert.equal(row.querySelector('.gun-badge').hidden, true)
    assert.equal(row.querySelector('.gun-reset').hidden, true)
    assert.equal(input.value, '10')
    assert.equal(input.placeholder, '10')
    assert.equal(
      [...doc.querySelectorAll('.toast span')].at(-1).textContent,
      'damage: 25 → как в ганпаке',
    )
    change(input, '30')
    await dom.window.flush()
    assert.equal(
      doc.querySelector('#gun-field-damage').closest('.field').hasAttribute('data-override'),
      true,
    )
    doc.querySelector('#gun-field-damage').closest('.field').querySelector('.gun-reset').click()
    await dom.window.flush()
    assert.deepEqual(calls.at(-1).body.gunBalance, {})
    assert.equal(doc.querySelector('#gun-field-damage').value, '10')
  } finally {
    dom.window.close()
  }
})

test('bullet scalars render as plain main rows while the full JSON editor stays out of the way', async () => {
  const { dom, calls, change } = await setup()
  try {
    dom.window.gunBulletSetup()
    const doc = dom.window.document
    const damage = doc.querySelector('#gun-field-bullet-damage')
    assert.equal(damage.value, '8')
    assert.ok(damage.closest('.field').querySelector('label').textContent.includes('Урон'))
    assert.equal(doc.querySelector('#gun-advanced').hidden, true)
    change(damage, '9')
    await dom.window.flush()
    assert.deepEqual(calls[0].body.gunBalance['bf:test'], {
      bullet: { damage: 9, penetrating: false },
    })
    assert.equal(doc.querySelector('.toast span').textContent, 'Урон: 8 → 9')
    assert.equal(doc.querySelector('#gun-field-bullet-penetrating').checked, false)
    change(doc.querySelector('#gun-field-bullet-damage'), '8')
    await dom.window.flush()
    assert.deepEqual(calls[1].body.gunBalance, {})
  } finally {
    dom.window.close()
  }
})

test('complex weapon fields render as structured controls without any JSON textarea', async () => {
  const { dom, calls, change } = await setup()
  try {
    dom.window.gunSetup()
    const doc = dom.window.document
    assert.equal(doc.querySelector('#gun-fields textarea'), null)
    assert.equal(doc.querySelector('#gun-advanced-fields textarea'), null)
    const rate = doc.querySelector('#gun-field-nested-rate')
    assert.ok(rate)
    assert.equal(rate.value, '2')
    assert.equal(rate.min, '1')
    assert.equal(rate.max, '10')
    assert.equal(doc.querySelector('#gun-advanced').hidden, false)
    change(rate, '50')
    assert.equal(calls.length, 0)
    const row = rate.closest('.field')
    assert.equal(row.querySelector('.state').dataset.s, 'error')
    assert.equal(row.querySelector('.state').textContent, 'от 1 до 10')
    change(rate, '3')
    await dom.window.flush()
    assert.deepEqual(calls[0].body.gunBalance['bf:test'].nested, { rate: 3 })
    assert.equal(doc.querySelector('.toast span').textContent, 'Параметр: rate: 2 → rate: 3')
    assert.equal(row.querySelector('.state').textContent, 'сохранено')
  } finally {
    dom.window.close()
  }
})

test('item, throwable and melee controls join weapon autosave, reset and undo without exposing native fields', async () => {
  for (const kind of ['item', 'throwable', 'melee']) {
    const { dom, calls, change } = await setup()
    try {
      dom.window.bodySetup(kind)
      const doc = dom.window.document
      const head = doc.querySelector('#body-part-head')
      const row = head.closest('.body-part-row')
      const toggle = row.querySelector('[type=checkbox]')
      assert.equal(doc.querySelector('#gun-field-damage'), null)
      assert.equal(doc.querySelector('#gun-fields textarea'), null)
      assert.equal(row.querySelectorAll('[type=number]').length, 6)
      toggle.checked = true
      toggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
      await dom.window.flush()
      assert.equal(calls.length, 0)
      assert.equal(doc.activeElement, head)
      change(head, '2')
      await dom.window.flush()
      const saved = calls.find((call) => call.method === 'PUT')
      assert.equal(saved.path, 'gun-balance')
      assert.equal(saved.body.expectedRevision, 3)
      assert.deepEqual(
        saved.body.gunBalance[`${kind}:lrtactical/${kind === 'melee' ? 'dagger' : 'test'}`],
        { body_part_multipliers: { head: 2 } },
      )
      assert.equal(row.querySelector('.state').textContent, 'сохранено')
      assert.equal(doc.querySelector('#body-part-head'), head)
      assert.equal(row.querySelector('.gun-badge').hidden, false)
      assert.equal(
        doc.querySelector('.toast span').textContent,
        'Урон по частям тела: Все части ×1 → Голова ×2',
      )
      doc.querySelector('.toast button').click()
      await dom.window.flush()
      const writes = calls.filter((call) => call.method === 'PUT')
      assert.deepEqual(writes[1].body.gunBalance, {})
      assert.equal(doc.querySelector('#body-part-head').disabled, true)
      assert.equal(doc.activeElement.id, 'gun-field-body_part_multipliers')
    } finally {
      dom.window.close()
    }
  }
})

test('invalid body drafts survive live refresh without a write and API refusal restores the confirmed coefficient', async () => {
  const { dom, calls, change } = await setup({
    handle: ({ method, path }) =>
      method === 'PUT' && path === 'gun-balance'
        ? { status: 403, data: { error: 'Нет доступа' } }
        : null,
  })
  try {
    dom.window.bodySetup('throwable')
    const doc = dom.window.document
    const head = doc.querySelector('#body-part-head')
    const row = head.closest('.body-part-row')
    const toggle = row.querySelector('[type=checkbox]')
    toggle.checked = true
    toggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    change(head, '')
    assert.equal(calls.length, 0)
    assert.equal(row.querySelector('.state').dataset.s, 'error')
    dom.window.renderGun(true)
    assert.equal(doc.querySelector('#body-part-head'), head)
    assert.equal(head.value, '')
    change(head, '2')
    await dom.window.flush()
    assert.equal(row.querySelector('.state').dataset.s, 'error')
    assert.equal(head.value, '1')
    assert.equal(head.disabled, true)
    assert.equal(toggle.checked, false)
  } finally {
    dom.window.close()
  }
})

test('changing the last body override back to one removes it and leaves all numeric controls disabled after the save lock releases', async () => {
  const { dom, calls, change } = await setup()
  try {
    dom.window.bodySetup('item')
    const head = dom.window.document.querySelector('#body-part-head')
    const row = head.closest('.body-part-row')
    const toggle = row.querySelector('[type=checkbox]')
    toggle.checked = true
    toggle.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    change(head, '2')
    await dom.window.flush()
    change(head, '1')
    await dom.window.flush()
    assert.deepEqual(calls.filter((call) => call.method === 'PUT').at(-1).body.gunBalance, {})
    assert.equal(toggle.checked, false)
    assert.equal(
      [...row.querySelectorAll('[type=number]')].every((input) => input.disabled),
      true,
    )
  } finally {
    dom.window.close()
  }
})

test('message idle commits trimmed text once and follows the application receipt', async () => {
  const { dom, calls } = await setup()
  try {
    const input = dom.window.document.querySelector('#message')
    input.value = '  Обновляем карты  '
    input.dispatchEvent(new dom.window.Event('input'))
    await new Promise((resolve) => setTimeout(resolve, 1250))
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body, { message: 'Обновляем карты' })
    const line = dom.window.document.querySelector('#message-form .form-status')
    assert.equal(line.textContent, 'применяем…')
    dom.window.finishMessage({ ok: true })
    await Promise.resolve()
    assert.equal(line.textContent, 'применено')
    input.dispatchEvent(new dom.window.Event('blur'))
    await Promise.resolve()
    assert.equal(calls.length, 1)
  } finally {
    dom.window.close()
  }
})

test('balance changes retain their scope while another scope is displayed', async () => {
  let finish
  const { dom, calls, change } = await setup({
    balance: true,
    handle: async ({ method }) => {
      if (method === 'PUT' && !finish)
        await new Promise((resolve) => {
          finish = resolve
        })
    },
  })
  try {
    change(dom.window.document.querySelector('[name=b_power]'), '15')
    await Promise.resolve()
    change(dom.window.document.querySelector('#scope'), 'c')
    change(dom.window.document.querySelector('[name=b_power]'), '25')
    finish()
    await dom.window.flush()
    assert.deepEqual(calls[0].body.campaignBalance, { '*': { power: 15 } })
    assert.deepEqual(calls[1].body.campaignBalance, { '*': { power: 15 }, c: { power: 25 } })
    assert.equal(calls[1].body.expectedRevision, 4)
  } finally {
    dom.window.close()
  }
})

test('focused control retains focus during its commit and other controls remain enabled', async () => {
  let finish
  const { dom, calls, input, change } = await setup({
    handle: async ({ method }) => {
      if (method === 'PUT')
        await new Promise((resolve) => {
          finish = resolve
        })
    },
  })
  try {
    input.focus()
    change(input, '6')
    await Promise.resolve()
    assert.equal(dom.window.document.activeElement, input)
    assert.equal(input.getAttribute('aria-disabled'), 'true')
    assert.equal(input.readOnly, true)
    assert.equal(dom.window.document.querySelector('[name=idleCloseSeconds]').disabled, false)
    assert.equal(calls.length, 1)
    finish()
    await dom.window.flush()
    assert.equal(input.readOnly, false)
    assert.equal(dom.window.document.activeElement, input)
  } finally {
    dom.window.close()
  }
})

test('returning a queued field to its saved value still commits after the earlier change', async () => {
  let finish
  const { dom, calls, input, change } = await setup({
    handle: async ({ method }) => {
      if (method === 'PUT' && !finish)
        await new Promise((resolve) => {
          finish = resolve
        })
    },
  })
  try {
    change(input, '6')
    await Promise.resolve()
    const second = dom.window.document.querySelector('[name=idleCloseSeconds]')
    change(second, '90')
    change(second, '600')
    finish()
    await dom.window.flush()
    assert.equal(calls.length, 3)
    assert.equal(calls[1].body.rooms.idleCloseSeconds, 90)
    assert.equal(calls[2].body.rooms.idleCloseSeconds, undefined)
    assert.equal(calls[2].body.expectedRevision, 5)
  } finally {
    dom.window.close()
  }
})

test('weapon conflict retries with the fresh revision and preserves other weapons', async () => {
  let puts = 0
  const { dom, calls, change } = await setup({
    handle: ({ method }) => {
      if (method === 'PUT' && ++puts === 1)
        return { status: 409, data: { error: 'stale revision' } }
      if (method === 'GET' && puts)
        return {
          status: 200,
          data: {
            settings: { revision: 9, gunBalance: { 'bf:other': { damage: 5 } } },
            applied: { revision: 9 },
          },
        }
    },
  })
  try {
    dom.window.gunSetup()
    const doc = dom.window.document
    change(doc.querySelector('#gun-field-damage'), '15')
    await dom.window.flush()
    assert.deepEqual(
      calls.map((c) => c.method),
      ['PUT', 'GET', 'PUT'],
    )
    assert.equal(calls[2].body.expectedRevision, 9)
    assert.equal(calls[2].body.gunBalance['bf:other'].damage, 5)
    change(doc.querySelector('#gun-field-damage'), '20')
    await dom.window.flush()
    assert.equal(calls[3].body.gunBalance['bf:test'].damage, 20)
  } finally {
    dom.window.close()
  }
})

test('live weapon catalog refresh keeps a focused draft and refetches both sources', async () => {
  const { dom, calls } = await setup()
  try {
    dom.window.gunSetup()
    const doc = dom.window.document,
      input = doc.querySelector('#gun-field-damage')
    input.focus()
    input.value = '17'
    await dom.window.settingsEvent({
      settings: { revision: 4, rooms: { maxRooms: 4 }, updatedBy: { name: 'Kira' } },
      applied: { revision: 4 },
      gunBalance: true,
    })
    assert.equal(doc.activeElement, input)
    assert.equal(doc.querySelector('#gun-field-damage'), input)
    assert.equal(input.value, '17')
    assert.deepEqual(
      calls.map((c) => [c.path, c.method]),
      [
        ['gun-balance', 'GET'],
        ['settings', 'GET'],
      ],
    )
    assert.equal(doc.querySelector('#gun-balance-status').textContent, '2 оружия в каталоге')
  } finally {
    dom.window.close()
  }
})

test('remote weapon overrides survive the next weapon commit and dirty catalog refresh', async () => {
  const { dom, calls, change } = await setup()
  try {
    dom.window.gunSetup()
    const doc = dom.window.document
    const draft = doc.querySelector('#gun-field-nested-rate')
    draft.value = '50'
    await dom.window.settingsEvent({
      settings: {
        revision: 7,
        gunBalance: { 'bf:other': { damage: 5 }, 'bf:test': { damage: 12 } },
      },
    })
    assert.equal(doc.querySelector('#gun-field-nested-rate'), draft)
    assert.equal(draft.value, '50')
    assert.equal(
      doc.querySelector('#gun-field-damage').closest('.field').hasAttribute('data-override'),
      true,
    )
    change(doc.querySelector('#gun-field-damage'), '20')
    await dom.window.flush()
    assert.equal(calls[0].body.expectedRevision, 7)
    assert.equal(calls[0].body.gunBalance['bf:other'].damage, 5)
    await dom.window.loadGunBalance()
    assert.equal(doc.querySelector('#gun-field-nested-rate'), draft)
  } finally {
    dom.window.close()
  }
})

test('delayed settings response cannot replace a newer event baseline or receipt', async () => {
  let finish
  const { dom, calls, input, change } = await setup({
    handle: async ({ method }) => {
      if (method === 'PUT' && !finish)
        return await new Promise((resolve) => {
          finish = () =>
            resolve({
              status: 200,
              data: { settings: { revision: 4, rooms: { maxRooms: 6 } }, applied: { revision: 4 } },
            })
        })
    },
  })
  try {
    change(input, '6')
    await Promise.resolve()
    await dom.window.settingsEvent({
      settings: { revision: 5, rooms: { maxRooms: 8 }, updatedBy: { name: 'Kira' } },
      applied: { revision: 5 },
    })
    finish()
    await dom.window.flush()
    assert.match(dom.window.document.querySelector('#settings-state').textContent, /Kira/)
    change(dom.window.document.querySelector('[name=idleCloseSeconds]'), '90')
    await dom.window.flush()
    assert.equal(calls[1].body.expectedRevision, 5)
    assert.equal(calls[1].body.rooms.maxRooms, 8)
  } finally {
    dom.window.close()
  }
})

test('scope switching never remembers unrelated invalid or uncommitted drafts', async () => {
  for (const value of ['7', '']) {
    const { dom, calls, input, change } = await setup({ balance: true })
    try {
      input.value = value
      change(dom.window.document.querySelector('#scope'), 'c')
      change(dom.window.document.querySelector('[name=idleCloseSeconds]'), '90')
      await dom.window.flush()
      assert.equal(calls[0].body.rooms.maxRooms, 4)
      assert.equal(input.value, value)
    } finally {
      dom.window.close()
    }
  }
})

test('undo drops a settings operation superseded by another editor', async () => {
  const { dom, calls, input, change } = await setup()
  try {
    change(input, '6')
    await dom.window.flush()
    await dom.window.settingsEvent({
      settings: { revision: 5, rooms: { maxRooms: 8 }, updatedBy: { name: 'Kira' } },
      applied: { revision: 5 },
    })
    dom.window.document.querySelector('.toast button').click()
    await dom.window.flush()
    assert.equal(calls.length, 1)
    assert.equal(dom.window.document.querySelector('[name=maxRooms]').value, '8')
    assert.equal(dom.window.document.querySelector('.toast'), null)
    assert.equal(dom.window.toastMessages.at(-1), 'Матчей одновременно: значение уже изменил Kira')
  } finally {
    dom.window.close()
  }
})

test('early request receipts resolve immediately and cache only the last 50 ids', async () => {
  const { dom, calls } = await setup()
  try {
    for (let i = 0; i < 60; i++) dom.window.requestResult('early-' + i, { ok: true })
    assert.equal(dom.window.receiptCache().length, 50)
    const line = dom.window.document.querySelector('#message-form .form-status')
    assert.equal((await dom.window.follow(line, 'early-59', 'применено')).ok, true)
    assert.equal(line.textContent, 'применено')
    assert.equal(dom.window.receiptCache().includes('early-59'), false)
    assert.equal(calls.length, 0)
  } finally {
    dom.window.close()
  }
})

test('failed message receipts allow retrying identical text', async () => {
  const { dom, calls } = await setup()
  try {
    const input = dom.window.document.querySelector('#message')
    input.value = 'Технические работы'
    const first = dom.window.commitMessage()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    dom.window.finishMessage({ ok: false, error: 'failed' })
    await first
    const second = dom.window.commitMessage()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    dom.window.finishMessage({ ok: true })
    await second
    assert.equal(calls.length, 2)
  } finally {
    dom.window.close()
  }
})

test('delayed weapon response preserves newer overrides for the following save', async () => {
  let finish
  const { dom, calls, change } = await setup({
    handle: async ({ method, path }) => {
      if (method === 'PUT' && path === 'gun-balance' && !finish)
        return await new Promise((resolve) => {
          finish = () =>
            resolve({
              status: 200,
              data: {
                settings: { revision: 4, gunBalance: { 'bf:test': { damage: 20 } } },
                applied: { revision: 4 },
              },
            })
        })
    },
  })
  try {
    dom.window.gunSetup()
    const doc = dom.window.document
    const input = doc.querySelector('#gun-field-damage')
    change(input, '20')
    await Promise.resolve()
    await dom.window.settingsEvent({
      settings: {
        revision: 5,
        gunBalance: { 'bf:test': { damage: 25 }, 'bf:other': { damage: 7 } },
      },
      applied: { revision: 5 },
    })
    finish()
    await dom.window.flush()
    change(input, '30')
    await dom.window.flush()
    assert.equal(calls[1].body.expectedRevision, 5)
    assert.equal(calls[1].body.gunBalance['bf:other'].damage, 7)
    assert.equal(doc.querySelector('.toast span').textContent, 'damage: 10 → 20')
  } finally {
    dom.window.close()
  }
})

test('weapon reset undo compares the entire saved gun object', async () => {
  const { dom, calls } = await setup({ settings: { gunBalance: { 'bf:test': { damage: 20 } } } })
  try {
    dom.window.gunSetup()
    const doc = dom.window.document
    await dom.window.commitGun(
      doc.querySelector('#gun-reset'),
      doc.querySelector('#gun-balance-status'),
      'bf:test',
      null,
      undefined,
      () => {},
      () => {},
      'Оружие',
    )
    await dom.window.settingsEvent({
      settings: {
        revision: 5,
        gunBalance: { 'bf:test': { nested: { rate: 4 } } },
        updatedBy: 'Kira',
      },
      applied: { revision: 5 },
    })
    doc.querySelector('.toast button').click()
    await dom.window.flush()
    assert.equal(calls.length, 1)
  } finally {
    dom.window.close()
  }
})

test('orphaned gun overrides are bannered, kept out of saves and removable', async () => {
  const { dom, calls, change } = await setup({
    settings: { gunBalance: { 'bf:ghost': { damage: 5 } } },
  })
  try {
    dom.window.gunSetup()
    const doc = dom.window.document
    await dom.window.loadGunBalance()
    const box = doc.querySelector('#gun-orphans')
    assert.equal(box.hidden, false)
    assert.ok(box.textContent.includes('bf:ghost'))
    // A normal save succeeds without the orphan and drops it from the stored map.
    change(doc.querySelector('#gun-field-damage'), '15')
    await dom.window.flush()
    const put = calls.find((c) => c.method === 'PUT' && c.path === 'gun-balance')
    assert.ok(put)
    assert.deepEqual(Object.keys(put.body.gunBalance), ['bf:test'])
    assert.equal(box.hidden, true)
    // A re-seeded orphan is removed explicitly through its button.
    await dom.window.loadSettings(0, false, {
      settings: { revision: 9, gunBalance: { 'bf:ghost': { damage: 5 } } },
    })
    dom.window.filterGuns(true)
    assert.equal(box.hidden, false)
    doc.querySelector('#gun-orphans button').click()
    for (let i = 0; i < 100 && !box.hidden; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(box.hidden, true)
    const puts = calls.filter((c) => c.method === 'PUT' && c.path === 'gun-balance')
    assert.deepEqual(Object.keys(puts.at(-1).body.gunBalance), [])
    // An index sharing native data names the alias it runs with.
    dom.window.gunAliasSetup()
    assert.ok(doc.querySelector('#gun-about').textContent.includes('bf:test_alias'))
  } finally {
    dom.window.close()
  }
})

test('403 cancels queued settings writes and displays the permission message', async () => {
  let finish
  const { dom, calls, input, change } = await setup({
    handle: async ({ method }) => {
      if (method === 'PUT')
        return await new Promise((resolve) => {
          finish = () => resolve({ status: 403, data: { error: 'Недостаточно прав' } })
        })
    },
  })
  try {
    change(input, '6')
    await Promise.resolve()
    change(dom.window.document.querySelector('[name=idleCloseSeconds]'), '90')
    finish()
    await dom.window.flush()
    assert.equal(calls.length, 1)
    assert.equal(
      input.closest('.field').querySelector('.state').textContent,
      'Недостаточно прав. Попросите администратора.',
    )
  } finally {
    dom.window.close()
  }
})

test('balance undo detects remote edits while a different scope is displayed', async () => {
  const { dom, calls, change } = await setup({ balance: true })
  try {
    const doc = dom.window.document
    change(doc.querySelector('[name=b_power]'), '15')
    await dom.window.flush()
    change(doc.querySelector('#scope'), 'c')
    await dom.window.settingsEvent({
      settings: { revision: 5, campaignBalance: { '*': { power: 18 } } },
      applied: { revision: 5 },
    })
    doc.querySelector('.toast button').click()
    await dom.window.flush()
    assert.equal(calls.length, 1)
    assert.equal(doc.querySelector('#scope').value, 'c')
    assert.equal(dom.window.toastMessages.at(-1), 'Сила: значение уже изменил кто-то')
  } finally {
    dom.window.close()
  }
})

test('message undo refuses a newer server message', async () => {
  const { dom, calls } = await setup({ message: 'Прежнее сообщение' })
  try {
    const input = dom.window.document.querySelector('#message')
    input.value = 'Новое сообщение'
    const done = dom.window.commitMessage()
    await Promise.resolve()
    dom.window.finishMessage({ ok: true })
    await done
    assert.equal(
      dom.window.document.querySelector('.toast span').textContent,
      'Сообщение мастерской: Прежнее сообщение → Новое сообщение',
    )
    dom.window.api = async () => ({ status: { message: 'Чужая правка' } })
    dom.window.document.querySelector('.toast button').click()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.length, 1)
    assert.equal(input.value, 'Новое сообщение')
    assert.equal(dom.window.toastMessages.at(-1), 'Сообщение уже изменено. Отмена недоступна.')
  } finally {
    dom.window.close()
  }
})

test('map availability resolves from the settings stream and uses only one deadline recovery GET', async () => {
  const { dom, calls } = await setup()
  try {
    let deadline
    dom.window.setTimeout = (callback) => {
      deadline = callback
      return 1
    }
    dom.window.clearTimeout = () => {}
    const pending = dom.window.waitMapAvailability(4, 'test:map', true)
    await dom.window.settingsEvent({ settings: { revision: 4 }, applied: { revision: 3 } })
    assert.equal(calls.length, 0)
    await dom.window.settingsEvent({
      settings: { revision: 4 },
      applied: { revision: 4, errors: [], disabledMapIds: ['test:map'] },
    })
    assert.equal(await pending, true)
    assert.equal(calls.length, 0)
    const recovery = dom.window.waitMapAvailability(5, 'test:map', false)
    await deadline()
    assert.equal(await recovery, false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET')
  } finally {
    dom.window.close()
  }
})

test('arrays, maps, nullable objects and json render without textareas; damage popover shows the AK math', async () => {
  const { dom, calls } = await setup()
  try {
    const schema = {
      fields: {
        bullet: {
          type: 'object',
          nullable: false,
          fields: {
            damage: { type: 'number', nullable: false, min: 0, max: 10000 },
            extra_damage: {
              type: 'object',
              nullable: true,
              fields: {
                armor_ignore: { type: 'number', nullable: false, min: 0, max: 1 },
                head_shot_multiplier: { type: 'number', nullable: false, min: 0, max: 10000 },
                damage_adjust: {
                  type: 'array',
                  nullable: false,
                  items: {
                    type: 'object',
                    nullable: false,
                    fields: {
                      distance: {
                        type: 'number',
                        nullable: false,
                        min: 0,
                        max: 10000,
                        acceptsInfinite: true,
                      },
                      damage: { type: 'number', nullable: false, min: 0, max: 10000 },
                    },
                  },
                },
              },
            },
          },
        },
        fire_mode: {
          type: 'array',
          nullable: false,
          items: { type: 'string', nullable: false, values: ['auto', 'semi', 'burst'] },
        },
        inaccuracy: {
          type: 'map',
          nullable: true,
          keys: { type: 'string', nullable: false, values: ['stand', 'aim'] },
          items: { type: 'number', nullable: false, min: 0, max: 10000 },
        },
        heat: {
          type: 'object',
          nullable: true,
          fields: { max: { type: 'number', nullable: false, min: 0.001, max: 100000 } },
        },
        script_param: {
          type: 'map',
          nullable: true,
          keys: { type: 'string', nullable: false },
          items: { type: 'json', nullable: true },
        },
      },
    }
    const defaults = {
      bullet: {
        damage: 9,
        extra_damage: {
          armor_ignore: 0.3,
          head_shot_multiplier: 1.5,
          damage_adjust: [{ distance: 15, damage: 7 }],
        },
      },
      fire_mode: ['semi', 'auto'],
      inaccuracy: { stand: 4.5, aim: 4 },
      heat: null,
      script_param: { reload_feed: 1.55 },
    }
    dom.window.gunComplexSetup(JSON.stringify(schema), JSON.stringify(defaults))
    const doc = dom.window.document
    assert.equal(doc.querySelector('#gun-fields textarea'), null)
    assert.equal(doc.querySelector('#gun-advanced-fields textarea'), null)
    // Урон — плоская строка с подсказкой.
    const damage = doc.querySelector('#gun-field-bullet-damage')
    assert.equal(damage.placeholder, '9')
    // Лента задана: у базы нет «?», хинт поясняет fallback; «?» — в шапке таблицы.
    assert.ok(
      damage
        .closest('.field')
        .querySelector('label small')
        .textContent.includes('только если урон по дистанциям не задан'),
    )
    assert.equal(damage.closest('.ctl').querySelector('.gun-dmg-btn'), null)
    const bandRow = [...doc.querySelectorAll('#gun-fields .field')].find(
      (row) => row.title === 'bullet-extra_damage-damage_adjust',
    )
    assert.ok(bandRow)
    const dmgBtn = bandRow.querySelector('label .gun-dmg-btn')
    assert.ok(dmgBtn)
    assert.equal(
      dmgBtn.getAttribute('aria-describedby'),
      dmgBtn.parentElement.querySelector('.gun-dmg-pop').id,
    )
    dmgBtn.dispatchEvent(new dom.window.Event('mouseenter', { bubbles: true }))
    const pop = dmgBtn.parentElement.querySelector('.gun-dmg-pop')
    assert.equal(pop.hidden, false)
    assert.ok(pop.textContent.includes('дальше — 7'), pop.textContent)
    assert.ok(pop.textContent.includes('голова'), pop.textContent)
    assert.ok(pop.textContent.includes('тело'), pop.textContent)
    // Доп. урон поднят в «Основные»: броня, голова и таблица дистанций отдельными строками.
    const armor = doc.querySelector('#gun-field-bullet-extra_damage-armor_ignore')
    assert.ok(armor)
    assert.equal(armor.closest('.field').parentElement.id, 'gun-fields')
    assert.ok(armor.closest('.field').querySelector('label').textContent.includes('Бронепробитие'))
    const bands = doc.querySelectorAll('#gun-fields .gun-band')
    assert.equal(bands.length, 1)
    assert.ok(bands[0].querySelector('.gun-band-final').textContent.includes('итог:'))
    const extraOff = doc.querySelector('#gun-field-bullet-extra_damage-off')
    assert.ok(extraOff)
    assert.ok(
      extraOff
        .closest('.field')
        .querySelector('label')
        .textContent.includes('Не использовать доп. урон'),
    )
    // Массив enum: две строки и добавление. (GUN_LABELS в тестах пуст — ищем по title-ключу.)
    const modes = [...doc.querySelectorAll('#gun-advanced-fields .field')].find(
      (row) => row.title === 'fire_mode',
    )
    assert.equal(modes.querySelectorAll('select').length, 2)
    modes.querySelector('.gun-mini[aria-label=Добавить]').click()
    assert.equal(modes.querySelectorAll('select').length, 3)
    // Nullable-карта: выключение пишет явный null.
    const spread = [...doc.querySelectorAll('#gun-advanced-fields .field')].find(
      (row) => row.title === 'inaccuracy',
    )
    const off = spread.querySelector('.gun-null input[type=checkbox]')
    assert.equal(off.checked, false)
    const stand = [...spread.querySelectorAll('.gun-list-row')]
      .find((row) => row.querySelector('[data-gunkey]').value === 'stand')
      .querySelector('input:not([type=checkbox])')
    stand.value = '5'
    stand.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.window.flush()
    assert.deepEqual(calls.at(-1).body.gunBalance['tacz:ak47'].inaccuracy, {
      stand: 5,
      aim: 4,
    })
    off.checked = true
    off.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    await dom.window.flush()
    assert.deepEqual(calls.at(-1).body.gunBalance['tacz:ak47'].inaccuracy, null)
    // Удаление добавленной строки из массива возвращает исходное значение.
    const added = [...modes.querySelectorAll('.gun-list-row')].at(-1)
    added.querySelector('.gun-mini[aria-label=Удалить]').click()
    await dom.window.flush()
    assert.deepEqual(calls.at(-1).body.gunBalance['tacz:ak47'], { inaccuracy: null })
  } finally {
    dom.window.close()
  }
})

test('distance band add inserts before the open-ended last band; removing it reopens the previous', async () => {
  const { dom } = await setup()
  try {
    const { insert, remove } = dom.window.gunBandFns
    const plain = (value) => JSON.parse(JSON.stringify(value))
    const bands = [
      { distance: 25, damage: 9 },
      { distance: 120, damage: 6.5 },
      { distance: 'infinite', damage: 5.5 },
    ]
    assert.deepEqual(plain(insert(bands, 7)), [
      { distance: 25, damage: 9 },
      { distance: 120, damage: 6.5 },
      { distance: 145, damage: 6.5 },
      { distance: 'infinite', damage: 5.5 },
    ])
    assert.deepEqual(plain(insert([{ distance: 'infinite', damage: 5.5 }], 7)), [
      { distance: 25, damage: 5.5 },
      { distance: 'infinite', damage: 5.5 },
    ])
    assert.deepEqual(plain(insert([], 7)), [{ distance: 'infinite', damage: 7 }])
    assert.deepEqual(plain(remove(bands, 2)), [
      { distance: 25, damage: 9 },
      { distance: 120, damage: 6.5 },
    ])
    assert.deepEqual(plain(remove(bands, 0)), [
      { distance: 120, damage: 6.5 },
      { distance: 'infinite', damage: 5.5 },
    ])
    assert.deepEqual(plain(remove(bands, 9)), bands)
  } finally {
    dom.window.close()
  }
})

test('weapon editor shows no JSON wording and keeps nested rows and ↺ inside the viewport', () => {
  assert.doesNotMatch(script, /Сократите JSON|json: 'JSON'/)
  // Вложенная группа перезарядки: заголовок сверху, поля с отступом, а не колонка впритык.
  assert.match(page, /\.gun-sub-row:has\(> \.gun-sub\)/)
  // На узком экране ↺ уходит на свою строку под таблицей дистанций.
  assert.match(page, /\.ctl > \.gun-sub \{\s*flex: 1 1 100%;/)
  assert.match(page, /\.ctl > \.gun-sub ~ \.gun-reset \{\s*margin-left: auto;/)
})
