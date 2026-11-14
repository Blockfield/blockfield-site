// Admin workshop area: tabs "Мастерская" and "Команда" (workshop AI, map review
// pipeline, candidates/history, team roles). Extracted verbatim from
// src/pages/admin.astro (SITE95-U2).
import { ARENA_MODES, WORKSHOP_PLACES } from '../lib/game-names'
import { settingsReceipt } from '../lib/settings-form'
import { renderAiBudgetForm } from '../lib/ai-budget-form'
import type { BudgetTarget } from '../lib/ai-budget-form'
import { isCustomProviderId, workshopAiKeyLine } from '../lib/workshop-ai'
import { canonicalBudgetUuid } from '../lib/ai-budget'
import { customSelect } from '../lib/custom-select'
import type { MapCatalogEntry, MapSession } from '../lib/admin'
import {
  $,
  ROLES,
  me,
  can,
  date,
  ago,
  api,
  el,
  button,
  say,
  run,
  ask,
  field,
  follow,
  pendingRequests,
  requestResults,
  controller,
} from '../lib/admin-shell'
import {
  lastApplied,
  observedSettingsRevision,
  mapAvailabilityWaiters,
} from '../lib/admin-settings'

// Overview refreshes live in the page; sections call back through this hook.
let loadOverview: () => Promise<void> = async () => {}
function setLoadOverview(refresh: () => Promise<void>) {
  loadOverview = refresh
}

async function loadAiBudget() {
  const [{ policy }, catalog, staff] = await Promise.all([
    api('ai-limits'),
    api('maps'),
    api('staff'),
  ])
  const members = new Map<string, BudgetTarget>()
  for (const member of [...staff.owners, ...staff.staff]) {
    const id = canonicalBudgetUuid(member.uuid)
    if (id) members.set(id, { id, name: member.name })
  }
  const id = catalog.available && catalog.session ? canonicalBudgetUuid(catalog.session.id) : null
  const control = renderAiBudgetForm(policy, {
    session: id
      ? {
          id,
          name: `Текущий сеанс${catalog.session.startedAt ? ` · ${date(catalog.session.startedAt)}` : ''}`,
        }
      : undefined,
    builders: [...members.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
  })
  $('#ai-budget-form').replaceChildren(control.node)
  control.node.querySelectorAll<HTMLSelectElement>('select').forEach(customSelect)
  say(
    $('#ai-budget-status'),
    `Политика сохранена в ревизии ${policy.revision}. Применение сервером и расход здесь пока не подтверждаются.`,
  )
  control.node.onsubmit = (event) => {
    event.preventDefault()
    run(
      $('#ai-budget-status'),
      async () => {
        const body = control.read()
        const { policy: saved, cpRevisions: savedCpRevisions } = await api('ai-limits', 'PUT', body)
        control.saved(saved.revision, savedCpRevisions)
        return `Бюджет сохранён, ревизия ${saved.revision}. Подтверждение применения и расход появятся отдельно.`
      },
      control.node,
    )
  }
}

let workshopAiRevision = 0

let workshopAiCpRevisions: Record<string, number> = {}

let draftProviders: { id: string; label: string; baseUrl: string }[] = []

let editingProvider: string | null = null

function sayWorkshopAiKey(
  status: any,
  result: any,
  waiting: boolean,
  line: HTMLElement = $('#workshop-ai-key-status'),
) {
  const error =
    result && !result.ok
      ? typeof result.error === 'string' && result.error
        ? result.error
        : 'контроллер отклонил запрос.'
      : null
  say(
    line,
    workshopAiKeyLine(status ?? { set: false }, { waiting, error }, date),
    error ? 'error' : waiting ? 'pending' : 'ok',
  )
}

const keyProvider = () => $<HTMLSelectElement>('#workshop-ai-key-provider').value

const isPresetKeyProvider = () =>
  keyProvider() === 'openrouter' || keyProvider() === 'vercel-gateway'

const keyEndpoint = () =>
  keyProvider() === 'vercel-gateway'
    ? 'workshop-ai-gateway-key'
    : isPresetKeyProvider()
      ? 'workshop-ai-key'
      : 'workshop-ai-provider-key'

const keyLine = () =>
  keyProvider() === 'vercel-gateway'
    ? $('#workshop-ai-gateway-key-status')
    : isPresetKeyProvider()
      ? $('#workshop-ai-key-status')
      : $('#workshop-ai-provider-key-status')

const keyQuery = (endpoint: string) =>
  endpoint === 'workshop-ai-provider-key'
    ? `${endpoint}?provider=${encodeURIComponent(keyProvider())}`
    : endpoint

function providerName(id: string) {
  const found = draftProviders.find((entry) => entry.id === id)
  if (found) return found.label
  return id === 'openrouter' ? 'OpenRouter' : id === 'vercel-gateway' ? 'Vercel AI Gateway' : id
}

function fillProviderSelect(select: HTMLSelectElement, value: string) {
  const previous = select.value
  const choices = [
    ['openrouter', 'OpenRouter'],
    ['vercel-gateway', 'Vercel AI Gateway'],
    ...draftProviders.map((entry) => [entry.id, entry.label]),
  ]
  select.replaceChildren()
  for (const [id, label] of choices) {
    const option = document.createElement('option')
    option.value = id
    option.textContent = label
    select.append(option)
  }
  // A removed provider stays unselected instead of silently falling back:
  // the owner picks a replacement explicitly, otherwise the save fails closed.
  if (value && choices.some(([id]) => id === value)) select.value = value
  else if (previous && choices.some(([id]) => id === previous)) select.value = previous
  else select.value = ''
}

function refreshProviderSelects() {
  for (const id of [
    '#workshop-ai-generation-provider',
    '#workshop-ai-transcription-provider',
    '#workshop-ai-cleanup-provider',
  ])
    fillProviderSelect($(id) as HTMLSelectElement, ($(id) as HTMLSelectElement).value)
  const keySelect = $<HTMLSelectElement>('#workshop-ai-key-provider')
  const kept = keySelect.value
  fillProviderSelect(keySelect, kept)
}

function clearProviderForm() {
  editingProvider = null
  $<HTMLInputElement>('#workshop-ai-provider-id').value = ''
  $<HTMLInputElement>('#workshop-ai-provider-label').value = ''
  $<HTMLInputElement>('#workshop-ai-provider-url').value = ''
  $<HTMLInputElement>('#workshop-ai-provider-id').disabled = false
  $('#workshop-ai-provider-add').textContent = 'Добавить провайдера'
  $('#workshop-ai-provider-cancel').hidden = true
}

function renderProviders() {
  const list = $('#workshop-ai-providers')
  list.replaceChildren(
    ...(draftProviders.length
      ? draftProviders.map((entry) =>
          el(
            'li',
            { className: 'row' },
            el(
              'div',
              { className: 'row-main' },
              el('strong', { textContent: entry.label }),
              el('small', { textContent: `${entry.id} · ${entry.baseUrl}` }),
            ),
            el(
              'div',
              { className: 'actions' },
              button('Изменить', () => {
                editingProvider = entry.id
                $<HTMLInputElement>('#workshop-ai-provider-id').value = entry.id
                $<HTMLInputElement>('#workshop-ai-provider-id').disabled = true
                $<HTMLInputElement>('#workshop-ai-provider-label').value = entry.label
                $<HTMLInputElement>('#workshop-ai-provider-url').value = entry.baseUrl
                $('#workshop-ai-provider-add').textContent = 'Сохранить'
                $('#workshop-ai-provider-cancel').hidden = false
              }),
              button('Убрать', async () => {
                if (
                  !(await ask({
                    title: `Убрать ${entry.label}?`,
                    text: 'Модели на этом провайдере перестанут сохраняться, пока не выберете другой.',
                    ok: 'Убрать',
                    danger: true,
                  }))
                )
                  return
                if (editingProvider === entry.id) clearProviderForm()
                draftProviders = draftProviders.filter((other) => other.id !== entry.id)
                renderProviders()
                refreshProviderSelects()
              }),
            ),
          ),
        )
      : [el('li', { className: 'empty', textContent: 'Своих провайдеров нет.' })]),
  )
}

function checkProviderForm(): { id: string; label: string; baseUrl: string } {
  const id = $<HTMLInputElement>('#workshop-ai-provider-id').value.trim()
  const label = $<HTMLInputElement>('#workshop-ai-provider-label').value.trim()
  const baseUrl = $<HTMLInputElement>('#workshop-ai-provider-url').value.trim()
  if (!isCustomProviderId(id)) throw new Error('ID: a-z, 0-9 и дефис; не совпадает со встроенным.')
  if (!label || label.length > 80) throw new Error('Название: 1…80 символов.')
  if (baseUrl.length > 200 || !/^https:\/\/[^/\s?#]+/.test(baseUrl) || /[?#]/.test(baseUrl))
    throw new Error('Адрес: https:// без параметров.')
  if (
    draftProviders.some((entry) => entry.id === id && entry.id !== editingProvider) ||
    (!editingProvider && draftProviders.length >= 8)
  )
    throw new Error(
      draftProviders.some((entry) => entry.id === id)
        ? 'Такой ID уже есть.'
        : 'Провайдеров не больше 8.',
    )
  return { id, label, baseUrl }
}

async function refreshCustomKeyStatus() {
  const custom = !isPresetKeyProvider()
  const line = $('#workshop-ai-provider-key-status')
  line.hidden = !custom
  $('#workshop-ai-key-status').hidden = custom
  $('#workshop-ai-gateway-key-status').hidden = custom
  if (!custom) return
  try {
    const key = await api(keyQuery(keyEndpoint()))
    sayWorkshopAiKey(key.status, null, false, line)
  } catch {
    say(line, 'Не удалось проверить ключ.', 'error')
  }
}

async function loadWorkshopAi() {
  const [{ settings }, key, gatewayKey] = await Promise.all([
    api('workshop-ai-settings'),
    api('workshop-ai-key'),
    api('workshop-ai-gateway-key'),
  ])
  workshopAiRevision = settings.revision
  workshopAiCpRevisions = settings.cpRevisions ?? {}
  $<HTMLInputElement>('#workshop-ai-enabled').checked = settings.enabled
  $<HTMLSelectElement>('#workshop-ai-provider').value = settings.provider
  $<HTMLInputElement>('#workshop-ai-generation').value = settings.generationModel
  $<HTMLInputElement>('#workshop-ai-transcription').value = settings.transcriptionModel
  $<HTMLInputElement>('#workshop-ai-cleanup').value = settings.cleanupModel ?? ''
  draftProviders = Array.isArray(settings.providers)
    ? settings.providers.map((entry: any) => ({ ...entry }))
    : []
  clearProviderForm()
  renderProviders()
  fillProviderSelect(
    $<HTMLSelectElement>('#workshop-ai-generation-provider'),
    settings.generationProvider ?? settings.provider,
  )
  fillProviderSelect(
    $<HTMLSelectElement>('#workshop-ai-transcription-provider'),
    settings.transcriptionProvider ?? settings.provider,
  )
  fillProviderSelect(
    $<HTMLSelectElement>('#workshop-ai-cleanup-provider'),
    settings.cleanupProvider ?? settings.transcriptionProvider ?? settings.provider,
  )
  fillProviderSelect(
    $<HTMLSelectElement>('#workshop-ai-key-provider'),
    $<HTMLSelectElement>('#workshop-ai-key-provider').value || settings.provider,
  )
  $<HTMLInputElement>('#workshop-ai-max-blocks').value = String(settings.maxBlocks)
  $<HTMLInputElement>('#workshop-ai-blocks-per-tick').value = String(settings.blocksPerTick)
  $<HTMLInputElement>('#workshop-ai-minimum-build-ticks').value = String(settings.minimumBuildTicks)
  $<HTMLInputElement>('#workshop-ai-apply-budget-ms').value = String(settings.applyBudgetMs)
  $<HTMLInputElement>('#workshop-ai-hourly-request-limit').value = String(
    settings.hourlyRequestLimit,
  )
  $<HTMLInputElement>('#workshop-ai-hourly-player-request-limit').value = String(
    settings.hourlyPlayerRequestLimit,
  )
  $<HTMLInputElement>('#workshop-ai-max-hourly-builders').value = String(settings.maxHourlyBuilders)
  $<HTMLInputElement>('#workshop-ai-prompt-cap').value = String(
    settings.generationMaxPricePromptUsdPerM,
  )
  $<HTMLInputElement>('#workshop-ai-completion-cap').value = String(
    settings.generationMaxPriceCompletionUsdPerM,
  )
  say($('#workshop-ai-status'), `Настройки сохранены в ревизии ${settings.revision}.`)
  sayWorkshopAiKey(key.status, null, false)
  say(
    $('#workshop-ai-gateway-key-status'),
    workshopAiKeyLine(gatewayKey.status ?? { set: false }, { waiting: false }, date),
  )
  await refreshCustomKeyStatus()
}

async function pollWorkshopAiKey(id: string, endpoint: string, line: HTMLElement) {
  const query = keyQuery(endpoint)
  const pushed = await new Promise<any>((resolve) => {
    const finish = (result: any) => {
      clearTimeout(timer)
      pendingRequests.delete(id)
      resolve(result)
    }
    const timer = setTimeout(async () => {
      const { result } = await api(`request?id=${id}`).catch(() => ({ result: null }))
      finish(result)
    }, 60_000)
    pendingRequests.set(id, finish)
    if (requestResults.has(id)) {
      const result = requestResults.get(id)
      requestResults.delete(id)
      finish(result)
    }
  })
  if (pushed?.ok) {
    await loadWorkshopAi()
    return
  }
  try {
    const key = await api(`${query}${query.includes('?') ? '&' : '?'}id=${id}`)
    const finalResult = key.result ?? pushed
    if (!finalResult) {
      say(line, 'Ключ применяется… Обновите состояние AI позже.', 'pending')
      return
    }
    if (finalResult.ok) await loadWorkshopAi()
    else sayWorkshopAiKey(key.status, finalResult, false, line)
  } catch {
    if (pushed) sayWorkshopAiKey({ set: false }, pushed, false, line)
    else say(line, 'Ключ применяется… Обновите состояние AI позже.', 'pending')
  }
}

const assignable = () =>
  can('roles-admin') ? ['builder', 'moderator', 'admin'] : ['builder', 'moderator']

async function loadTeam() {
  const data = await api('staff')
  $('#role-legend').replaceChildren(
    ...Object.values(ROLES).map((r) =>
      el(
        'div',
        { className: 'row' },
        el('dt', { textContent: r.name }),
        el('dd', { textContent: r.about }),
      ),
    ),
  )
  const line = $('#staff-status')
  const rows = data.owners.map((o: any) =>
    el(
      'li',
      { className: 'row' },
      el(
        'div',
        { className: 'row-main' },
        el('strong', { textContent: o.name }),
        el('small', {
          textContent: 'Владелец · полный доступ',
        }),
      ),
    ),
  )
  const roleSelects: HTMLSelectElement[] = []
  for (const s of data.staff) {
    const editable = s.name !== me.name && (s.role !== 'admin' || can('roles-admin'))
    const main = el(
      'div',
      { className: 'row-main' },
      el('strong', { textContent: s.name }),
      el('small', {
        textContent: `${ROLES[s.role]?.name ?? 'Участник'} · добавил ${s.grantedBy} ${ago(s.grantedAt)}`,
      }),
    )
    const row = el('li', { className: 'row' }, main)
    if (editable) {
      const select = el(
        'select',
        { ariaLabel: `Роль игрока ${s.name}` },
        ...assignable().map((r) =>
          el('option', { value: r, textContent: ROLES[r].name, selected: r === s.role }),
        ),
      )
      roleSelects.push(select)
      select.addEventListener('change', async () => {
        const role = select.value
        if (
          !(await ask({
            title: `Сделать ${s.name} — ${ROLES[role].name.toLowerCase()}?`,
            text: ROLES[role].about,
            ok: 'Сменить роль',
          }))
        ) {
          select.value = s.role
          customSelect(select)
          return
        }
        changeRole(
          { uuid: s.uuid, role, expectedRevision: s.expectedRevision ?? undefined },
          `${s.name} теперь ${ROLES[role].name.toLowerCase()}.`,
          line,
        )
      })
      const actions = el('div', { className: 'actions' }, select)
      if (can('workshop') && s.role === 'builder')
        actions.append(
          button(
            `Карты: ${mapsLabel(s.maps)}`,
            () => editMaps(s, line),
            'small',
            `Карты для ${s.name} в мастерской`,
          ),
        )
      actions.append(
        button(
          'Убрать из команды',
          async () => {
            if (
              await ask({
                title: `Убрать ${s.name} из команды?`,
                text: `${s.name} потеряет доступ к панели и мастерской. Играть на сервере он сможет как обычно.`,
                ok: 'Убрать',
                danger: true,
              })
            )
              changeRole(
                { uuid: s.uuid, role: null, expectedRevision: s.expectedRevision ?? undefined },
                `${s.name} больше не в команде.`,
                line,
              )
          },
          'small danger',
          `Убрать ${s.name} из команды`,
        ),
      )
      row.append(actions)
    }
    rows.push(row)
  }
  $('#staff-list').replaceChildren(...rows)
  roleSelects.forEach(customSelect)
  $('#grant-roles').replaceChildren(
    ...assignable().map((r, i) =>
      el(
        'label',
        { className: 'radio' },
        el('input', {
          type: 'radio',
          name: 'role',
          value: r,
          required: true,
          checked: i === 0,
        }),
        el('span', {}, ROLES[r].name, el('small', { textContent: ROLES[r].about })),
      ),
    ),
  )
  const key = (list: any[]) =>
    JSON.stringify(
      (list ?? []).map((m) => [m.draslId, m.role, m.maps ? [...m.maps].sort() : null]).sort(),
    )
  const inSync = Array.isArray(data.workshop) && key(data.workshop) === key(data.expected)
  const last = data.lastSync
    ? ` Последнее обновление ${ago(data.lastSync.at)}${data.lastSync.result && !data.lastSync.result.ok ? ' — не удалось' : ''}.`
    : ''
  teamStaff = data.staff
  renderMaps()
  say(
    $('#workshop-state'),
    inSync
      ? `Мастерская пускает ровно тех, кто в команде.${last}`
      : `Список доступа в мастерскую отличается от команды — нажмите «Обновить доступ».${last}`,
    inSync ? 'ok' : 'pending',
  )
  // The list re-syncs after every role change by itself; the manual button only repairs drift.
  $('#sync').hidden = inSync
}

const CP_ROLE_GENITIVE: Record<string, string> = {
  builder: 'строителя',
  moderator: 'модератора',
  admin: 'администратора',
}

async function changeRole(body: Record<string, unknown>, done: string, line: HTMLElement) {
  await run(line, async () => {
    const data = await api('staff', 'POST', body)
    await loadTeam()
    const notes: string[] = []
    if (data.sync.error)
      notes.push('Но доступ в мастерскую обновить не удалось — нажмите «Обновить доступ» позже.')
    if (Array.isArray(data.partialApply) && data.partialApply.length)
      notes.push(
        `Но в CP ${data.partialApply.length > 1 ? 'остались роли' : 'осталась роль'} ${data.partialApply.map((role: string) => CP_ROLE_GENITIVE[role] ?? String(role)).join(', ')} — повторите.`,
      )
    return notes.length ? `${done} ${notes.join(' ')}` : done
  })
}

const mapsLabel = (maps: string[] | null) =>
  maps === null
    ? 'все'
    : !maps.length
      ? 'нет'
      : maps.length > 3
        ? `${maps.length} из ${mapScopes().length + 1}`
        : maps.map((id) => mapName(id)).join(', ')

async function editMaps(
  s: { uuid: string; name: string; maps: string[] | null },
  line: HTMLElement,
) {
  const known = ['hub', ...mapScopes()],
    current = new Set(s.maps ?? known)
  const list = el(
    'div',
    { className: 'checks' },
    ...known.map((id) =>
      el(
        'label',
        { className: 'check' },
        el('input', { type: 'checkbox', name: 'map', value: id, checked: current.has(id) }),
        mapName(id),
      ),
    ),
  )
  const answer = await ask({
    title: `Карты для ${s.name} в мастерской`,
    text: 'Отметьте карты, которые строитель может редактировать. Все отмечены — доступ ко всем картам, включая новые.',
    ok: 'Сохранить',
    fields: [list],
  })
  if (!answer) return
  const ids = answer.getAll('map').map(String),
    maps = ids.length === known.length ? null : ids
  await run(line, async () => {
    await api('staff/maps', 'POST', { uuid: s.uuid, maps })
    await loadTeam()
    return `Карты для ${s.name} обновлены.`
  })
}

let mapCatalog: MapCatalogEntry[] | undefined,
  mapSession: MapSession | undefined,
  mapAvailability: any,
  mapCpRevisions: Record<string, number> = {}

let editableMaps = new Set<string>(),
  savedMapSessions: MapSession[] = [],
  savedSessionsNext: number | null = null,
  savedSessionsTotal = 0

const mapNotes = new Map<string, string>()

const mayEditMap = (id: string) => can('map-edit') && editableMaps.has(id)

function waitMapAvailability(revision: number, mapId: string, disabled: boolean) {
  return new Promise<boolean>((resolve, reject) => {
    const finish = (data: any) => {
      if ((data.settings?.revision ?? 0) < revision) return
      const receipt = settingsReceipt(revision, data.applied)
      if (receipt === 'rejected' || receipt === 'partial') {
        cleanup()
        reject(new Error('Игровой сервер отклонил изменение. Прежняя доступность сохранена.'))
      } else if (
        receipt === 'applied' &&
        Array.isArray(data.applied?.disabledMapIds) &&
        data.applied.disabledMapIds.includes(mapId) === disabled
      ) {
        cleanup()
        resolve(true)
      }
    }
    const cleanup = () => {
      clearTimeout(timer)
      mapAvailabilityWaiters.delete(finish)
    }
    const timer = setTimeout(async () => {
      try {
        finish(await api('settings'))
        cleanup()
        resolve(false)
      } catch (error) {
        cleanup()
        reject(error)
      }
    }, 30_000)
    mapAvailabilityWaiters.add(finish)
    finish({ settings: { revision: observedSettingsRevision }, applied: lastApplied })
  })
}

function mapAvailabilityControls(map: MapCatalogEntry, line: HTMLElement) {
  const content = el('div', { className: 'stack' })
  if (map.kind !== 'arena' || !map.head) return content
  if (!mapAvailability?.available) {
    content.append(
      el('p', {
        className: 'muted',
        textContent: 'Доступность новых матчей пока не подтверждена.',
      }),
    )
    return content
  }
  const disabled = mapAvailability.disabledMapIds.includes(map.mapId),
    applied = mapAvailability.applied,
    observed = Array.isArray(applied?.disabledMapIds)
      ? applied.disabledMapIds.includes(map.mapId)
      : null
  content.append(
    el('p', {
      textContent:
        observed === null
          ? 'Подтверждение доступности от игрового сервера пока не получено.'
          : observed
            ? 'Отключена для новых матчей и тренировок.'
            : 'Доступна для новых матчей и тренировок.',
    }),
    el('small', {
      textContent:
        'Начатые матчи и кампании завершатся. Черновики мастерской и закрытые тесты доступны.',
    }),
  )
  if (observed !== disabled)
    content.append(
      el('small', {
        className: 'warn',
        textContent: `Ожидает применения: ${disabled ? 'отключение' : 'включение'}.`,
      }),
    )
  if (can('workshop'))
    content.append(
      button(
        disabled ? 'Включить для новых матчей' : 'Отключить для новых матчей',
        async () => {
          if (
            !(await ask({
              title: disabled ? 'Включить карту?' : 'Отключить карту?',
              text: 'Изменится выбор новых матчей и тренировок после подтверждения игрового сервера. Уже начатые матчи и кампании продолжатся; история, черновики и закрытые тесты сохранятся.',
              ok: disabled ? 'Включить' : 'Отключить',
              danger: !disabled,
            }))
          )
            return
          await run(
            line,
            async () => {
              const { settings } = await api('maps/availability', 'PUT', {
                mapId: map.mapId,
                enabled: disabled,
                expectedRevision: mapAvailability.revision,
                cpRevisions: mapCpRevisions,
              })
              say(line, 'Сохранено. Применяем доступность…', 'pending')
              const confirmed = await waitMapAvailability(settings.revision, map.mapId, !disabled)
              if (confirmed) {
                say(
                  line,
                  disabled
                    ? 'Карта включена для новых матчей и тренировок.'
                    : 'Карта отключена для новых матчей и тренировок.',
                )
                await loadMapHistory()
                return
              }
              say(
                line,
                'Сохранено; применение доступности пока не подтверждено. Обновите историю позже.',
                'pending',
              )
            },
            content,
          )
        },
        'small',
        `${disabled ? 'Включить' : 'Отключить'} карту ${mapName(map.mapId)} для новых матчей`,
      ),
    )
  return content
}

function newMapControls() {
  const form = el('form', { className: 'form-grid' }),
    modes = el(
      'div',
      { className: 'checks' },
      ...Object.entries(ARENA_MODES).map(([id, name]) =>
        el(
          'label',
          { className: 'check' },
          el('input', { type: 'checkbox', name: 'supportedModes', value: id }),
          name,
        ),
      ),
    )
  form.append(
    field(
      'ID карты',
      el('input', {
        name: 'mapId',
        required: true,
        maxLength: 32,
        pattern: '[a-z0-9][a-z0-9_]{0,31}',
        autocomplete: 'off',
      }),
      'Строчные латинские буквы, цифры и подчёркивание. ID после создания не меняется.',
    ),
    field(
      'Название карты',
      el('input', { name: 'name', required: true, maxLength: 100, autocomplete: 'off' }),
      'До 100 символов. Название можно изменить в рабочем черновике.',
    ),
    el('fieldset', {}, el('legend', { textContent: 'Поддерживаемые режимы' }), modes),
    el(
      'div',
      { className: 'actions' },
      el('button', {
        type: 'submit',
        className: 'small primary',
        textContent: 'Создать пустую карту',
      }),
    ),
  )
  form.onsubmit = (event) => {
    event.preventDefault()
    const data = new FormData(form),
      line = $('#map-create-status'),
      supportedModes = data.getAll('supportedModes').map(String)
    if (!supportedModes.length) {
      say(line, 'Выберите хотя бы один режим карты.', 'error')
      modes.querySelector<HTMLInputElement>('input')?.focus()
      return
    }
    run(
      line,
      async () => {
        if (!can('maps') || controller?.phase !== 'workshop' || controller.gate !== 'builders')
          throw new Error('Дождитесь открытия мастерской перед созданием карты.')
        if (
          !(await ask({
            title: 'Создать пустую карту?',
            text: 'Мастерская сохранит текущий черновик, откроет новую карту и перезапустится. Прежний черновик останется в сохранённых. Карта попадёт в игру после проверки администратора.',
            ok: 'Создать карту',
            danger: true,
          }))
        )
          return
        const payload = await mapRequest(
          'maps/create',
          {
            mapId: String(data.get('mapId')),
            name: String(data.get('name')),
            supportedModes,
            expectedRevision: controller.revision,
          },
          line,
          'Карта создана. Мастерская открывает её отдельный черновик; готовность показана в обзоре.',
        )
        if (payload) {
          form.reset()
          await loadMapHistory()
        }
      },
      form,
    )
  }
  return form
}

// Workshop#74 refuses saves from an outdated copy with StaleWorkingCopyError;
// the inbox refusal carries its machine-readable code, so the site keys off the
// code, not the message text (coord#31): a reworded message must not hide the way out.
function isStaleCopy(code: unknown): boolean {
  return code === 'stale_working_copy'
}

// Refused copies by map: a session switch while the notice is open must not offer
// the way out for a different copy, and a fresh save clears the mark.
const staleCopyIds = new Map<string, string>()
async function staleCopyReload(mapId: string, copy: string) {
  staleCopyIds.set(mapId, copy)
  await loadMapHistory()
}

function mapRequestError(line: HTMLElement, error: string) {
  const message = /no changes|nothing to commit/i.test(error)
    ? 'Нет изменений для сохранения. Постройте или измените разметку перед отправкой.'
    : /stale|head|revision|target.*changed|behind/i.test(error)
      ? 'Версия в игре успела измениться. Обновите список карт и попробуйте снова.'
      : /missing|corrupt|unsafe/i.test(error)
        ? 'Рабочая копия или сохранённая версия недоступна. Сообщите администратору.'
        : /actor|member|scope|permission/i.test(error)
          ? 'Мастерская не подтвердила участника или доступ к карте. Попросите администратора обновить доступ.'
          : 'Не удалось выполнить запрос. Обновите состояние и попробуйте снова.'
  say(line, message, 'error')
  return true
}

async function mapRequest(
  path: string,
  body: Record<string, unknown>,
  line: HTMLElement,
  done: string,
  onStale?: () => void | Promise<void>,
) {
  const { id } = await api(path, 'POST', body)
  let stale = false
  const result = await follow(line, id, done, (error, code) => {
    stale = isStaleCopy(code)
    return mapRequestError(line, error)
  })
  if (!result?.ok) {
    if (stale) await onStale?.()
    return null
  }
  if (
    !result.payload ||
    typeof result.payload !== 'object' ||
    (body.mapId && result.payload.mapId !== body.mapId)
  ) {
    say(line, 'Результат пока недоступен. Обновите историю карты.', 'error')
    return null
  }
  return result.payload
}

function mapPathLabel(path: string) {
  const region = /^world\/(region|entities|poi)\/r\.(-?\d+)\.(-?\d+)\.mca$/.exec(path)
  if (region) {
    const x = Number(region[2]) * 512,
      z = Number(region[3]) * 512
    return `${({ region: 'Блоки', entities: 'Сущности', poi: 'Точки интереса' } as Record<string, string>)[region[1]]}: X ${x}…${x + 511}, Z ${z}…${z + 511}`
  }
  if (path === 'map.json') return 'Разметка карты'
  const field = /^map\.json#(.*)$/.exec(path)
  return field ? `Разметка: ${field[1].replace(/^\//, '') || 'вся'}` : path
}

function renderMapChanges(outlet: HTMLElement, data: any) {
  if (!Array.isArray(data?.files) || !Array.isArray(data?.config))
    throw new Error('Не удалось сравнить версии. Обновите историю и попробуйте ещё раз')
  const rows = el('ul', { className: 'rows git-diff' }),
    more = button('Показать ещё изменения', append, 'small')
  const entries = [
    ...data.files.map((file: any) => ({ file })),
    ...data.config.map((config: any) => ({ config })),
  ]
  let shown = 0
  function append() {
    for (const entry of entries.slice(shown, shown + 100)) {
      if (entry.file) {
        const file = entry.file,
          area = file.area
        rows.append(
          el(
            'li',
            { className: 'row' },
            el(
              'div',
              { className: 'row-main' },
              el('strong', { textContent: mapPathLabel(file.path) }),
              el('small', {
                textContent: `${({ added: 'Добавлен', deleted: 'Удалён', modified: 'Изменён' } as Record<string, string>)[file.change] ?? 'Изменён'} · ${file.before?.slice(0, 12) ?? 'нет'} → ${file.after?.slice(0, 12) ?? 'нет'}`,
              }),
              area
                ? el('small', {
                    textContent: `Область: X ${area.minX}…${area.maxX}, Z ${area.minZ}…${area.maxZ}`,
                  })
                : null,
            ),
          ),
        )
      } else {
        const config = entry.config
        rows.append(
          el(
            'li',
            { className: 'row' },
            el(
              'details',
              { className: 'disclosure row-main' },
              el('summary', {
                textContent: `Разметка ${config.path || '/'} — ${!config.beforePresent ? 'добавлено' : !config.afterPresent ? 'удалено' : 'изменено'}`,
              }),
              el('strong', { textContent: 'До' }),
              el('pre', {
                textContent: config.beforePresent ? JSON.stringify(config.before) : 'Отсутствует',
              }),
              el('strong', { textContent: 'После' }),
              el('pre', {
                textContent: config.afterPresent ? JSON.stringify(config.after) : 'Отсутствует',
              }),
            ),
          ),
        )
      }
    }
    shown = Math.min(shown + 100, entries.length)
    more.hidden = shown === entries.length
  }
  outlet.replaceChildren(
    el('p', {
      textContent: `Изменено файлов мира: ${data.files.length}, полей разметки: ${data.config.length}.`,
    }),
    rows,
    more,
  )
  if (!entries.length)
    rows.append(el('li', { className: 'empty', textContent: 'Содержимое версий совпадает.' }))
  append()
}

async function compareMap(
  mapId: string,
  before: string,
  after: string,
  outlet: HTMLElement,
  line: HTMLElement,
) {
  const data = await mapRequest('maps/compare', { mapId, before, after }, line, 'Сравнение готово.')
  if (!data) return
  if (data.before !== before || data.after !== after)
    throw new Error('Версии для сравнения изменились. Обновите историю и попробуйте ещё раз.')
  renderMapChanges(outlet, data)
}

type StaffRow = {
  uuid: string
  name: string
  role: string
  maps: string[] | null
  expectedRevision: number | null
}

let teamStaff: StaffRow[] | undefined,
  candidateList: any[] = [],
  pendingKey = ''

const mapEditors = (builders: StaffRow[], id: string) =>
  builders.filter((b) => b.maps === null || b.maps.includes(id))

const mapNodes = new Map<string, HTMLElement>()

const kept = (key: string, make: () => HTMLElement) => {
  if (!mapNodes.has(key)) mapNodes.set(key, make())
  return mapNodes.get(key)!
}

const mapLine = (key: string) =>
  kept(key, () => el('p', { className: 'form-status', role: 'status' }))

const busyMaps = new Set<string>()

async function mapBusy(id: string, action: () => Promise<void>) {
  if (busyMaps.has(id)) return
  busyMaps.add(id)
  try {
    await action()
  } finally {
    busyMaps.delete(id)
    renderMaps()
  }
}

function playedVersions(map: MapCatalogEntry) {
  const byId = new Map(map.versions.map((version) => [version.versionDigest, version])),
    seen = new Set<string>(),
    stack = map.head ? [map.head.versionDigest] : []
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    const version = byId.get(id)
    stack.push(...(version?.parents ?? (version?.parent ? [version.parent] : [])))
  }
  return seen
}

// Saved versions not yet in the published history that no other version builds
// on: the tip(s) of the unpublished chain. Order comes from parent links, never
// from timestamps (two saves can share one). Several reviews of a map may be
// pending, so "send" is pointless only when a tip itself is already pending.
function unpublishedTips(map: MapCatalogEntry) {
  const played = playedVersions(map),
    parents = new Set(
      map.versions.flatMap(
        (version) => version.parents ?? (version.parent ? [version.parent] : []),
      ),
    )
  return map.versions.filter(
    (version) => !played.has(version.versionDigest) && !parents.has(version.versionDigest),
  )
}

function goesLive(mapId: string) {
  const kind = mapCatalog?.find((map) => map.mapId === mapId)?.kind
  return kind === 'lobby'
    ? 'Лобби перейдёт на неё при следующем безопасном запуске сервера.'
    : kind === 'limbo'
      ? 'Прокси перейдёт на неё после подготовки в истории версий и перезапуска.'
      : 'Следующие матчи пойдут на ней, начатые доиграют на прежней.'
}

const versionLabel = (version: MapCatalogEntry['versions'][number]) =>
  `${date(version.createdAt)} · ${String(version.author.name ?? 'автор не указан')}${version.note ? ` · ${version.note.slice(0, 48)}` : ''}`

async function commitMap(
  map: MapCatalogEntry,
  copy: string,
  note: string,
  line: HTMLElement,
  review: boolean,
) {
  const payload = await mapRequest(
    review ? 'candidates/create' : 'maps/commit',
    {
      mapId: map.mapId,
      workingCopyId: copy,
      expectedHead: map.head?.versionDigest ?? null,
      note,
      ...(review ? { commit: true } : {}),
    },
    line,
    review
      ? 'Версия сохранена и отправлена на проверку. Можно строить дальше.'
      : 'Версия сохранена. Отправьте её на проверку, когда будете готовы.',
    () => staleCopyReload(map.mapId, copy),
  )
  if (!payload) return
  staleCopyIds.delete(map.mapId)
  if (mapNotes.get(map.mapId) === note) mapNotes.delete(map.mapId)
  await loadMapHistory()
  if (review) await loadCandidates()
}

async function submitSaved(map: MapCatalogEntry, copy: string, line: HTMLElement) {
  const name = mapName(map.mapId)
  if (
    !(await ask({
      title: `Отправить «${name}» на проверку?`,
      text: 'Уйдёт последняя сохранённая версия. Несохранённые правки останутся в черновике.',
      ok: 'Отправить',
    }))
  )
    return
  await run(line, async () => {
    const payload = await mapRequest(
      'candidates/create',
      {
        mapId: map.mapId,
        workingCopyId: copy,
        expectedHead: map.head?.versionDigest ?? null,
        commit: false,
      },
      line,
      `«${name}» отправлена на проверку. Новые правки в неё не попадут.`,
      () => staleCopyReload(map.mapId, copy),
    )
    if (payload) {
      staleCopyIds.delete(map.mapId)
      await loadCandidates()
    }
  })
}

async function snapshotStaleCopy(map: MapCatalogEntry, copy: string, line: HTMLElement) {
  const name = el('input', {
    name: 'snapshot',
    required: true,
    maxLength: 64,
    pattern: '[a-z0-9][a-z0-9.\\-]{0,63}',
    autocomplete: 'off',
  })
  const answer = await ask({
    title: 'Сохранить черновик снимком?',
    text: 'Черновик запишется снимком под этим именем и останется устаревшим; в игру он не попадёт.',
    ok: 'Сохранить снимком',
    fields: [field('Имя снимка', name, 'Латиница, цифры, точка, дефис или подчёркивание.')],
  })
  if (!answer) return
  const snapshot = String(answer.get('snapshot') ?? '').trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(snapshot) || snapshot === 'main')
    throw new Error('Укажите имя снимка: латиница, цифры, точка, дефис или подчёркивание.')
  await run(line, async () => {
    const payload = await mapRequest(
      'maps/snapshot-copy',
      { mapId: map.mapId, name: snapshot, workingCopyId: copy },
      line,
      `Черновик сохранён снимком «${snapshot}». Копия осталась устаревшей: начните с текущей версии.`,
    )
    if (payload) await loadMapHistory()
  })
}

async function checkoutFreshCopy(map: MapCatalogEntry, copy: string, line: HTMLElement) {
  if (
    !(await ask({
      title: 'Начать с текущей версии?',
      text: 'Откроется новая копия с версией из игры; несохранённые правки останутся в старой копии. Продолжите новую копию в сохранённых черновиках.',
      ok: 'Начать с текущей версии',
    }))
  )
    return
  await run(line, async () => {
    const payload = await mapRequest(
      'maps/checkout-fresh',
      { mapId: map.mapId, workingCopyId: copy },
      line,
      'Новая копия создана из текущей версии. Продолжите её в сохранённых черновиках.',
    )
    if (payload) await loadMapHistory()
  })
}

function staleCopyActions(map: MapCatalogEntry, copy: string, line: HTMLElement) {
  return el(
    'div',
    { className: 'stack' },
    el('p', {
      className: 'warn',
      textContent:
        'Копия устарела: в игре более новая версия, сохранение отклонено. Сохраните черновик снимком или начните с текущей версии.',
    }),
    el(
      'div',
      { className: 'actions' },
      can('workshop')
        ? button(
            'Сохранить черновик снимком',
            () => mapBusy(map.mapId, () => snapshotStaleCopy(map, copy, line)),
            'small',
            `Сохранить черновик карты ${mapName(map.mapId)} снимком`,
          )
        : null,
      button(
        'Начать с текущей версии',
        () => mapBusy(map.mapId, () => checkoutFreshCopy(map, copy, line)),
        'small',
        `Начать карту ${mapName(map.mapId)} с текущей версии`,
      ),
    ),
  )
}

function draftPanel(map: MapCatalogEntry) {
  const id = map.mapId,
    name = mapName(id),
    line = mapLine(`${id}:draft`),
    // The copy this panel was rendered for: a session switch while a dialog or
    // request is open must never redirect the action to another copy.
    copy = mapSession!.id,
    head = map.head?.versionDigest ?? null,
    sent = candidateList.some((c) => c.status === 'pending' && c.mapId === id),
    unsent = unpublishedTips(map).some(
      (tip) =>
        !candidateList.some(
          (c) => c.status === 'pending' && c.mapId === id && c.versionDigest === tip.versionDigest,
        ),
    )
  const part = el(
    'div',
    { className: 'map-part map-draft' },
    el('h4', { textContent: 'Черновик в мастерской' }),
    el('p', {
      textContent: `Карта открыта в мастерской. Правки в мире копятся в черновике сами; проверяющие увидят их после «Сохранить версию».`,
    }),
    el('p', {
      className: 'muted',
      textContent:
        head === null
          ? 'У карты пока нет версии в игре: первая сохранённая версия станет начальной.'
          : sent
            ? 'Заявка уже на проверке: новые правки в неё не попадут.'
            : 'Сохранённые версии идут по порядку; в игру попадает только принятая.',
    }),
  )
  if (!mayEditMap(id)) return part
  if (staleCopyIds.get(id) === copy) part.append(staleCopyActions(map, copy, line))
  const form = el('form', { className: 'stack' }),
    note = el('textarea', { name: 'note', required: true, maxLength: 200, rows: 2 })
  note.value = mapNotes.get(id) ?? ''
  note.addEventListener('input', () => mapNotes.set(id, note.value))
  const save = (review: boolean) => {
    if (!form.reportValidity()) return
    const submitted = note.value
    mapBusy(id, () => run(line, () => commitMap(map, copy, submitted, line, review), part))
  }
  form.append(
    field('Что изменилось', note, 'Коротко, для проверяющего и истории карты. До 200 символов.'),
    el(
      'div',
      { className: 'actions' },
      button('Сохранить и отправить на проверку', () => save(true), 'small primary'),
      button('Только сохранить версию', () => save(false), 'small'),
      // Commits never move the head (it moves on publish): offer the action for
      // the newest unpublished saved version unless that exact version is pending.
      unsent
        ? button(
            'Отправить последнюю версию',
            () => mapBusy(id, () => submitSaved(map, copy, line)),
            'small',
            `Отправить последнюю сохранённую версию ${name} на проверку`,
          )
        : null,
    ),
  )
  form.onsubmit = (event) => {
    event.preventDefault()
    save(true)
  }
  part.append(form)
  if (can('maps') && mapSession) {
    const rename = el('form', { className: 'form-grid' }),
      title = el('input', {
        name: 'name',
        required: true,
        maxLength: 100,
        value:
          map.draft?.workingCopyId === mapSession.id
            ? map.draft.name
            : String(map.mapJson.name ?? name),
      })
    rename.append(
      field(
        'Название в черновике',
        title,
        'Меняется в черновике; мастерская перезапустится. В игре название сменится вместе с принятой версией.',
      ),
      el(
        'div',
        { className: 'actions' },
        el('button', { type: 'submit', className: 'small', textContent: 'Переименовать' }),
      ),
    )
    rename.onsubmit = (event) => {
      event.preventDefault()
      run(
        line,
        async () => {
          const payload = await mapRequest(
            'maps/properties',
            {
              mapId: id,
              name: title.value,
              workingCopyId: copy,
              expectedRevision: controller.revision,
            },
            line,
            'Название сохранено в черновике. Сохраните версию, чтобы оно ушло на проверку.',
          )
          if (payload) await loadMapHistory()
        },
        rename,
      )
    }
    part.append(
      el(
        'details',
        { className: 'disclosure' },
        el('summary', { textContent: 'Переименовать карту' }),
        rename,
      ),
    )
  }
  part.append(line)
  if (busyMaps.has(id)) part.querySelectorAll('button').forEach((b) => (b.disabled = true))
  return part
}

function accessPanel(id: string, name: string, builders: StaffRow[]) {
  const line = mapLine(`${id}:access`),
    who = mapEditors(builders, id)
  return el(
    'div',
    { className: 'map-part' },
    el('p', {
      textContent: builders.length
        ? `Строить могут: ${who.length ? who.map((b) => b.name).join(', ') : 'никто из строителей'}. Модераторы и администраторы могут строить на всех картах.`
        : 'В команде нет строителей. Добавить их можно на вкладке «Команда».',
    }),
    can('workshop') && builders.length
      ? el(
          'div',
          { className: 'actions' },
          button(
            'Выбрать строителей',
            () => editMapAccess(id, name, builders, new Set(who.map((b) => b.uuid)), line),
            'small',
            `Выбрать строителей: ${name}`,
          ),
        )
      : null,
    line,
  )
}

function historyPanel(map: MapCatalogEntry) {
  const name = mapName(map.mapId),
    line = mapLine(`${map.mapId}:history`),
    head = map.head?.versionDigest ?? null,
    played = playedVersions(map)
  const rows = map.versions.map((version) => {
    const current = version.versionDigest === head,
      inGame = played.has(version.versionDigest),
      when = date(version.createdAt),
      tips = (map.snapshots ?? []).filter(
        (snapshot) => snapshot.versionDigest === version.versionDigest,
      )
    const main = el(
      'div',
      { className: 'row-main' },
      el(
        'strong',
        {},
        when,
        current
          ? el('span', { className: 'badge ok', textContent: 'В игре' })
          : inGame
            ? null
            : el('span', { className: 'badge', textContent: 'Ещё не в игре' }),
      ),
      el('small', {
        textContent: `${String(version.author.name ?? 'Автор не указан')}${version.parents?.length === 2 ? ' · принята с проверки' : ''} · изменено файлов ${version.changed.length}, удалено ${version.deleted.length}`,
      }),
      version.note ? el('p', { textContent: version.note }) : null,
      ...tips.map((snapshot) =>
        el('small', {
          textContent: `Снимок «${snapshot.name}» сейчас на этой версии.`,
        }),
      ),
      el('small', { className: 'digest', textContent: version.versionDigest }),
    )
    const actions = el('div', { className: 'actions' })
    // Only versions that already were in the game can come back without review; unsent work goes through «Ждут решения».
    if (can('workshop') && inGame && !current)
      actions.append(
        button(
          'Вернуть в игру',
          async () => {
            if (
              !(await ask({
                title: `Вернуть в игру «${name}» от ${when}?`,
                text:
                  map.kind === 'arena'
                    ? 'Появится новая версия с этим содержимым, она пойдёт в следующие матчи. История не стирается; уже начатые матчи доиграют на своей.'
                    : map.kind === 'limbo'
                      ? 'Сначала подготовьте эту версию для прокси. Сменить её можно только при остановленном прокси; геометрия и точка входа применятся при следующем запуске.'
                      : 'Будет выбрана эта версия игрового лобби. Она применяется при следующем безопасном запуске сервера.',
                ok: 'Вернуть в игру',
                danger: true,
              }))
            )
              return
            await run(line, async () => {
              const { id } = await api('candidates/rollback', 'POST', {
                mapId: map.mapId,
                versionDigest: version.versionDigest,
                expectedHead: head,
              })
              follow(line, id, `«${name}» от ${when} возвращена. ${goesLive(map.mapId)}`).then(
                loadMapHistory,
              )
              return 'применяем…'
            })
          },
          'small',
          `Вернуть в игру ${name}, версия от ${when}`,
        ),
      )
    if (map.kind === 'limbo' && can('workshop')) {
      const prepare = button(
        'Подготовить для прокси',
        () =>
          run(line, async () => {
            const { id } = await api('maps/export-limbo', 'POST', {
              versionDigest: version.versionDigest,
            })
            follow(line, id, 'Версия подготовлена. Прокси не перезапущен.')
            return 'применяем…'
          }),
        'small',
        `Подготовить лобби прокси, версия от ${when}`,
      )
      prepare.disabled = !mapSession
      if (!mapSession) prepare.title = 'Нужна открытая мастерская'
      actions.append(prepare)
    }
    return el('li', { className: 'row' }, main, actions.childElementCount ? actions : null)
  })
  return el(
    'div',
    { className: 'map-part' },
    el('h4', { textContent: 'История версий' }),
    map.kind === 'limbo'
      ? el('p', {
          className: 'muted',
          textContent:
            'Подготовьте версию в мастерской. Прокси нужно остановить, иначе версия не сменится.',
        })
      : null,
    line,
    el(
      'ul',
      { className: 'rows' },
      ...(rows.length
        ? rows
        : [
            el('li', {
              className: 'empty',
              textContent:
                'Исходная карта ещё не загружена в архив. Версии появятся после проверенного импорта.',
            }),
          ]),
    ),
  )
}

function snapshotsPanel(map: MapCatalogEntry, open: boolean) {
  const name = mapName(map.mapId),
    line = mapLine(`${map.mapId}:snapshots`),
    snapshots = map.snapshots ?? [],
    byId = new Map(map.versions.map((version) => [version.versionDigest, version]))
  const panel = el(
    'details',
    { className: 'disclosure map-advanced', dataMap: map.mapId, open },
    el('summary', { textContent: `Снимки · ${snapshots.length}` }),
    line,
    el(
      'ul',
      { className: 'rows' },
      ...snapshots.map((snapshot) => {
        const last = byId.get(snapshot.versionDigest)
        return el(
          'li',
          { className: 'row' },
          el(
            'div',
            { className: 'row-main' },
            el('strong', { textContent: `Снимок «${snapshot.name}»` }),
            el('small', {
              textContent: `${last ? versionLabel(last) : 'Версия не найдена'}${snapshot.versionDigest === map.head?.versionDigest ? ' · совпадает с игрой' : ''}`,
            }),
            el('small', { className: 'digest', textContent: snapshot.versionDigest }),
          ),
          can('workshop')
            ? el(
                'div',
                { className: 'actions' },
                button(
                  'Вернуть в игру',
                  async () => {
                    if (
                      !(await ask({
                        title: `Вернуть снимок «${snapshot.name}»?`,
                        text: 'Появится новая версия с его содержимым; история не стирается.',
                        ok: 'Вернуть в игру',
                        danger: true,
                      }))
                    )
                      return
                    await run(line, async () => {
                      const { id } = await api('candidates/rollback', 'POST', {
                        mapId: map.mapId,
                        versionDigest: snapshot.versionDigest,
                        expectedHead: map.head?.versionDigest ?? null,
                      })
                      follow(line, id, `Снимок «${snapshot.name}» возвращён.`).then(loadMapHistory)
                      return 'применяем…'
                    })
                  },
                  'small',
                  `Вернуть снимок ${snapshot.name} карты ${name} в игру`,
                ),
                button(
                  'Удалить',
                  async () => {
                    if (
                      !(await ask({
                        title: `Удалить снимок «${snapshot.name}»?`,
                        text: 'Версии истории останутся; исчезнет только именованный указатель.',
                        ok: 'Удалить',
                        danger: true,
                      }))
                    )
                      return
                    await run(line, async () => {
                      const payload = await mapRequest(
                        'maps/snapshots',
                        { mapId: map.mapId, action: 'delete', name: snapshot.name },
                        line,
                        'Снимок удалён.',
                      )
                      if (payload) await loadMapHistory()
                    })
                  },
                  'small',
                  `Удалить снимок ${snapshot.name} карты ${name}`,
                ),
              )
            : null,
        )
      }),
      ...(snapshots.length
        ? []
        : [el('li', { className: 'empty', textContent: 'Снимков пока нет.' })]),
    ),
  )
  if (!mayEditMap(map.mapId)) return panel
  if (map.versions.length) {
    const create = el('form', { className: 'form-grid' }),
      nameInput = el('input', {
        name: 'snapshot',
        required: true,
        maxLength: 64,
        pattern: '[a-z0-9][a-z0-9._\\-]{0,63}',
        autocomplete: 'off',
      })
    const from = el(
      'select',
      { name: 'version' },
      ...map.versions.map((version) =>
        el('option', { value: version.versionDigest, textContent: versionLabel(version) }),
      ),
    )
    create.append(
      field('Новый снимок', nameInput, 'Название «main» занято версией в игре.'),
      field('Версия', from),
      el(
        'div',
        { className: 'actions' },
        el('button', { type: 'submit', className: 'small', textContent: 'Создать снимок' }),
      ),
    )
    create.onsubmit = (event) => {
      event.preventDefault()
      const form = new FormData(create)
      run(
        line,
        async () => {
          const payload = await mapRequest(
            'maps/snapshots',
            {
              mapId: map.mapId,
              name: String(form.get('snapshot')),
              versionDigest: String(form.get('version')),
            },
            line,
            'Снимок создан.',
          )
          if (payload) await loadMapHistory()
        },
        create,
      )
    }
    panel.append(create)
  }
  return panel
}

function comparePanel(map: MapCatalogEntry) {
  if (map.versions.length < 2) return null
  const line = mapLine(`${map.mapId}:compare`),
    compare = el('form', { className: 'form-grid' }),
    output = kept(`${map.mapId}:compare`, () => el('div', {}))
  const choose = (key: string) =>
    el(
      'select',
      { name: key },
      ...map.versions.map((version) =>
        el('option', { value: version.versionDigest, textContent: versionLabel(version) }),
      ),
    )
  const before = choose('before') as HTMLSelectElement,
    after = choose('after') as HTMLSelectElement
  before.selectedIndex = 1
  // The kept result names its pair, so a re-render shows the selects that produced it.
  if (output.dataset.before) {
    before.value = output.dataset.before
    after.value = output.dataset.after!
  }
  compare.append(
    field('Сравнить: было', before),
    field('Стало', after),
    el(
      'div',
      { className: 'actions' },
      el('button', { type: 'submit', className: 'small', textContent: 'Сравнить версии' }),
    ),
  )
  compare.onsubmit = (event) => {
    event.preventDefault()
    const data = new FormData(compare)
    output.dataset.before = String(data.get('before'))
    output.dataset.after = String(data.get('after'))
    run(
      line,
      () =>
        compareMap(map.mapId, String(data.get('before')), String(data.get('after')), output, line),
      compare,
    )
  }
  return el(
    'details',
    { className: 'disclosure map-advanced', dataMap: map.mapId },
    el('summary', { textContent: 'Сравнение версий' }),
    line,
    compare,
    output,
  )
}

function renderMaps() {
  if (!mapCatalog) return
  const box = $('#map-history'),
    opened = (selector: string) =>
      new Set([...box.querySelectorAll<HTMLElement>(selector)].map((node) => node.dataset.map)),
    open = opened(':scope > details[open]'),
    openSnapshots = opened('details.map-advanced[open]'),
    builders = teamStaff?.filter((s) => s.role === 'builder')
  // The legacy hub is an access scope, not a map: it has builders but never versions.
  const entries: [string, MapCatalogEntry | null][] = [
    ...mapCatalog.map((map): [string, MapCatalogEntry] => [map.mapId, map]),
    ...(builders ? [['hub', null] as [string, null]] : []),
  ]
  box.replaceChildren(
    ...entries.map(([id, map]) => {
      const name = mapName(id),
        live = map?.versions.find((version) => version.versionDigest === map.head?.versionDigest),
        openInSession =
          !!map && !!mapSession && (mapSession.maps === null || mapSession.maps.includes(id)),
        waiting = candidateList.some((c) => c.status === 'pending' && c.mapId === id),
        arena = map?.kind === 'arena' && !!mapAvailability?.available,
        offWanted = arena && mapAvailability.disabledMapIds.includes(id),
        offApplied =
          arena &&
          Array.isArray(mapAvailability.applied?.disabledMapIds) &&
          mapAvailability.applied.disabledMapIds.includes(id),
        off = offWanted
          ? offApplied
            ? 'Выключена для матчей'
            : 'Выключается…'
          : offApplied
            ? 'Включается…'
            : '',
        who = builders ? mapEditors(builders, id).map((b) => b.name) : []
      const summary = el(
        'summary',
        {},
        el('strong', { textContent: name }),
        waiting ? el('span', { className: 'badge warn', textContent: 'Ждёт решения' }) : null,
        openInSession
          ? el('span', { className: 'badge ok', textContent: 'Открыта в мастерской' })
          : null,
        off ? el('span', { className: 'badge', textContent: off }) : null,
        el('span', {
          className: 'map-meta',
          textContent: [
            !map
              ? 'Общая зона мастерской, версий нет'
              : live
                ? `В игре: версия от ${date(live.createdAt)}`
                : map.versions.length
                  ? 'Ещё не в игре'
                  : 'Версий пока нет',
            builders ? `Строители: ${who.length ? who.join(', ') : 'нет'}` : null,
          ]
            .filter(Boolean)
            .join(' · '),
        }),
      )
      const availabilityLine = mapLine(`${id}:availability`)
      return el(
        'details',
        { className: 'disclosure', dataMap: id, open: open.has(id) },
        summary,
        el(
          'div',
          { className: 'map-body' },
          map && openInSession ? draftPanel(map) : null,
          builders ? accessPanel(id, name, builders) : null,
          map?.kind === 'arena' && map.head
            ? el(
                'div',
                { className: 'map-part' },
                mapAvailabilityControls(map, availabilityLine),
                availabilityLine,
              )
            : null,
          map ? historyPanel(map) : null,
          map ? snapshotsPanel(map, openSnapshots.has(id)) : null,
          map ? comparePanel(map) : null,
        ),
      )
    }),
  )
  box.querySelectorAll<HTMLSelectElement>('select').forEach(customSelect)
}

function renderSavedMapSessions() {
  $('#map-drafts').replaceChildren(
    ...savedMapSessions.map((saved) =>
      el(
        'li',
        { className: 'row' },
        el(
          'div',
          { className: 'row-main' },
          el('strong', {
            textContent: `${date(saved.startedAt)}${saved.id === mapSession?.id ? ' · текущий' : ''}`,
          }),
          el('small', {
            textContent: `${saved.startedBy?.name ?? 'Участник команды'} · ${(saved.maps ?? []).map((id) => mapName(id)).join(', ')}`,
          }),
        ),
        can('mode') && saved.id !== mapSession?.id
          ? el(
              'div',
              { className: 'actions' },
              button(
                'Продолжить черновик',
                async () => {
                  if (
                    !(await ask({
                      title: 'Продолжить сохранённый черновик?',
                      text: 'Текущая рабочая копия сохранится. Мастерская откроет прежние карты вместе с их несохранёнными правками. Игра продолжит работать.',
                      ok: 'Продолжить',
                      danger: true,
                    }))
                  )
                    return
                  const line = $('#map-drafts-status')
                  await run(line, async () => {
                    const { id } = await api('mode', 'POST', {
                      profile: 'workshop',
                      session: 'resume',
                      sessionId: saved.id,
                      expectedRevision: controller.revision,
                    })
                    await follow(line, id, 'Сохранённый черновик открыт.')
                    await loadMapHistory()
                  })
                },
                'small',
                `Продолжить черновик от ${date(saved.startedAt)}`,
              ),
            )
          : null,
      ),
    ),
  )
  if (!savedMapSessions.length)
    $('#map-drafts').append(
      el('li', {
        className: 'empty',
        textContent: 'Сохранённые черновики появятся после открытия сеанса мастерской.',
      }),
    )
  $('#map-drafts-more').hidden = savedSessionsNext === null
  say(
    $('#map-drafts-status'),
    `Показано черновиков: ${savedMapSessions.length} из ${savedSessionsTotal}.`,
  )
}

const mapName = (id: string) => {
  const map = mapCatalog?.find((map) => map.mapId === id)
  return String(
    (map?.draft?.workingCopyId === mapSession?.id ? map?.draft?.name : undefined) ??
      map?.mapJson.name ??
      WORKSHOP_PLACES[id] ??
      id,
  )
}

const mapScopes = () =>
  mapCatalog
    ? mapCatalog.map((map) => map.mapId)
    : Object.keys(WORKSHOP_PLACES).filter((id) => id !== 'hub')

async function loadMapHistory() {
  const data = await api('maps')
  const line = $('#map-history-status')
  if (!data.available) {
    say(line, data.error, 'error')
    $('#map-history').replaceChildren()
    return
  }
  mapCatalog = data.maps
  mapAvailability = data.availability
  mapCpRevisions = data.cpRevisions ?? {}
  mapSession = data.session
  editableMaps = new Set(data.editableMaps ?? [])
  savedMapSessions = data.sessions ?? []
  savedSessionsNext = data.sessionsNext ?? null
  savedSessionsTotal = data.sessionsTotal ?? savedMapSessions.length
  renderSavedMapSessions()
  say(line, '')
  renderMaps()
  await loadCandidates()
}

const reviewOutlets = new Map<string, HTMLElement>()

async function previewCandidate(candidate: any, outlet: HTMLElement, line: HTMLElement) {
  const map = mapCatalog?.find((entry) => entry.mapId === candidate.mapId)
  if (!map || (map.head?.versionDigest ?? null) !== candidate.targetHead)
    throw new Error(
      'Версию в игре сменили после отправки. Попросите автора отправить версию заново.',
    )
  const changes = el('div', {})
  outlet.replaceChildren(
    el('p', {
      textContent:
        candidate.targetHead === null
          ? 'Карты ещё нет в игре: эта версия станет первой.'
          : 'Принятие запишет её поверх версии в игре; история линейна, слияний нет.',
    }),
    changes,
  )
  if (candidate.targetHead !== null)
    await compareMap(candidate.mapId, candidate.targetHead, candidate.versionDigest, changes, line)
  if (can('workshop')) {
    const accept = button(
      'Принять в игру',
      async () => {
        if (
          !(await ask({
            title: `Принять «${mapName(candidate.mapId)}» в игру?`,
            text: `Применится присланная версия. ${goesLive(candidate.mapId)}`,
            ok: 'Принять в игру',
            danger: true,
          }))
        )
          return
        await run(
          line,
          async () => {
            const { id } = await api('candidates/publish', 'POST', {
              candidateId: candidate.id,
              mapId: candidate.mapId,
              expectedHead: candidate.targetHead,
            })
            const result = await follow(
              line,
              id,
              `Версия принята. ${goesLive(candidate.mapId)}`,
              (error) => mapRequestError(line, error),
            )
            if (result?.ok) {
              reviewOutlets.delete(candidate.id)
              await loadMapHistory()
            }
          },
          outlet,
        )
      },
      'small primary',
      `Принять ${mapName(candidate.mapId)} в игру`,
    )
    outlet.append(el('div', { className: 'actions' }, accept))
  }
  outlet.querySelectorAll<HTMLSelectElement>('select').forEach(customSelect)
}

const CANDIDATE_STATUS: Record<string, [string, string]> = {
  pending: ['Ждёт решения', 'warn'],
  accepted: ['Принята', 'ok'],
  published: ['В игре', 'ok'],
  rejected: ['Отклонена', ''],
  superseded: ['Заменена новой', ''],
  rolled_back: ['Заменена прежней версией', ''],
}

async function testMapCandidate(candidate: any, line: HTMLElement) {
  const modes = candidate.supportedModes
  if (
    !Array.isArray(modes) ||
    !modes.length ||
    modes.length > 7 ||
    new Set(modes).size !== modes.length ||
    !modes.every((id: string) => Object.hasOwn(ARENA_MODES, id))
  )
    throw new Error('Режимы сохранённой версии не подтверждены. Обновите список проверок.')
  const select = el(
      'select',
      { name: 'modeId', required: true },
      ...modes.map((id: keyof typeof ARENA_MODES) =>
        el('option', { value: id, textContent: ARENA_MODES[id] }),
      ),
    ),
    pending = ask({
      title: `Тестовый матч «${mapName(candidate.mapId)}»?`,
      text: 'Выберите режим. Мастерская перезапустится в закрытый тест на копии присланной версии. Заходят только тестеры; статистика игры не изменится.',
      ok: 'Начать тест',
      danger: true,
      fields: [field('Режим теста', select)],
    })
  customSelect(select)
  const form = await pending
  if (!form) return
  await run(line, async () => {
    const { id } = await api('mode', 'POST', {
      profile: 'test',
      expectedRevision: controller.revision,
      candidateId: candidate.id,
      modeId: String(form.get('modeId')),
    })
    await follow(
      line,
      id,
      `Тест «${mapName(candidate.mapId)}» запрошен. Готовность показана в обзоре.`,
    )
    await loadOverview()
  })
}

async function loadCandidates() {
  const { candidates } = await api('candidates')
  const line = $('#candidates-status')
  const list: any[] = (candidateList = candidates ?? [])
  const rows = list.map((c: any) => {
    const name = mapName(c.mapId),
      [label, tone] = CANDIDATE_STATUS[c.status] ?? [c.status, '']
    const decided = c.decidedBy ? ` · решил ${c.decidedBy.name} ${ago(c.decidedAt)}` : ''
    // baseMatches: false — the map's reference changed since editing started; null — unknown base (older drafts). Either needs a forced publish.
    // Two versions of one map need distinct accessible names on their buttons.
    const version = c.id.slice(0, 6)
    const baseWarn =
      c.baseMatches === false
        ? 'карту изменили, пока шла правка'
        : c.baseMatches === null
          ? 'неизвестно, с какой версии начата правка'
          : null
    const main = el(
      'div',
      { className: 'row-main' },
      el(
        'strong',
        {},
        `${name} `,
        el('span', { className: `badge ${tone}`, textContent: label }),
        baseWarn ? el('span', { className: 'badge warn', textContent: baseWarn }) : null,
      ),
      el('small', {
        textContent: `Отправил ${c.author?.name ?? '?'} ${ago(c.createdAt)}${c.native ? '' : ` · ${(c.size / 1048576).toFixed(1)} МБ`}${decided}`,
      }),
    )
    const actions = el('div', { className: 'actions' })
    if (mayEditMap(c.mapId)) {
      if (c.status !== 'pending') reviewOutlets.delete(c.id)
      const outlet = reviewOutlets.get(c.id) ?? el('div', { className: 'stack' })
      if (c.status === 'pending') reviewOutlets.set(c.id, outlet)
      const sent = mapCatalog
        ?.find((entry) => entry.mapId === c.mapId)
        ?.versions.find((version) => version.versionDigest === c.versionDigest)
      main.append(
        sent?.note ? el('p', { textContent: `«${sent.note}»` }) : null,
        el('small', {
          textContent: `Версия от ${sent ? date(sent.createdAt) : 'неизвестной даты'}. Правки после отправки сюда не входят.`,
        }),
        outlet,
      )
      if (can('workshop') && c.status === 'pending')
        actions.append(
          button(
            'Проверить и принять',
            () => run(line, () => previewCandidate(c, outlet, line)),
            'small primary',
            `Проверить и принять ${name}`,
          ),
        )
      actions.append(
        button(
          'Что изменилось',
          () =>
            run(line, async () => {
              const map = mapCatalog?.find((entry) => entry.mapId === c.mapId)
              if (!map) throw new Error('Карта не подтверждена. Обновите историю.')
              if (!map.head || !c.versionDigest)
                throw new Error('Версия заявки не подтверждена. Обновите историю.')
              await compareMap(c.mapId, map.head.versionDigest, c.versionDigest, outlet, line)
            }),
          'small',
          `Что изменилось в ${name} по сравнению с игрой`,
        ),
      )
    }
    const confirmForce = (reason: string) =>
      ask({
        title: `Всё равно принять «${name}»?`,
        text: `${reason} Версия сохранится с отметкой об этом, выпуск потребует отдельной проверки.`,
        ok: 'Всё равно принять',
        danger: true,
      })
    const publish = (force: boolean) =>
      run(line, async () => {
        const map = mapCatalog?.find((entry) => entry.mapId === c.mapId)
        if (!map) throw new Error('Сначала обновите историю карт. Текущая версия не подтверждена.')
        const { id } = await api('candidates/publish', 'POST', {
          candidateId: c.id,
          mapId: c.mapId,
          expectedHead: map.head?.versionDigest ?? null,
          ...(force ? { force: true } : {}),
        })
        follow(line, id, `Версия «${name}» принята и выбрана.`, async (error) => {
          // The controller never lets an older version replace a newer accepted one: retrying cannot help.
          if (/newer version/.test(error)) {
            say(
              line,
              'Уже принята более новая версия этой карты. Эту версию можно только отклонить.',
              'error',
            )
            return true
          }
          if (!/^base (changed|unknown)/.test(error)) return false
          if (await confirmForce('Пока шла правка, версию в игре, возможно, сменили.'))
            publish(true)
          else say(line, 'Публикация отменена.', 'error')
          return true
        }).then(() => Promise.all([loadCandidates(), loadMapHistory()]))
        return 'применяем…'
      })
    if (can('workshop') && c.status === 'pending') {
      actions.append(
        button(
          'Принять',
          async () => {
            if (
              !(await ask({
                title: `Принять «${name}»?`,
                text: `Эта версия пойдёт в игру. ${goesLive(c.mapId)}`,
                ok: 'Принять',
              }))
            )
              return
            if (
              baseWarn &&
              !(await confirmForce(
                c.baseMatches === false
                  ? 'Пока шла правка, версию в игре сменили — в этой версии может не оказаться тех изменений.'
                  : 'Неизвестно, с какой версии начата правка: она могла начаться со старой.',
              ))
            )
              return
            publish(!!baseWarn)
          },
          'small primary',
          `Принять ${name}, версия ${version}`,
        ),
        button(
          'Отклонить',
          async () => {
            if (
              !(await ask({
                title: `Отклонить эту версию «${name}»?`,
                text: 'Версия останется в списке как отклонённая, в игру она не попадёт.',
                ok: 'Отклонить',
                danger: true,
              }))
            )
              return
            run(line, async () => {
              const { id } = await api('candidates/reject', 'POST', {
                candidateId: c.id,
                mapId: c.mapId,
              })
              follow(line, id, 'Версия отклонена.').then(loadCandidates)
              return 'применяем…'
            })
          },
          'small danger',
          `Отклонить ${name}, версия ${version}`,
        ),
      )
    }
    if (
      can('mode') &&
      c.status === 'pending' &&
      controller?.phase === 'workshop' &&
      controller.gate === 'builders'
    ) {
      // Test sits before the decisions' danger end: accept first, reject last.
      actions.insertBefore(
        button(
          'Тестовый матч',
          () => run(line, () => testMapCandidate(c, line)),
          'small',
          `Тестовый матч ${name}, версия ${version}`,
        ),
        actions.querySelector('.danger'),
      )
    }
    if (can('workshop') && c.status === 'accepted' && c.sha256) {
      const link = el('a', {
        className: 'small',
        textContent: 'Скачать пакет',
        href: `/api/admin/candidates/download?id=${encodeURIComponent(c.id)}`,
      })
      actions.append(link)
    }
    if (can('workshop') && c.status === 'accepted' && c.native && !c.sha256) {
      actions.append(
        button(
          'Подготовить ZIP',
          () =>
            run(line, async () => {
              const { id } = await api('candidates/export', 'POST', {
                candidateId: c.id,
                mapId: c.mapId,
              })
              follow(line, id, 'Пакет готов к скачиванию.').then(loadCandidates)
              return 'применяем…'
            }),
          'small',
          `Экспортировать ${name}, версия ${version}`,
        ),
      )
    }
    return el('li', { className: 'row' }, main, actions)
  })
  const pending = rows.filter((_, i) => list[i].status === 'pending'),
    decided = rows.filter((_, i) => list[i].status !== 'pending').slice(0, 15)
  $('#candidate-list').replaceChildren(
    ...(pending.length
      ? pending
      : [
          el('li', {
            className: 'empty',
            textContent:
              'Новых заявок нет. Строитель отправляет карту из её карточки ниже или с планшета.',
          }),
        ]),
  )
  $('#decided').hidden = !decided.length
  $('#decided-summary').textContent = `Решённые заявки · ${decided.length}`
  $('#decided-list').replaceChildren(...decided)
  // Map cards show «Ждёт решения» and «уже на проверке»; re-render them only when that set changes (this runs on every status event).
  const key = list
    .filter((c) => c.status === 'pending')
    .map((c) => `${c.mapId}:${c.versionDigest ?? c.id}`)
    .sort()
    .join(',')
  if (key !== pendingKey) {
    pendingKey = key
    renderMaps()
  }
}

async function editMapAccess(
  mapId: string,
  name: string,
  builders: { uuid: string; name: string }[],
  current: Set<string>,
  line: HTMLElement,
) {
  const list = el(
    'div',
    { className: 'checks' },
    ...builders.map((b) =>
      el(
        'label',
        { className: 'check' },
        el('input', {
          type: 'checkbox',
          name: 'builder',
          value: b.uuid,
          checked: current.has(b.uuid),
        }),
        b.name,
      ),
    ),
  )
  const answer = await ask({
    title: `Кто строит: «${name}»`,
    text: 'Отметьте строителей, которые могут здесь строить. Остальные зайдут только посмотреть.',
    ok: 'Сохранить',
    fields: [list],
  })
  if (!answer) return
  await run(
    line,
    async () => {
      const { changed, sync } = await api('staff/map-access', 'POST', {
        mapId,
        uuids: answer.getAll('builder').map(String),
      })
      await loadTeam()
      if (!changed.length) return 'Ничего не изменилось.'
      return sync?.error
        ? `Доступ к карте «${name}» сохранён, но мастерская его ещё не получила — нажмите «Обновить доступ».`
        : `Доступ к карте «${name}» обновлён.`
    },
    line.parentElement,
  )
}

function initAdminWorkshop(): void {
  $('#ai-budget-refresh').onclick = async () => {
    if (
      await ask({
        title: 'Обновить бюджет AI?',
        text: 'Несохранённые изменения бюджета будут заменены сохранённой политикой.',
        ok: 'Обновить',
      })
    )
      run($('#ai-budget-status'), loadAiBudget)
  }

  $<HTMLSelectElement>('#workshop-ai-key-provider').addEventListener(
    'change',
    refreshCustomKeyStatus,
  )

  $('#workshop-ai-provider-add').onclick = () => {
    const line = $('#workshop-ai-status')
    try {
      const entry = checkProviderForm()
      if (editingProvider) {
        draftProviders = draftProviders.map((other) =>
          other.id === editingProvider ? entry : other,
        )
      } else draftProviders = [...draftProviders, entry]
      clearProviderForm()
      renderProviders()
      refreshProviderSelects()
      say(line, 'Провайдер в черновике. Сохраните AI мастерской.', 'pending')
    } catch (error) {
      say(line, (error as Error).message, 'error')
    }
  }

  $('#workshop-ai-provider-cancel').onclick = () => clearProviderForm()

  $('#workshop-ai-form').onsubmit = (event) => {
    event.preventDefault()
    run($('#workshop-ai-status'), async () => {
      const int = (id: string) => {
        const value = Number($<HTMLInputElement>(id).value)
        if (!Number.isSafeInteger(value)) throw new Error('Целое число вне диапазона.')
        return value
      }
      const decimal = (id: string) => {
        const value = Number($<HTMLInputElement>(id).value.replace(',', '.'))
        if (!Number.isFinite(value)) throw new Error('Число вне диапазона.')
        return value
      }
      const body = {
        expectedRevision: workshopAiRevision,
        cpRevisions: workshopAiCpRevisions,
        enabled: $<HTMLInputElement>('#workshop-ai-enabled').checked,
        provider: $<HTMLSelectElement>('#workshop-ai-provider').value,
        generationProvider: $<HTMLSelectElement>('#workshop-ai-generation-provider').value,
        transcriptionProvider: $<HTMLSelectElement>('#workshop-ai-transcription-provider').value,
        providers: draftProviders,
        generationModel: $<HTMLInputElement>('#workshop-ai-generation').value.trim(),
        transcriptionModel: $<HTMLInputElement>('#workshop-ai-transcription').value.trim(),
        cleanupModel: $<HTMLInputElement>('#workshop-ai-cleanup').value.trim(),
        cleanupProvider: $<HTMLSelectElement>('#workshop-ai-cleanup-provider').value,
        maxBlocks: int('#workshop-ai-max-blocks'),
        blocksPerTick: int('#workshop-ai-blocks-per-tick'),
        minimumBuildTicks: int('#workshop-ai-minimum-build-ticks'),
        applyBudgetMs: int('#workshop-ai-apply-budget-ms'),
        hourlyRequestLimit: int('#workshop-ai-hourly-request-limit'),
        hourlyPlayerRequestLimit: int('#workshop-ai-hourly-player-request-limit'),
        maxHourlyBuilders: int('#workshop-ai-max-hourly-builders'),
        generationMaxPricePromptUsdPerM: decimal('#workshop-ai-prompt-cap'),
        generationMaxPriceCompletionUsdPerM: decimal('#workshop-ai-completion-cap'),
      }
      try {
        const { settings, cpRevisions: savedWorkshopAiCp } = await api(
          'workshop-ai-settings',
          'PUT',
          body,
        )
        workshopAiRevision = settings.revision
        workshopAiCpRevisions = savedWorkshopAiCp ?? {}
        return `Настройки сохранены, ревизия ${settings.revision}.`
      } catch (error) {
        if ((error as Error & { status?: number }).status === 409) {
          await loadWorkshopAi()
          throw new Error('Настройки уже изменил кто-то другой. Показаны сохранённые значения.', {
            cause: error,
          })
        }
        throw error
      }
    })
  }

  $('#workshop-ai-key-save').onclick = () => {
    const field = $<HTMLInputElement>('#workshop-ai-key')
    const key = field.value
    const endpoint = keyEndpoint()
    const line = keyLine()
    if (!key) {
      say(line, 'Вставьте ключ в поле «Новый ключ».', 'error')
      return
    }
    run(line, async () => {
      const { id } = await api(
        endpoint,
        'POST',
        endpoint === 'workshop-ai-provider-key' ? { provider: keyProvider(), key } : { key },
      )
      field.value = ''
      say(line, 'Ключ применяется…', 'pending')
      await pollWorkshopAiKey(id, endpoint, line)
    })
  }

  $('#workshop-ai-key-delete').onclick = async () => {
    const endpoint = keyEndpoint()
    const line = keyLine()
    const provider = providerName(keyProvider())
    if (
      !(await ask({
        title: `Удалить ключ ${provider}?`,
        text: 'Мастерская потеряет доступ к AI, пока не сохраните новый ключ.',
        ok: 'Удалить',
        danger: true,
      }))
    )
      return
    run(line, async () => {
      const { id } = await api(
        endpoint,
        'POST',
        endpoint === 'workshop-ai-provider-key'
          ? { provider: keyProvider(), key: null }
          : { key: null },
      )
      $<HTMLInputElement>('#workshop-ai-key').value = ''
      say(line, 'Ключ применяется…', 'pending')
      await pollWorkshopAiKey(id, endpoint, line)
    })
  }

  $('#workshop-ai-refresh').onclick = async () => {
    if (
      await ask({
        title: 'Обновить AI мастерской?',
        text: 'Несохранённые изменения настроек будут заменены сохранёнными.',
        ok: 'Обновить',
      })
    )
      run($('#workshop-ai-status'), loadWorkshopAi)
  }

  $('#map-create-controls').append(newMapControls())

  $('#map-drafts-more').onclick = () =>
    run(
      $('#map-drafts-status'),
      async () => {
        if (savedSessionsNext === null) return
        const data = await mapRequest(
          'maps/sessions',
          { offset: savedSessionsNext, limit: 100 },
          $('#map-drafts-status'),
          'Следующие черновики получены.',
        )
        if (!data) return
        if (
          !Array.isArray(data.sessions) ||
          !Number.isSafeInteger(data.total) ||
          !(data.next === null || Number.isSafeInteger(data.next))
        )
          throw new Error('Не удалось загрузить черновики. Обновите историю и попробуйте ещё раз.')
        const byId = new Map(
          [...savedMapSessions, ...data.sessions].map((saved) => [saved.id, saved]),
        )
        savedMapSessions = [...byId.values()]
        savedSessionsNext = data.next
        savedSessionsTotal = data.total
        renderSavedMapSessions()
      },
      $('#map-drafts-more').parentElement,
    )

  $('#maps-refresh').onclick = () => run($('#map-history-status'), loadMapHistory)

  $<HTMLFormElement>('#grant-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const form = e.currentTarget as HTMLFormElement,
      data = new FormData(form),
      name = String(data.get('nickname')),
      role = String(data.get('role'))
    if (
      !(await ask({
        title: `Добавить ${name} в команду?`,
        text: `Роль: ${ROLES[role].name}. ${ROLES[role].about}`,
        ok: 'Добавить',
      }))
    )
      return
    const line = form.querySelector<HTMLElement>('.form-status')!
    await changeRole({ name, role }, `${name} добавлен в команду.`, line)
    if (line.classList.contains('ok')) form.reset()
  })

  $('#sync').addEventListener('click', () => {
    const line = $('#sync-status')
    run(
      line,
      async () => {
        const { id } = await api('staff/sync', 'POST', {})
        follow(line, id, 'Доступ в мастерскую обновлён.').then(loadTeam)
        return 'применяем…'
      },
      $('#sync').parentElement,
    )
  })
}

export {
  initAdminWorkshop,
  setLoadOverview,
  loadWorkshopAi,
  loadAiBudget,
  loadTeam,
  loadCandidates,
  loadMapHistory,
  mapName,
  mapScopes,
}
