// Shared admin-shell UI infra: tiny page helpers every admin section uses.
// Extracted verbatim from src/pages/admin.astro (SITE95-U2).
type Me = { uuid: string; name: string; role: string | null; permissions: string[] }

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!

const ROLES: Record<string, { name: string; about: string }> = {
  builder: {
    name: 'Строитель',
    about: 'Строит доступные карты и отправляет их на проверку.',
  },
  moderator: {
    name: 'Модератор',
    about: 'Следит за порядком, выгоняет игроков и завершает зависшие матчи.',
  },
  admin: {
    name: 'Администратор',
    about: 'Управляет игрой, банами, статистикой и командой.',
  },
  owner: {
    name: 'Владелец',
    about: 'Полный доступ. Назначает администраторов.',
  },
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
})

const relative = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })

const date = (ms: number) => dateFormat.format(ms)

function ago(ms: number) {
  const seconds = (ms - Date.now()) / 1000
  for (const [unit, size] of [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ] as const)
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  return 'только что'
}

const number = (n: number) => n.toLocaleString('ru-RU')

function friendly(message: string | undefined, status: number) {
  const rules: [RegExp, string][] = [
    [/^Сервер не принял команду/, 'Игрок вышел или матч закончился. Обновите список и повторите.'],
    [/^(Недостаточно прав|Нет доступа)/, 'Недостаточно прав. Попросите администратора.'],
    [
      /^(Модерация через control-plane|Консоль( Мастерской)?) не настроена/,
      'Управление игровым сервером с сайта не настроено. Сообщите владельцу.',
    ],
    [/already voided/, 'Этот матч уже не учитывается. Обновите страницу.'],
    [/is not voided/, 'Этот матч уже учитывается. Обновите страницу.'],
    [/Result not found/, 'Матч не найден. Обновите страницу.'],
    [/^Нет ревизии/, 'Состояние сервера изменилось. Обновите страницу и попробуйте снова.'],
    [/Участник не найден/, 'Этого участника уже нет в команде. Обновите страницу.'],
  ]
  if (!message)
    return status >= 500
      ? 'Сайт сейчас не отвечает. Попробуйте через минуту.'
      : 'Не получилось. Обновите страницу и попробуйте ещё раз.'
  const rule = rules.find(([pattern]) => pattern.test(message))
  if (rule) return rule[1]
  return /[а-яё]/i.test(message) ? message : 'Действие не выполнено. Обновите страницу и повторите.'
}

async function api(path: string, method = 'GET', body?: unknown) {
  // Content-Type is sent even without a body: Astro's origin check rejects bodiless non-GET requests behind the proxy.
  const response = await fetch(`/api/admin/${path}`, {
    method,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => null)
  if (!response) throw new Error('Нет связи с сайтом. Проверьте интернет и попробуйте ещё раз.')
  const data = await response.json().catch(() => null)
  if (!response.ok)
    throw Object.assign(new Error(friendly(data?.error, response.status)), {
      raw: data?.error ?? '',
      status: response.status,
    })
  return data
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, any> = {},
  ...children: (Node | string | null | undefined | false)[]
) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('aria') || key.startsWith('data') || key === 'role' || key === 'for')
      node.setAttribute(
        key
          .replace(/^aria([A-Z])/, (_, c) => `aria-${c.toLowerCase()}`)
          .replace(/^data([A-Z])/, (_, c) => `data-${c.toLowerCase()}`),
        String(value),
      )
    else (node as any)[key] = value
  }
  node.append(
    ...children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false),
  )
  return node
}

const button = (text: string, onclick: () => void, className = 'small', label?: string) =>
  el('button', {
    type: 'button',
    className,
    textContent: text,
    onclick,
    ...(label ? { ariaLabel: label } : {}),
  })

function say(line: HTMLElement, text: string, tone: 'ok' | 'error' | 'pending' = 'ok') {
  line.textContent = text
  line.classList.remove('ok', 'error', 'pending')
  line.classList.add(tone)
}

async function run(
  line: HTMLElement,
  action: () => Promise<string | void>,
  scope: HTMLElement | null = null,
) {
  const buttons = scope ? [...scope.querySelectorAll('button')].filter((b) => !b.disabled) : []
  buttons.forEach((b) => (b.disabled = true))
  say(line, 'применяем…', 'pending')
  try {
    const text = await action()
    if (text) say(line, text, text === 'применяем…' ? 'pending' : 'ok')
    else {
      // Some actions render a one-time key or other structured success feedback directly.
      if (line.textContent === 'применяем…') line.textContent = ''
      line.classList.replace('pending', 'ok')
    }
  } catch (error) {
    say(line, (error as Error).message, 'error')
  } finally {
    buttons.forEach((b) => (b.disabled = false))
  }
}

async function moderate(
  line: HTMLElement,
  body: Record<string, unknown>,
  done: string,
  after: () => void = () => {},
  scope: HTMLElement | null = null,
  route = 'rcon',
) {
  body.idempotencyKey ??= crypto.randomUUID()
  await run(
    line,
    async () => {
      for (;;) {
        const data = await api(route, 'POST', body)
        if (!data?.unknownOutcome) {
          after()
          return done
        }
        const again = await ask({
          title: 'Действие не подтверждено',
          text: 'Команда могла уйти на сервер. Повтор безопасен: дважды она не применится.',
          ok: 'Повторить',
        })
        if (!again) throw new Error('Не подтверждено. Проверьте состояние; повтор безопасен.')
      }
    },
    scope,
  )
}

const dialog = $<HTMLDialogElement>('#dialog')

function ask({
  title,
  text,
  ok,
  danger = false,
  fields = [],
}: {
  title: string
  text: string
  ok: string
  danger?: boolean
  fields?: Node[]
}): Promise<FormData | null> {
  const opener = document.activeElement as HTMLElement | null
  $('#dialog-title').textContent = title
  $('#dialog-text').textContent = text
  $('#dialog-fields').replaceChildren(...fields)
  Object.assign($('#dialog-ok'), {
    textContent: ok,
    className: danger ? 'primary danger' : 'primary',
  })
  dialog.returnValue = ''
  dialog.showModal()
  return new Promise((resolve) =>
    dialog.addEventListener(
      'close',
      () => {
        const form = dialog.querySelector('form')!
        resolve(dialog.returnValue === 'ok' ? new FormData(form) : null)
        opener?.focus()
      },
      { once: true },
    ),
  )
}

let fieldId = 0

function field(label: string, input: HTMLElement, hint?: string, wrap?: HTMLElement) {
  const id = `f${++fieldId}`
  input.id = id
  if (hint) input.setAttribute('aria-describedby', `${id}-hint`)
  return el(
    'div',
    { className: 'field row' },
    el(
      'label',
      { for: id },
      label,
      hint ? el('small', { id: `${id}-hint`, textContent: hint }) : null,
    ),
    el('div', { className: 'ctl' }, wrap ?? input),
    el('span', { className: 'state', role: 'status' }),
  )
}

const reasonField = (label = 'Причина (игрок её увидит)', required = false) =>
  field(
    label,
    el('input', { name: 'reason', maxLength: 120, required, autocomplete: 'off' }),
    required ? undefined : 'Необязательно.',
  )

const followTokens = new WeakMap<HTMLElement, string>()

const pendingRequests = new Map<string, (result: any) => void>()

const requestResults = new Map<string, any>()

function requestResult(id: string, result: any) {
  const finish = pendingRequests.get(id)
  if (finish) finish(result)
  else {
    requestResults.delete(id)
    requestResults.set(id, result)
    if (requestResults.size > 50) requestResults.delete(requestResults.keys().next().value!)
  }
}

async function follow(
  line: HTMLElement,
  id: string,
  done: string,
  onError?: (error: string, code?: unknown) => Promise<boolean> | boolean,
) {
  followTokens.set(line, id)
  say(line, 'применяем…', 'pending')
  const result = await new Promise<any>((resolve) => {
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
  if (followTokens.get(line) !== id) return
  if (!result) say(line, 'Нет подтверждения. Проверьте состояние позже.', 'error')
  else if (result.ok) say(line, done)
  else if (!(await onError?.(String(result.error), result.code)))
    say(
      line,
      /revision/i.test(String(result.error))
        ? 'Состояние сервера успело измениться. Обновите страницу и попробуйте снова.'
        : 'Действие не выполнено. Повторите или сообщите владельцу.',
      'error',
    )
  return result?.ok ? result : null
}

function toast(text: string) {
  const node = el('div', { className: 'toast', textContent: text })
  $('.toasts').append(node)
  setTimeout(() => node.remove(), 5000)
}

function avatar(person: { uuid: string; name: string }) {
  const color = ([...person.uuid].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 4) + 1
  return el('span', {
    className: 'av',
    dataC: color,
    title: person.name,
    textContent: person.name.slice(0, 1),
  })
}

let me: Me
function setMe(value: Me) {
  me = value
}
const can = (permission: string) => me.permissions.includes(permission)

let controller: any = null
function setController(value: any) {
  controller = value
}

export {
  $,
  ROLES,
  me,
  setMe,
  can,
  dateFormat,
  relative,
  date,
  ago,
  number,
  friendly,
  api,
  el,
  button,
  say,
  run,
  moderate,
  dialog,
  ask,
  field,
  reasonField,
  followTokens,
  follow,
  pendingRequests,
  requestResults,
  requestResult,
  toast,
  avatar,
  controller,
  setController,
}
export type { Me }
