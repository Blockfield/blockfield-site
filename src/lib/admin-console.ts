// Admin console tab (game console via CP, live tick check, log tail).
// Extracted verbatim from src/pages/admin.astro (SITE95-U3).
import { customSelect } from '../lib/custom-select'
import { dangerousCommand } from '../lib/console'
import { api, ask, date, el, run, $ } from '../lib/admin-shell'
import { ms, tps } from '../lib/admin-health'

const TICK_STATES: Record<string, string> = {
  running: 'Сервер успевает',
  lagging: 'Сервер не успевает за тиками',
  frozen: 'Тики заморожены командой tick freeze',
  sprinting: 'Идёт ускоренная прокрутка тиков',
}

$('#live-check').addEventListener('click', () =>
  run(
    $('#live-status'),
    async () => {
      const t = await api('diagnostics/live')
      const values: [string, string][] = [
        ['TPS', `${tps(t.tps)} из ${tps(t.targetTps)}`],
        ['Тик в среднем', ms(t.msptAvg)],
        ...(t.msptP95 !== null
          ? ([['95% тиков быстрее', ms(t.msptP95)]] as [string, string][])
          : []),
        ...(t.msptP99 !== null
          ? ([['99% тиков быстрее', ms(t.msptP99)]] as [string, string][])
          : []),
      ]
      const dl = $('#live-values')
      dl.replaceChildren(
        ...values.map(([k, v]) =>
          el('div', {}, el('dt', { textContent: v }), el('dd', { textContent: k })),
        ),
      )
      dl.hidden = false
      const verdict = `${TICK_STATES[t.state] ?? t.state} — ${date(t.at)}.`
      // A lagging or frozen server is the bad news this check exists for: show it in the error tone.
      if (t.state === 'lagging' || t.state === 'frozen') throw new Error(verdict)
      return verdict
    },
    $('#live-check').parentElement,
  ),
)

const TARGET_LABELS: Record<string, string> = {
  game: 'Основной сервер',
  workshop: 'Мастерская',
}

const consoleHistory: string[] = []

let historyAt = 0

const consoleTarget = $<HTMLSelectElement>('#console-target')

customSelect(consoleTarget)

const consoleInput = $<HTMLInputElement>('#console-input')

const consoleSuggest = $<HTMLUListElement>('#console-suggest')

const consoleUsage = $('#console-usage')

let suggestFrom = 0,
  suggestItems: { text: string; hint: string }[] = [],
  suggestActive = -1,
  suggestTimer = 0

function closeSuggest() {
  suggestItems = []
  suggestActive = -1
  consoleSuggest.hidden = true
  consoleSuggest.replaceChildren()
  consoleInput.setAttribute('aria-expanded', 'false')
}

function renderSuggest() {
  consoleSuggest.replaceChildren(
    ...suggestItems.map((item, i) =>
      el(
        'li',
        {
          role: 'option',
          className: i === suggestActive ? 'active' : '',
          ariaSelected: i === suggestActive ? 'true' : 'false',
        },
        el('span', { textContent: item.text }),
        item.hint ? el('small', { textContent: item.hint }) : null,
      ),
    ),
  )
  consoleSuggest.hidden = false
  consoleInput.setAttribute('aria-expanded', 'true')
  const first = suggestItems[0]
  if (first && suggestActive === -1) {
    consoleUsage.textContent = `⇥ ${consoleInput.value.slice(0, suggestFrom)}${first.text}${first.hint ? ` — ${first.hint}` : ''}`
    consoleUsage.hidden = false
  }
}

function applySuggest(i: number) {
  const item = suggestItems[i]
  if (!item) return
  consoleInput.value = consoleInput.value.slice(0, suggestFrom) + item.text
  closeSuggest()
  consoleUsage.hidden = true
  scheduleSuggest()
  consoleInput.focus()
}

async function fetchSuggest() {
  const value = consoleInput.value
  if (!value.trim()) {
    closeSuggest()
    consoleUsage.hidden = true
    return
  }
  try {
    const page = await api(
      `console/suggest?target=${consoleTarget.value}&input=${encodeURIComponent(value)}`,
    )
    suggestFrom = page.from
    suggestItems = page.suggestions
    suggestActive = -1
    if (!suggestItems.length) {
      closeSuggest()
      consoleUsage.hidden = true
      return
    }
    renderSuggest()
  } catch {
    closeSuggest()
  }
}

function scheduleSuggest() {
  window.clearTimeout(suggestTimer)
  suggestTimer = window.setTimeout(fetchSuggest, 150)
}

consoleInput.addEventListener('input', scheduleSuggest)

consoleSuggest.addEventListener('mousedown', (e) => {
  const li = (e.target as HTMLElement).closest('li')
  if (!li) return
  e.preventDefault()
  applySuggest([...consoleSuggest.children].indexOf(li))
})

document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('.console-complete')) closeSuggest()
})

consoleInput.addEventListener('keydown', (e) => {
  if (!consoleSuggest.hidden) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      suggestActive =
        (suggestActive + (e.key === 'ArrowDown' ? 1 : -1) + suggestItems.length) %
        suggestItems.length
      renderSuggest()
      consoleSuggest.children[suggestActive]?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSuggest()
      return
    }
    if ((e.key === 'Tab' || e.key === 'Enter') && suggestActive >= 0) {
      e.preventDefault()
      applySuggest(suggestActive)
      return
    }
  }
  if ((e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !consoleHistory.length) return
  e.preventDefault()
  closeSuggest()
  historyAt = Math.max(
    0,
    Math.min(consoleHistory.length, historyAt + (e.key === 'ArrowUp' ? -1 : 1)),
  )
  consoleInput.value = consoleHistory[historyAt] ?? ''
})

const consoleLog = $('#console-log')

const consoleLevel = $<HTMLSelectElement>('#console-level')

customSelect(consoleLevel)

const consoleSearch = $<HTMLInputElement>('#console-search')

const consoleFollow = $<HTMLInputElement>('#console-follow')

const consolePause = $<HTMLButtonElement>('#console-pause')

const consoleDetail = $('#console-log-detail')

let logSince = 0,
  logPaused = false,
  logLastError = ''

function logMatches(line: HTMLElement) {
  const level = line.dataset.level ?? '',
    levelFilter = consoleLevel.value,
    // INFO stands for the quiet levels too: the server sends DEBUG/TRACE as-is.
    levelOk =
      !levelFilter ||
      level === levelFilter ||
      (levelFilter === 'INFO' &&
        (level === '' || level === 'INFO' || level === 'DEBUG' || level === 'TRACE'))
  if (!levelOk) return false
  const query = consoleSearch.value.trim().toLowerCase()
  return !query || (line.dataset.text ?? '').includes(query)
}

function logRefilter() {
  for (const line of consoleLog.children) {
    if (logMatches(line as HTMLElement)) line.removeAttribute('hidden')
    else line.setAttribute('hidden', '')
  }
}

function appendLogLine(kind: string, head: string, text: string, full: string) {
  const line = el(
    'span',
    {
      className: `line${kind ? ` ${kind}` : ''}`,
      dataText: `${head} ${text}`.toLowerCase(),
    },
    el('span', { className: 't', textContent: head }),
    el('span', { textContent: text ? ` ${text}` : '' }),
  )
  if (kind === 'warn' || kind === 'error')
    (line.firstElementChild!.nextElementSibling as HTMLElement).className = kind
  line.addEventListener('click', () => {
    consoleDetail.textContent = full
    consoleDetail.hidden = false
    if (kind === 'cmd') consoleInput.value = full.split('\n')[0].replace(/^> /, '')
  })
  consoleLog.append(line)
  while (consoleLog.childElementCount > 500) consoleLog.firstElementChild!.remove()
  logRefilter()
  if (consoleFollow.checked) consoleLog.scrollTop = consoleLog.scrollHeight
}

function logServerEntry(entry: { at: number; level: string; logger: string; message: string }) {
  const time = new Date(entry.at).toLocaleTimeString('ru-RU', { hour12: false }),
    level = (entry.level || '').toUpperCase(),
    kind = level === 'ERROR' || level === 'FATAL' ? 'error' : level === 'WARN' ? 'warn' : '',
    head = `[${time}${level ? ` ${level}` : ''}]`
  appendLogLine(kind, head, entry.message || '', `${head} ${entry.message || ''}`)
}

function logCommand(target: string, command: string, output: string, bad: boolean) {
  const label = TARGET_LABELS[target] ?? target
  appendLogLine(
    bad ? 'cmd-bad' : 'cmd',
    `[${label}]`,
    `> ${command}`,
    `> ${command}\n${output || '(пустой ответ)'}`,
  )
}

async function pollLog() {
  if (logPaused || $('#console').hidden || document.hidden) return
  try {
    const page = await api(`console/logs?target=${consoleTarget.value}&since=${logSince}`)
    logLastError = ''
    for (const entry of page.entries) logServerEntry(entry)
    logSince = page.next
  } catch (error) {
    const message = (error as Error).message
    if (message !== logLastError) {
      logLastError = message
      appendLogLine('error', '[журнал]', message, `[журнал] ${message}`)
    }
  }
}

window.setInterval(pollLog, 2000)

consoleTarget.addEventListener('change', () => {
  consoleLog.replaceChildren()
  consoleDetail.hidden = true
  logSince = 0
  logLastError = ''
  closeSuggest()
  consoleUsage.hidden = true
  pollLog()
})

consoleLevel.addEventListener('change', logRefilter)

consoleSearch.addEventListener('input', logRefilter)

consolePause.addEventListener('click', () => {
  logPaused = !logPaused
  consolePause.textContent = logPaused ? 'Продолжить' : 'Пауза'
  if (!logPaused) pollLog()
})

function consoleLine(target: string, command: string, text: string, bad: boolean) {
  const out = $('#console-output')
  const targetLabel = TARGET_LABELS[target] ?? target
  out.append(
    el('span', { className: 'cmd', textContent: `[${targetLabel}] > ${command}\n` }),
    el('span', { className: bad ? 'bad' : '', textContent: `${text || '(пустой ответ)'}\n` }),
  )
  // Keep the last 100 exchanges; the full record is the journal.
  while (out.childElementCount > 200) out.firstElementChild!.remove()
  out.scrollTop = out.scrollHeight
}

$<HTMLFormElement>('#console-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.currentTarget as HTMLFormElement,
    target = consoleTarget.value,
    command = consoleInput.value.trim().replace(/^\/+/, '').trim()
  if (!command) return
  if (consoleHistory.at(-1) !== command) consoleHistory.push(command)
  historyAt = consoleHistory.length
  if (
    dangerousCommand(command) &&
    !(await ask({
      title: 'Выполнить опасную команду?',
      text: `«${command}» на ${TARGET_LABELS[target] ?? target} может остановить сервер, изменить доступ или необратимо изменить мир и игроков.`,
      ok: 'Выполнить',
      danger: true,
    }))
  )
    return
  run(
    form.querySelector<HTMLElement>('.form-status')!,
    async () => {
      const reply = await api('rcon/raw', 'POST', { command, target }).catch((error: Error) => {
        consoleLine(target, command, error.message, true)
        logCommand(target, command, error.message, true)
        throw error
      })
      consoleLine(reply.target ?? target, command, reply.output, reply.rejected)
      logCommand(reply.target ?? target, command, reply.output, reply.rejected)
      consoleInput.value = ''
      if (reply.rejected) throw new Error('Команда не выполнена. Проверьте её и повторите.')
    },
    form,
  )
})
