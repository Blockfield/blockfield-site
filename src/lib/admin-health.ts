// Admin performance tab (health samples, event hours, export).
// Extracted verbatim from src/pages/admin.astro (SITE95-U3).
import { customSelect } from '../lib/custom-select'
import { $, api, date, el, number, run } from '../lib/admin-shell'

type Sample = {
  at: number
  tps: number
  msptAvg: number
  msptMax: number
  heapUsedMb: number | null
  heapMaxMb: number | null
  startedAt: number | null
}

type ServerEvent = {
  serverId: string
  id: string
  at: number
  kind: string
  durationMs: number | null
  source: string | null
  message: string
  repeats: number
}

const EVENT_KINDS: Record<string, string> = {
  freeze: 'Фриз',
  error: 'Ошибка',
  crash: 'Падение',
  warning: 'Предупреждение',
}

const LAG_TPS = 18

const hourFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
})

const ms = (n: number) => `${number(Math.round(n))} мс`

const tps = (n: number) => n.toLocaleString('ru-RU', { maximumFractionDigits: 1 })

let health: { samples: Sample[]; events: ServerEvent[]; lastSampleAt: number | null } = {
  samples: [],
  events: [],
  lastSampleAt: null,
}

function memory(s: Sample) {
  return s.heapUsedMb === null
    ? ''
    : `, память ${number(s.heapUsedMb)}${s.heapMaxMb ? ` из ${number(s.heapMaxMb)}` : ''} МБ`
}

function renderHealthCard() {
  const card = $('#health-card'),
    last = health.samples.at(-1),
    hourAgo = Date.now() - 3_600_000
  const set = (tone: string, headline: string, detail: string) => {
    card.dataset.tone = tone
    $('#health-headline').textContent = headline
    $('#health-detail').textContent = detail
  }
  // No data is not a healthy server: say so instead of showing green.
  if (health.lastSampleAt === null)
    return set(
      'warn',
      'Сервер не присылал замеров',
      'Пока замеров нет, судить о сервере нельзя. Тики прямо сейчас можно проверить ниже.',
    )
  if (!last || health.lastSampleAt < Date.now() - 3 * 60_000)
    return set(
      'bad',
      `Замеры не приходят с ${date(health.lastSampleAt)}`,
      'Сервер мог зависнуть, упасть или потерять связь с сайтом. Проверьте тики ниже и логи сервера.',
    )
  const recent = health.samples.filter((s) => s.at >= hourAgo),
    freezes = health.events
      .filter((e) => e.kind === 'freeze' && e.at >= hourAgo)
      .reduce((n, e) => n + e.repeats, 0),
    errors = health.events
      .filter((e) => e.kind !== 'freeze' && e.kind !== 'warning' && e.at >= hourAgo)
      .reduce((n, e) => n + e.repeats, 0),
    worst = Math.min(...recent.map((s) => s.tps))
  const now = `Сейчас TPS ${tps(last.tps)}, тик в среднем ${ms(last.msptAvg)}${memory(last)}.`
  if (worst < LAG_TPS || freezes || errors)
    return set(
      'warn',
      'За последний час были проблемы',
      `${now} За час: TPS падал до ${tps(worst)}, фризов ${freezes}, ошибок ${errors}.`,
    )
  set('ok', 'Сервер работает ровно', now)
}

function renderHours() {
  const hours = new Map<number, Sample[]>()
  for (const s of health.samples) {
    const hour = Math.floor(s.at / 3_600_000) * 3_600_000
    hours.set(hour, [...(hours.get(hour) ?? []), s])
  }
  $('#hour-list').replaceChildren(
    ...(hours.size
      ? [...hours].reverse().map(([hour, list]) => {
          const inHour = (e: ServerEvent) => e.at >= hour && e.at < hour + 3_600_000,
            freezes = health.events
              .filter((e) => e.kind === 'freeze' && inHour(e))
              .reduce((n, e) => n + e.repeats, 0),
            errors = health.events
              .filter((e) => (e.kind === 'error' || e.kind === 'crash') && inHour(e))
              .reduce((n, e) => n + e.repeats, 0),
            worst = Math.min(...list.map((s) => s.tps)),
            heap = Math.max(...list.map((s) => s.heapUsedMb ?? 0)),
            restart = list.find(
              (s) => s.startedAt !== null && s.startedAt >= hour && s.startedAt < hour + 3_600_000,
            )
          return el(
            'li',
            {},
            el(
              'span',
              {},
              el('span', {
                className: worst < LAG_TPS ? 'bad' : '',
                textContent: `TPS от ${tps(worst)}`,
              }),
              `, худший тик ${ms(Math.max(...list.map((s) => s.msptMax)))}`,
              heap ? `, память до ${number(heap)} МБ` : '',
              freezes ? `, фризов ${freezes}` : '',
              errors ? `, ошибок ${errors}` : '',
              restart ? `, перезапуск ${date(restart.startedAt!)}` : '',
            ),
            el('time', {
              dateTime: new Date(hour).toISOString(),
              textContent: hourFormat.format(hour),
            }),
          )
        })
      : [el('li', { className: 'empty', textContent: 'Замеров за сутки нет.' })]),
  )
}

function shownEvents() {
  const kind = $<HTMLSelectElement>('#event-kind').value,
    query = $<HTMLInputElement>('#event-search').value.trim().toLowerCase()
  return health.events.filter(
    (e) =>
      (!kind || e.kind === kind || (kind === 'error' && e.kind === 'crash')) &&
      (!query || `${e.source ?? ''} ${e.message}`.toLowerCase().includes(query)),
  )
}

const eventTitle = (e: ServerEvent) =>
  [
    EVENT_KINDS[e.kind] ?? e.kind,
    e.durationMs !== null ? ms(e.durationMs) : '',
    e.source ?? '',
    e.repeats > 1 ? `×${number(e.repeats)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

function renderEvents() {
  const list = shownEvents()
  $('#event-list').replaceChildren(
    ...(list.length
      ? list.map((e) =>
          el(
            'li',
            { className: e.kind === 'warning' ? '' : 'failed' },
            el('strong', { textContent: eventTitle(e) }),
            el('time', {
              dateTime: new Date(e.at).toISOString(),
              title: date(e.at),
              textContent: hourFormat.format(e.at),
            }),
            el('pre', { className: 'server-text', textContent: e.message }),
          ),
        )
      : [
          el('li', {
            className: 'empty',
            textContent: health.events.length
              ? 'Под фильтр ничего не подходит.'
              : 'За две недели фризов и ошибок нет.',
          }),
        ]),
  )
}

async function loadHealth() {
  health = await api('diagnostics')
  renderHealthCard()
  renderHours()
  renderEvents()
}

$('#event-kind').addEventListener('change', renderEvents)

$('#event-search').addEventListener('input', renderEvents)

customSelect($<HTMLSelectElement>('#event-kind'))

$('#event-copy').addEventListener('click', () =>
  run($('#event-status'), async () => {
    const list = shownEvents()
    if (!list.length) return 'Копировать нечего.'
    await navigator.clipboard.writeText(
      list
        .map((e) => `${new Date(e.at).toISOString()} ${eventTitle(e)}\n${e.message}`)
        .join('\n\n'),
    )
    return `Скопировано записей: ${list.length}.`
  }),
)

$('#event-export').addEventListener('click', () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'),
    link = el('a', {
      href: URL.createObjectURL(
        new Blob(
          [
            JSON.stringify(
              {
                exportedAt: new Date().toISOString(),
                samples: health.samples,
                events: shownEvents(),
              },
              null,
              2,
            ),
          ],
          { type: 'application/json' },
        ),
      ),
      download: `blockfield-diagnostics-${stamp}.json`,
    })
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 0)
})

export { loadHealth, renderHealthCard, renderHours, renderEvents, shownEvents, ms, tps }
