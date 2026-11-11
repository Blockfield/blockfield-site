// Admin page wiring: nav, presence, timers, events, message/range/maintenance,
// boot. Extracted verbatim from src/pages/admin.astro (SITE95-U3).
import { customCombo } from '../lib/custom-select'
import { NAV_GROUPS, resolveTab } from '../lib/admin-navigation'
import type { Me } from '../lib/admin-shell'
import {
  $,
  ROLES,
  me,
  setMe,
  can,
  api,
  el,
  say,
  run,
  moderate,
  ask,
  reasonField,
  pendingRequests,
  requestResult,
  toast,
  avatar,
  controller,
} from '../lib/admin-shell'
import {
  changeToast,
  loadGunBalance,
  loadKits,
  loadSettings,
  settingsEvent,
} from '../lib/admin-settings'
import {
  loadAiBudget,
  loadCandidates,
  loadMapHistory,
  loadTeam,
  loadWorkshopAi,
  setLoadOverview,
} from '../lib/admin-workshop'
import {
  getLastWorkshop,
  getSavedMessage,
  loadOverview,
  renderGameOverview,
  renderOverview,
  setSavedMessage,
} from '../lib/admin-overview'
import { loadBans, loadOnline, playerAction } from '../lib/admin-players'
import { loadKeys, loadResults, loadSeasons } from '../lib/admin-stats'
import { loadAudit, prependAudit } from '../lib/admin-journal'
import { loadHealth, tps } from '../lib/admin-health'
import '../lib/admin-console'

setLoadOverview(loadOverview)

function renderPresence(presence: (Me & { tab: string })[]) {
  const others = presence
    .filter((person) => person.uuid !== me.uuid)
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  $('#who').replaceChildren(el('span', { textContent: 'в панели:' }), ...others.map(avatar))
  document.querySelectorAll<HTMLElement>('[data-presence-slot]').forEach((slot) => {
    slot.replaceChildren(
      ...others
        .filter((person) => person.tab === slot.dataset.presenceSlot)
        .slice(0, 3)
        .map(avatar),
    )
  })
}

function sendPresence() {
  if (document.visibilityState === 'visible')
    api('presence', 'POST', { tab: location.hash.slice(1) }).catch(() => {})
}

async function loadLiveTps() {
  if (!can('diagnostics')) return
  try {
    const live = await api('diagnostics/live')
    $('#s-tps').textContent = tps(live.tps)
  } catch {
    $('#s-tps').textContent = '—'
  }
}

let presenceTimer: ReturnType<typeof setInterval> | undefined

let tpsTimer: ReturnType<typeof setInterval> | undefined

function visibleTimers() {
  clearInterval(presenceTimer)
  clearInterval(tpsTimer)
  if (document.visibilityState !== 'visible') return
  sendPresence()
  presenceTimer = setInterval(sendPresence, 30_000)
  if (can('diagnostics')) {
    void loadLiveTps()
    tpsTimer = setInterval(() => void loadLiveTps(), 60_000)
  }
}

function refreshCurrentTab() {
  const loaders: Record<string, (() => Promise<void>)[]> = {
    overview: [loadOverview],
    players: [loadOnline, ...(can('ban') ? [loadBans] : [])],
    matches: [loadOverview],
    settings: [async () => settingsEvent(await api('settings'))],
    weapons: [loadGunBalance],
    kits: [async () => loadKits(true)],
    workshop: [loadCandidates, loadMapHistory],
    stats: [loadResults, loadSeasons, loadKeys],
    team: [loadTeam],
    journal: [loadAudit],
    health: [loadHealth],
  }
  for (const load of loaders[location.hash.slice(1)] ?? []) load().catch(() => {})
}

function startEvents() {
  const events = new EventSource('/api/admin/events')
  let disconnected = false
  events.addEventListener('open', () => {
    $('#conn').dataset.tone = 'live'
    $('#conn').textContent = 'live'
    if (disconnected) {
      refreshCurrentTab()
      for (const [id, finish] of pendingRequests)
        api(`request?id=${id}`)
          .then(({ result }) => {
            if (result) finish(result)
          })
          .catch(() => {})
    }
    disconnected = false
  })
  events.addEventListener('error', () => {
    disconnected = true
    $('#conn').dataset.tone = 'bad'
    $('#conn').textContent = 'нет связи'
  })
  events.addEventListener(
    'status',
    (event) => void renderOverview(JSON.parse((event as MessageEvent).data)).catch(() => {}),
  )
  events.addEventListener('rooms', (event) => {
    const { rooms } = JSON.parse((event as MessageEvent).data)
    renderGameOverview(controller, rooms, getLastWorkshop())
  })
  events.addEventListener(
    'settings',
    (event) => void settingsEvent(JSON.parse((event as MessageEvent).data)).catch(() => {}),
  )
  events.addEventListener('audit', (event) =>
    prependAudit(JSON.parse((event as MessageEvent).data).entry),
  )
  events.addEventListener('presence', (event) =>
    renderPresence(JSON.parse((event as MessageEvent).data).presence),
  )
  events.addEventListener('request', (event) => {
    const { id, result } = JSON.parse((event as MessageEvent).data)
    requestResult(id, result)
  })
  document.addEventListener('visibilitychange', visibleTimers)
  addEventListener(
    'pagehide',
    () => {
      events.close()
      clearInterval(presenceTimer)
      clearInterval(tpsTimer)
    },
    { once: true },
  )
}

function renderNav() {
  const nav = $('#tabs'),
    labels = new Map(
      [...document.querySelectorAll<HTMLElement>('.admin-content > section')].map((s) => [
        s.id,
        s.dataset.tab ?? s.id,
      ]),
    )
  nav.replaceChildren(
    ...NAV_GROUPS.map((group) => {
      const links = group.tabs
        .filter((tab) => can(tab.perm) && labels.has(tab.id))
        .map((tab) =>
          el(
            'a',
            { href: `#${tab.id}` },
            el('span', { textContent: labels.get(tab.id) }),
            ['players', 'matches'].includes(tab.id)
              ? el('span', {
                  className: 'cnt',
                  id: tab.id === 'players' ? 'n-online' : 'n-matches',
                  textContent: '—',
                })
              : null,
            el('span', { className: 'presence-slot', 'data-presence-slot': tab.id }),
          ),
        )
      if (!links.length) return null
      return el(
        'span',
        { className: 'tabs__group', role: 'group', ariaLabel: group.label },
        el('span', { className: 'tabs__label', ariaHidden: 'true', textContent: group.label }),
        ...links,
      )
    }).filter((g): g is HTMLElement => g !== null),
  )
  nav.hidden = false
}

function showTab(id: string, focus: boolean) {
  const target = `#${resolveTab(me.role, me.permissions, id)}`
  if (location.hash !== target) window.history.replaceState(null, '', target)
  const tabs = [...document.querySelectorAll<HTMLAnchorElement>('#tabs a')]
  const current = tabs.find((t) => t.hash === target) ?? tabs[0]
  if (!current) return
  tabs.forEach((t) =>
    t === current ? t.setAttribute('aria-current', 'page') : t.removeAttribute('aria-current'),
  )
  current.scrollIntoView({ block: 'nearest', inline: 'center' })
  document
    .querySelectorAll<HTMLElement>('.admin-content > section')
    .forEach((s) => (s.hidden = `#${s.id}` !== current.hash))
  sendPresence()
  const section = document.querySelector<HTMLElement>(current.hash)
  if (focus) {
    section?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true })
    window.scrollTo(0, 0)
  }
}

addEventListener('hashchange', () => showTab(location.hash.slice(1), true))

let messageInFlight = false

let messageTimer: ReturnType<typeof setTimeout> | undefined

async function commitMessage() {
  clearTimeout(messageTimer)
  const input = $<HTMLTextAreaElement>('#message'),
    value = input.value.trim()
  if (!value || value === getSavedMessage() || messageInFlight) return
  const line = $('#message-form .form-status')
  const previous = getSavedMessage()
  messageInFlight = true
  try {
    await moderate(
      line,
      { message: value },
      'применено',
      () => {
        setSavedMessage(value)
        if (previous)
          void changeToast('Сообщение мастерской', previous, value, false, async () => {
            try {
              const { status } = await api('overview')
              if (getSavedMessage() !== value || status?.message !== value) {
                toast('Сообщение уже изменено. Отмена недоступна.')
                return
              }
              input.value = previous
              await commitMessage()
            } catch (error) {
              say(line, (error as Error).message, 'error')
            }
          })
      },
      null,
      'message',
    )
  } catch (error) {
    say(line, (error as Error).message, 'error')
  } finally {
    messageInFlight = false
    if (input.value.trim() !== value) void commitMessage()
  }
}

$('#message-form').addEventListener('submit', (e) => e.preventDefault())

$('#message').addEventListener('blur', () => void commitMessage())

$('#message').addEventListener('input', () => {
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => void commitMessage(), 1200)
})

const RANGE: Record<string, { title: string; text: string; ok: string; done: string }> = {
  open: {
    title: 'Открыть полигон?',
    text: 'Игроки смогут заходить на тренировочную площадку.',
    ok: 'Открыть',
    done: 'Полигон открыт.',
  },
  close: {
    title: 'Закрыть полигон?',
    text: 'Все, кто сейчас на полигоне, вернутся в лобби.',
    ok: 'Закрыть',
    done: 'Полигон закрыт.',
  },
  reset: {
    title: 'Сбросить полигон?',
    text: 'Площадка вернётся в исходное состояние, игроки на ней вернутся в лобби.',
    ok: 'Сбросить',
    done: 'Полигон сброшен.',
  },
}

document.querySelectorAll<HTMLButtonElement>('[data-range]').forEach((b) =>
  b.addEventListener('click', async () => {
    const spec = RANGE[b.dataset.range!]
    if (!(await ask({ ...spec, danger: b.dataset.range !== 'open' }))) return
    moderate(
      $('#range-status'),
      { action: 'range', op: b.dataset.range },
      spec.done,
      undefined,
      b.parentElement,
    )
  }),
)

async function loadMaintState() {
  const line = $('#maint-state')
  try {
    const [{ output }, { rooms }] = await Promise.all([
      api('rcon', 'POST', { action: 'maintenance-status' }),
      api('overview'),
    ])
    const draining = /(^|\s)draining=true(\s|$)/.test(String(output ?? ''))
    const entry = rooms?.maintenance
      ? 'вход закрыт'
      : rooms?.available === false
        ? 'вход недоступен'
        : 'вход открыт'
    say(
      line,
      `Состояние: ${rooms?.maintenance ? 'техработы' : draining ? 'новые матчи не начинаются' : 'обычный режим'} (${entry}${draining ? ', новые матчи не начинаются' : ''}).`,
    )
  } catch {
    say(line, 'Состояние: неизвестно, не удалось опросить сервер.', 'error')
  }
}

$('#drain').addEventListener('click', async () => {
  if (
    !(await ask({
      title: 'Не начинать новые матчи?',
      text: 'Идущие матчи доиграют. Новые не начнутся.',
      ok: 'Не начинать новые',
      danger: true,
    }))
  )
    return
  run(
    $('#maint-status'),
    async () => {
      await api('rcon', 'POST', { action: 'drain' })
      loadMaintState().catch(() => {})
      return 'Новые матчи больше не начинаются.'
    },
    $('#drain').parentElement,
  )
})

$('#resume').addEventListener('click', async () => {
  run(
    $('#maint-status'),
    async () => {
      await api('rcon', 'POST', { action: 'resume' })
      loadMaintState().catch(() => {})
      return 'Новые матчи снова разрешены.'
    },
    $('#resume').parentElement,
  )
})

const maintStart = document.querySelector<HTMLButtonElement>('#maint-start')

const maintStop = document.querySelector<HTMLButtonElement>('#maint-stop')

if (maintStart && maintStop) {
  maintStart.addEventListener('click', async () => {
    if (
      !(await ask({
        title: 'Начать техработы?',
        text: 'Вход в игру закроется для всех.',
        ok: 'Начать техработы',
        danger: true,
      }))
    )
      return
    run(
      $('#maint-status'),
      async () => {
        await api('gate', 'POST', { action: 'maintenance-start' })
        loadMaintState().catch(() => {})
        return 'Техработы начаты, вход закрыт.'
      },
      maintStart.parentElement,
    )
  })
  maintStop.addEventListener('click', async () => {
    run(
      $('#maint-status'),
      async () => {
        await api('gate', 'POST', { action: 'maintenance-stop' })
        loadMaintState().catch(() => {})
        return 'Техработы закончены, вход открыт.'
      },
      maintStop.parentElement,
    )
  })
}

$('#interrupt').addEventListener('click', async () => {
  const answer = await ask({
    title: 'Прервать все матчи?',
    text: 'Все идущие матчи сразу остановятся без победителя, игроки вернутся в лобби. Это нельзя отменить.',
    ok: 'Прервать все матчи',
    danger: true,
    fields: [reasonField('Причина (увидят все игроки)', true)],
  })
  if (!answer) return
  run(
    $('#maint-status'),
    async () => {
      await api('rcon', 'POST', { action: 'interrupt', reason: String(answer.get('reason')) })
      loadOverview()
      loadMaintState().catch(() => {})
      return 'Все матчи прерваны.'
    },
    $('#interrupt').parentElement,
  )
})

$<HTMLFormElement>('#say-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const form = e.currentTarget as HTMLFormElement,
    input = $<HTMLInputElement>('#say-text')
  moderate(
    form.querySelector<HTMLElement>('.form-status')!,
    { action: 'say', text: input.value },
    'Объявление отправлено.',
    () => {
      input.value = ''
    },
    form,
  )
})

$<HTMLFormElement>('#byname-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const form = e.currentTarget as HTMLFormElement
  playerAction(
    (e.submitter as HTMLButtonElement | null)?.value || 'kick',
    $<HTMLInputElement>('#byname').value,
    form.querySelector<HTMLElement>('.form-status')!,
  )
})

$('#online-refresh').addEventListener('click', () => {
  $('#online-summary').textContent = 'Обновляем…'
  loadOnline()
})

async function loadPlayerHints() {
  const inputs = [$<HTMLInputElement>('#byname'), $<HTMLInputElement>('#grant-name')].filter(
    Boolean,
  )
  if (!inputs.length) return
  const setters = inputs.map((input) => customCombo(input))
  const { players } = await api('players')
  setters.forEach((set) => set(players))
}

const failed = (where: string) => (error: Error) => {
  const w = $('#whoami')
  w.append(el('span', { className: 'error', textContent: ` ${where}: ${error.message}` }))
}

api('me').then(
  async (data: Me & { role: string | null }) => {
    setMe(data)
    const who = $('#whoami')
    if (!me.role) {
      who.textContent =
        'У вашего аккаунта нет доступа к панели. Попросите администратора добавить вас в команду.'
      return
    }
    who.replaceChildren(
      avatar(me),
      el('span', { textContent: `${me.name} · ${ROLES[me.role].name.toLowerCase()}` }),
    )
    document.querySelectorAll<HTMLElement>('[data-perm]').forEach((node) => {
      node.hidden = !can(node.dataset.perm!)
    })
    // A hidden submit would still fire on Enter: disable it too, so Enter picks a permitted action.
    document
      .querySelectorAll<HTMLButtonElement>('#byname-form button[data-perm]')
      .forEach((b) => (b.disabled = b.hidden))
    if (!can('ban'))
      $('#byname-about').textContent =
        'Если игрока нет в списке «Сейчас на сервере», его можно выгнать по никнейму.'
    renderNav()
    showTab(location.hash.slice(1), false)
    // Workshop reads are view-gated (safe existing GET maps/candidates), so a builder lands on a full tab.
    const loaders: [string, () => Promise<void>, string][] = [
      ['view', loadOverview, 'Обзор'],
      ['moderate', loadOnline, 'Игроки'],
      ['ban', loadBans, 'Забаненные'],
      ['settings', () => loadSettings(), 'Настройки'],
      ['settings', loadGunBalance, 'Баланс оружия'],
      ['settings', loadKits, 'Наборы'],
      ['ai', loadAiBudget, 'Бюджет AI'],
      ['ai', loadWorkshopAi, 'AI мастерской'],
      ['roles', loadTeam, 'Команда'],
      ['view', loadCandidates, 'Кандидаты'],
      ['view', loadMapHistory, 'Архив карт'],
      ['stats', loadResults, 'Статистика'],
      ['stats', loadSeasons, 'Сезоны'],
      ['stats', loadKeys, 'Ключи'],
      ['audit', loadAudit, 'Журнал'],
      ['diagnostics', loadHealth, 'Производительность'],
      ['maintenance', loadMaintState, 'Состояние техработ'],
      ['moderate', loadPlayerHints, 'Подсказки игроков'],
    ]
    await Promise.all(
      loaders
        .filter(([permission]) => can(permission))
        .map(([, load, where]) => load().catch(failed(where))),
    )
    startEvents()
    visibleTimers()
  },
  (error: Error & { raw?: string }) => {
    const who = $('#whoami')
    if (/Войдите|Сессия/.test(error.raw ?? ''))
      who.replaceChildren(
        'Войдите в ',
        el('a', { href: '/account', textContent: 'аккаунт' }),
        ', чтобы открыть панель управления.',
      )
    else say(who, error.message, 'error')
  },
)
