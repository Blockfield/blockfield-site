// Admin overview + matches tabs (status cards, rooms, start/stop flows).
// Extracted verbatim from src/pages/admin.astro (SITE95-U3).
import { WORKSHOP_PLACES } from '../lib/game-names'
import { gameReady, switchView } from '../lib/switch-status'
import {
  $,
  ago,
  api,
  ask,
  button,
  can,
  controller,
  date,
  el,
  follow,
  moderate,
  reasonField,
  run,
  say,
  setController,
} from '../lib/admin-shell'
import { loadCandidates, loadMapHistory, mapName, mapScopes } from '../lib/admin-workshop'

const PHASES: Record<string, string> = {
  IDLE: 'Ждёт игроков',
  VOTING: 'Голосование за карту',
  PREPARING: 'Подготовка к бою',
  GAME: 'Идёт бой',
  MATCH_END: 'Подведение итогов',
}

const OUTCOMES: [string, string, string][] = [
  ['draw', 'Ничья', 'Без победителя.'],
  ['RED', 'Победа красных', ''],
  ['BLUE', 'Победа синих', ''],
  ['none', 'Без итога', 'Без победителя и результата.'],
]

let session: any = null

let savedMessage = ''

function getSavedMessage() {
  return savedMessage
}

function setSavedMessage(value: string) {
  savedMessage = value
}

function timing(view: ReturnType<typeof switchView>): string {
  return [
    typeof view.since === 'number' ? `началось ${ago(view.since)}` : null,
    typeof view.deadline === 'number' ? `автоматический откат ${ago(view.deadline)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

function sessionLine(current: any): string | null {
  if (!current) return null
  const maps = current.maps ? current.maps.map((id: string) => mapName(id)).join(', ') : 'все карты'
  const when = typeof current.startedAt === 'number' ? ` ${ago(current.startedAt)}` : ''
  return `Сеанс: ${maps} · начал ${current.startedBy?.name ?? '?'}${when}.`
}

function describeWorkshop(
  state: any,
  current: any,
  testCandidate: any,
): { tone: string; title: string; detail: string } {
  const view = switchView(state),
    when = timing(view)
  switch (state?.schema === 1 ? state.phase : undefined) {
    case 'workshop':
      if (state.gate !== 'builders') break
      return {
        tone: 'ok',
        title: 'Мастерская открыта',
        detail: [sessionLine(current), 'Доступна участникам команды с выданными правами.']
          .filter(Boolean)
          .join(' '),
      }
    case 'test': {
      if (state.gate !== 'testers') break
      const name = testCandidate
        ? (WORKSHOP_PLACES[testCandidate.mapId] ?? testCandidate.mapId)
        : 'карта'
      const who = testCandidate?.author?.name
        ? ` (кандидат от ${testCandidate.author.name}, ${ago(testCandidate.createdAt)})`
        : ''
      return {
        tone: 'warn',
        title: `Тестовый матч: ${name}${who}`,
        detail: [sessionLine(current), 'Заходить могут только тестеры.'].filter(Boolean).join(' '),
      }
    }
    case 'DRAINING':
      return {
        tone: 'warn',
        title: 'Мастерская готовится к смене режима',
        detail: [view.step, when].filter(Boolean).join(' · '),
      }
    case 'REQUESTED':
    case 'SAVING':
    case 'STARTING':
      return {
        tone: 'warn',
        title: view.step ?? 'Мастерская перезапускается',
        detail: when || 'Вход в мастерскую временно закрыт.',
      }
    case 'sleeping':
      return {
        tone: 'warn',
        title: 'Мастерская спит',
        detail:
          'Никого нет, мастерская спит и не занимает память. Она проснётся, когда строитель зайдёт, или по кнопке ниже.',
      }
    case 'ERROR':
      return {
        tone: 'bad',
        title: 'Мастерская недоступна из-за ошибки',
        detail: [
          view.errorMessage ? `Причина: ${view.errorMessage}.` : null,
          can('recover') ? 'Нажмите «Восстановить мастерскую».' : 'Сообщите администратору.',
        ]
          .filter(Boolean)
          .join(' '),
      }
  }
  return {
    tone: 'warn',
    title: 'Готовность мастерской не подтверждена',
    detail: 'Ждём ответа сервера.',
  }
}

function describeGame(state: any, rooms: any): { tone: string; title: string; detail: string } {
  if (rooms.maintenance)
    return { tone: 'warn', title: 'Вход в игру закрыт', detail: rooms.maintenance.message }
  // site#82: a fresh live answer from the game server confirms readiness by itself; the
  // controller verdict may fossilize while a match runs, so it only blocks when nothing answers.
  if (!gameReady(state) && !rooms.available)
    return {
      tone: 'warn',
      title:
        state?.game?.phase === 'STARTING' ? 'Игра запускается' : 'Готовность игры не подтверждена',
      detail: 'Ждём ответа сервера.',
    }
  if (rooms.available)
    return {
      tone: 'ok',
      title: 'Игра работает',
      detail: `Идёт матчей: ${rooms.rooms?.length ?? 0}`,
    }
  return {
    tone: 'bad',
    title: 'Игровой сервер не отвечает',
    detail: rooms.lobby
      ? 'Лобби работает, но матчи сейчас недоступны.'
      : 'Игроки сейчас не могут зайти.',
  }
}

let lastWorkshop: ReturnType<typeof describeWorkshop> | undefined

async function loadOverview() {
  await renderOverview(await api('overview'))
}

async function renderOverview({ status: state, session: sessionData, rooms }: any) {
  // Map cards offer save/review only inside a verified open session: re-read them when the phase moves.
  const phaseChanged =
    !!controller && (controller.phase !== state?.phase || controller.gate !== state?.gate)
  setController(state)
  session = sessionData
  // The candidate behind a running test match: same source the candidates card reads, "view" permission covers it.
  const testCandidate =
    state?.phase === 'test' && state?.desired?.candidate
      ? ((await api('candidates').catch(() => ({ candidates: [] }))).candidates?.find(
          (c: any) => c.sha256 === state.desired.candidate,
        ) ?? null)
      : null
  const workshop = (lastWorkshop = describeWorkshop(state, session, testCandidate))
  renderWorkshopCard(workshop)
  if (phaseChanged && can('view')) loadMapHistory().catch(() => {})
  renderGameOverview(state, rooms, workshop)
  const message = $<HTMLTextAreaElement>('#message')
  if (!message.value && typeof state?.message === 'string' && document.activeElement !== message)
    savedMessage = message.value = state.message
  // The candidates card's «Тест» button depends on the phase just learned above; keep it in sync (cheap local read).
  if (can('view')) loadCandidates().catch(() => {})
}

function renderGameOverview(
  state: any,
  rooms: any,
  workshop = describeWorkshop(state, session, null),
) {
  const view = describeGame(state, rooms)
  $('#lamp').dataset.tone = view.tone
  $('#lamp').textContent = view.title
  renderRoomSummary(rooms)
  $('#server-card').dataset.tone = view.tone
  $('#server-headline').textContent = view.title
  $('#server-detail').textContent = [view.detail, `проверено ${ago(rooms.checkedAt || Date.now())}`]
    .filter(Boolean)
    .join(' · ')
  renderModes(workshop, rooms)
  renderRooms(rooms)
}

function renderRoomSummary(rooms: any) {
  for (const [selector, value] of [
    ['#s-online', rooms.online],
    ['#s-matches', rooms.available ? rooms.rooms.length : undefined],
    ['#n-online', rooms.online],
    ['#n-matches', rooms.available ? rooms.rooms.length : undefined],
  ] as const) {
    const node = document.querySelector(selector)
    if (node) node.textContent = typeof value === 'number' ? String(value) : '—'
  }
  $('#side-now').replaceChildren(
    el('p', { className: 'label', textContent: 'Сейчас на сервере' }),
    ...(rooms.available
      ? rooms.rooms.map((room: any) =>
          el(
            'div',
            { className: 'match' },
            el('span', {}, room.map || room.name, el('small', { textContent: ` ${room.mode}` })),
            room.battle
              ? el(
                  'span',
                  { className: 'score' },
                  el('b', { textContent: String(room.battle.red) }),
                  ' : ',
                  el('i', { textContent: String(room.battle.blue) }),
                )
              : el('span', {
                  className: 'muted',
                  textContent: PHASES[room.phase] ?? 'ожидание',
                }),
          ),
        )
      : [el('p', { className: 'muted', textContent: 'недоступно' })]),
    ...(rooms.available && !rooms.rooms.length
      ? [el('p', { className: 'muted', textContent: 'Матчей нет' })]
      : []),
  )
}

function renderProgress(view: ReturnType<typeof switchView>) {
  const line = $('#mode-progress')
  if (view.busy) say(line, [view.step, timing(view)].filter(Boolean).join(' · '), 'pending')
  else if (view.errorMessage) say(line, `Причина: ${view.errorMessage}.`, 'error')
  else if (view.notice) say(line, view.notice, 'error')
  else say(line, '')
}

function renderModes(workshop: { title: string; detail: string; tone: string }, rooms: any) {
  const box = $('#mode-options')
  const view = switchView(controller)
  renderProgress(view)
  // site#82: the badge mirrors the overview verdict above — live rooms confirm, too.
  const ready = describeGame(controller, rooms).tone === 'ok'
  const editor = el(
    'div',
    { className: 'option' },
    el(
      'div',
      { className: 'option-head' },
      workshop.title,
      el('span', {
        className: `badge ${workshop.tone}`,
        textContent: view.busy
          ? 'Применяется…'
          : controller?.phase === 'test'
            ? 'Закрытый тест'
            : workshop.tone === 'ok'
              ? 'Доступна'
              : 'Вход закрыт',
      }),
    ),
    el('p', { textContent: workshop.detail }),
  )
  editor.append(...workshopActions(view))
  box.replaceChildren(
    el(
      'div',
      { className: 'option', ...(ready ? { dataCurrent: '' } : {}) },
      el(
        'div',
        { className: 'option-head' },
        'Игра',
        el('span', {
          className: `badge ${ready ? 'ok' : 'warn'}`,
          textContent: ready ? 'Вход открыт' : 'Готовность не подтверждена',
        }),
      ),
      el('p', { textContent: 'Игроки продолжают матчи, пока команда работает в мастерской.' }),
    ),
    editor,
  )
}

function workshopActions(view: ReturnType<typeof switchView>): HTMLElement[] {
  const actionable =
    controller?.schema === 1 &&
    Number.isSafeInteger(controller.revision) &&
    controller.revision >= 0
  if (!actionable || !(can('mode') || controller?.phase === 'sleeping')) return []
  if (view.busy && view.canCancel && can('mode'))
    return [button('Отменить смену режима', cancelSwitch, 'small danger')]
  if (controller.phase === 'ERROR' && can('recover'))
    return [button('Восстановить мастерскую', recoverWorkshop, 'small primary')]
  if (controller.phase === 'test' && can('mode'))
    return [button('Вернуться в мастерскую', resumeWorkshop, 'small')]
  if (controller.phase === 'sleeping' && can('view'))
    return [button('Запустить мастерскую', wakeWorkshop, 'small primary')]
  if (!view.busy && controller.phase !== 'ERROR' && can('mode'))
    return [button('Сменить сеанс или карты', startWorkshop, 'small')]
  return []
}

function renderWorkshopCard(workshop: { title: string; detail: string; tone: string }) {
  $('#ws-card').dataset.tone = workshop.tone
  $('#ws-headline').textContent = workshop.title
  $('#ws-detail').textContent = workshop.detail
  $('#ws-actions').replaceChildren(...workshopActions(switchView(controller)))
}

const modeFeedback = () =>
  $('#workshop').hidden
    ? [$('#mode-status'), $('#mode-options')]
    : [$('#ws-status'), $('#ws-actions')]

async function wakeWorkshop() {
  const [line, scope] = modeFeedback()
  moderate(line, {}, 'Принято: мастерская запускается', loadOverview, scope, 'wake')
}

async function cancelSwitch() {
  if (
    !(await ask({
      title: 'Отменить смену режима мастерской?',
      text: 'Мастерская вернётся в прежний режим. Отмена доступна на текущем этапе; после сохранения мира может потребоваться восстановление.',
      ok: 'Отменить смену режима',
      danger: true,
    }))
  )
    return
  const [line, scope] = modeFeedback()
  moderate(line, {}, 'Отмена принята', loadOverview, scope, 'cancel')
}

async function recoverWorkshop() {
  if (
    !(await ask({
      title: 'Восстановить мастерскую?',
      text: 'Мастерская перезапустится в редакторе с прежним сеансом. Используйте это после ошибки запуска.',
      ok: 'Восстановить мастерскую',
      danger: true,
    }))
  )
    return
  const [line, scope] = modeFeedback()
  run(
    line,
    async () => {
      const { id } = await api('mode', 'POST', {
        profile: 'game',
        expectedRevision: controller.revision,
        recover: true,
      })
      follow(line, id, 'применено')
      return 'применяем…'
    },
    scope,
  )
}

async function startWorkshop() {
  const known = mapScopes()
  const checks = el(
    'div',
    { className: 'checks' },
    ...known.map((id) =>
      el(
        'label',
        { className: 'check' },
        el('input', { type: 'checkbox', name: 'map', value: id, checked: true }),
        mapName(id),
      ),
    ),
  )
  const all = el('input', { type: 'checkbox', checked: true }) as HTMLInputElement
  all.addEventListener('change', () =>
    checks
      .querySelectorAll('input')
      .forEach((i) => ((i as HTMLInputElement).checked = all.checked)),
  )
  const mapsBlock = el(
    'fieldset',
    { className: 'plain' },
    el('legend', { textContent: 'Какие карты править' }),
    el('label', { className: 'check' }, all, 'Все карты'),
    checks,
  )
  const fields: Node[] = []
  if (session) {
    const label = session.maps
      ? session.maps.map((id: string) => mapName(id)).join(', ')
      : 'все карты'
    const resume = el('input', {
      type: 'radio',
      name: 'session',
      value: 'resume',
      checked: true,
    }) as HTMLInputElement
    const fresh = el('input', {
      type: 'radio',
      name: 'session',
      value: 'new',
    }) as HTMLInputElement
    // Resuming keeps the session's own map list, so the map choice only exists for a new one.
    const toggle = () => (mapsBlock.disabled = mapsBlock.hidden = !fresh.checked)
    resume.addEventListener('change', toggle)
    fresh.addEventListener('change', toggle)
    toggle()
    fields.push(
      el(
        'fieldset',
        { className: 'plain' },
        el('legend', { textContent: 'Сеанс' }),
        el(
          'label',
          { className: 'radio' },
          resume,
          el(
            'span',
            {},
            `Продолжить текущий сеанс`,
            el('small', { textContent: `${date(session.startedAt)} · ${label}` }),
          ),
        ),
        el(
          'label',
          { className: 'radio' },
          fresh,
          el(
            'span',
            {},
            'Новый сеанс',
            el('small', {
              textContent: 'Свежие ветки от версий, которые сейчас в игре.',
            }),
          ),
        ),
      ),
    )
  }
  fields.push(mapsBlock)
  const answer = await ask({
    title: 'Сменить сеанс мастерской?',
    text: 'Мастерская сохранит текущие правки и перезапустится, игра продолжит работать. Прежний черновик останется в «Сохранённых черновиках».',
    ok: 'Сменить сеанс',
    danger: true,
    fields,
  })
  if (!answer) return
  const resuming = !!session && answer.get('session') !== 'new'
  const ids = answer.getAll('map').map(String)
  const body: Record<string, unknown> = {
    profile: 'workshop',
    expectedRevision: controller.revision,
    session: resuming ? 'resume' : 'new',
    ...(resuming ? {} : { maps: ids.length === known.length ? null : ids }),
  }
  const [line, scope] = modeFeedback()
  run(
    line,
    async () => {
      const { id } = await api('mode', 'POST', body)
      follow(line, id, 'применено')
      return 'применяем…'
    },
    scope,
  )
}

async function resumeWorkshop() {
  if (
    !(await ask({
      title: 'Вернуться в мастерскую?',
      text: 'Тестовый матч остановится, мастерская вернётся в редактор с тем же сеансом и рабочими копиями.',
      ok: 'Вернуться в мастерскую',
    }))
  )
    return
  const [line, scope] = modeFeedback()
  run(
    line,
    async () => {
      const { id } = await api('mode', 'POST', {
        profile: 'workshop',
        expectedRevision: controller.revision,
        session: 'resume',
      })
      follow(line, id, 'применено')
      return 'применяем…'
    },
    scope,
  )
}

function renderRooms(rooms: any) {
  const list = $('#room-list')
  if (!rooms.available) {
    list.replaceChildren(
      el('p', {
        className: 'empty',
        textContent: rooms.maintenance
          ? 'Вход на сервер закрыт — матчей сейчас нет.'
          : 'Игровой сервер не отвечает, список матчей недоступен.',
      }),
    )
    return
  }
  if (!rooms.rooms.length) {
    list.replaceChildren(
      el('p', { className: 'empty', textContent: 'Сейчас не идёт ни одного матча.' }),
    )
    return
  }
  list.replaceChildren(
    ...rooms.rooms.map((room: any) => {
      const facts: [string, string][] = [
        ['Карта', room.map || 'выбирается'],
        ['Режим', room.mode],
        ['Сейчас', PHASES[room.phase] ?? 'Идёт'],
        ['Игроков', String(room.players)],
      ]
      if (room.battle)
        facts.push(['Тикеты', `красные ${room.battle.red} · синие ${room.battle.blue}`])
      const card = el(
        'article',
        { className: 'card room', ariaLabel: room.name },
        el(
          'div',
          { className: 'card-head' },
          el('h3', { textContent: room.name }),
          el('span', {
            className: `badge ${room.joinable ? 'ok' : ''}`,
            textContent: room.joinable ? 'Можно зайти' : 'Набор закрыт',
          }),
        ),
        el(
          'dl',
          { className: 'facts' },
          ...facts.flatMap(([k, v]) => [
            el('dt', { textContent: k }),
            el('dd', { textContent: v }),
          ]),
        ),
      )
      if (can('moderate'))
        card.append(
          button('Завершить матч', () => stopRoom(room), 'danger', `Завершить матч «${room.name}»`),
        )
      return card
    }),
  )
}

async function stopRoom(room: any) {
  const radios = el(
    'fieldset',
    { className: 'plain' },
    el('legend', { textContent: 'Чем закончить матч' }),
    el(
      'div',
      { className: 'radios' },
      ...OUTCOMES.map(([value, label, about], i) =>
        el(
          'label',
          { className: 'radio' },
          el('input', {
            type: 'radio',
            name: 'outcome',
            value,
            required: true,
            checked: i === 0,
          }),
          el('span', {}, label, about ? el('small', { textContent: about }) : null),
        ),
      ),
    ),
  )
  const answer = await ask({
    title: `Завершить матч «${room.name}»?`,
    text: 'Все игроки вернутся в лобби. Итог попадёт в статистику.',
    ok: 'Завершить матч',
    danger: true,
    fields: [radios, reasonField('Причина (увидят игроки)')],
  })
  if (!answer) return
  const outcome = String(answer.get('outcome')),
    reason = String(answer.get('reason') ?? '')
  moderate(
    $('#room-status'),
    {
      action: 'stop-room',
      roomId: room.id,
      outcome,
      reason: outcome === 'none' && /^(win|draw)\b/i.test(reason) ? `— ${reason}` : reason,
    },
    `Матч «${room.name}» завершён.`,
    loadOverview,
  )
}

function getLastWorkshop() {
  return lastWorkshop
}

export {
  getLastWorkshop,
  getSavedMessage,
  setSavedMessage,
  loadOverview,
  renderOverview,
  renderGameOverview,
  OUTCOMES,
}
