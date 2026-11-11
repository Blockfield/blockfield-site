// Admin statistics tab (results, seasons, keys).
// Extracted verbatim from src/pages/admin.astro (SITE95-U3).
import { MAP_NAMES, MODE_NAMES, TEAM_NAMES } from '../lib/game-names'
import { customSelect } from '../lib/custom-select'
import { $, ago, api, ask, button, date, el, run } from '../lib/admin-shell'

const REASONS: Record<string, string> = {
  draw: 'Ничья',
  abandoned: 'Прерван: все игроки вышли',
  stopped: 'Остановлен вручную',
  shutdown: 'Прерван: сервер выключился',
  error: 'Прерван из-за ошибки',
}

const matchTitle = (r: { kind: string; mode: string; mapId: string | null }) =>
  `${MODE_NAMES[r.mode] ?? 'Матч'} · ${r.kind === 'campaign' ? 'итог кампании' : (MAP_NAMES[r.mapId ?? ''] ?? 'другая карта')}`

function outcome(r: any) {
  if (r.reason !== 'completed') return REASONS[r.reason] ?? 'Завершён'
  if (r.winnerName) return `Победил ${r.winnerName}`
  return TEAM_NAMES[r.winner] ? `Победа ${TEAM_NAMES[r.winner]}` : 'Завершён'
}

let resultPage = 1

async function loadResults() {
  const mode = $<HTMLSelectElement>('#result-mode').value,
    data = await api(`results?page=${resultPage}${mode ? `&mode=${mode}` : ''}`)
  const line = $('#result-status')
  $('#result-list').replaceChildren(
    ...(data.results.length
      ? data.results.map((r: any) => {
          const voided = r.voidedAt !== null,
            title = matchTitle(r)
          const players = el(
            'small',
            {},
            `Игроки (${r.participants}): `,
            ...r.players.flatMap((p: any, i: number) => [
              i ? ', ' : '',
              el('span', { className: `team-${p.team}`, textContent: p.name }),
            ]),
            r.participants > r.players.length ? '…' : '',
          )
          const main = el(
            'div',
            { className: 'row-main' },
            el('strong', { textContent: title }),
            el(
              'span',
              {},
              `${date(r.endedAt)} · ${outcome(r)}`,
              voided
                ? el('span', {
                    className: 'badge warn',
                    textContent: ` Не учитывается — решил ${r.voidedBy}`,
                  })
                : null,
            ),
            players,
          )
          const toggle = button(
            voided ? 'Вернуть в статистику' : 'Не учитывать матч',
            async () => {
              const answer = await ask(
                voided
                  ? {
                      title: 'Вернуть матч в статистику?',
                      text: `«${title}», ${date(r.endedAt)}. Матч снова появится в лидерборде и профилях игроков.${r.rated ? ' Рейтинг сезона пересчитается.' : ''}`,
                      ok: 'Вернуть',
                    }
                  : {
                      title: 'Не учитывать этот матч?',
                      text: `«${title}», ${date(r.endedAt)}. Матч пропадёт из лидерборда и профилей игроков.${r.rated ? ' Рейтинг сезона пересчитается.' : ''} Решение можно отменить.`,
                      ok: 'Не учитывать',
                      danger: true,
                    },
              )
              if (!answer) return
              await run(line, async () => {
                await api('results/void', 'POST', {
                  serverId: r.serverId,
                  eventId: r.eventId,
                  voided: !voided,
                })
                await loadResults()
                return voided ? 'Матч снова учитывается.' : 'Матч больше не учитывается.'
              })
            },
            voided ? 'small' : 'small danger',
            `${voided ? 'Вернуть в статистику' : 'Не учитывать'}: ${title}, ${date(r.endedAt)}`,
          )
          return el('li', { className: `row${voided ? ' voided' : ''}` }, main, toggle)
        })
      : [el('li', { className: 'empty', textContent: 'Матчей пока нет.' })]),
  )
  const from = data.total ? (resultPage - 1) * data.limit + 1 : 0,
    to = Math.min(data.total, resultPage * data.limit)
  $('#page').textContent = data.total ? `Матчи ${from}–${to} из ${data.total}` : ''
  $<HTMLButtonElement>('#prev').disabled = resultPage <= 1
  $<HTMLButtonElement>('#next').disabled = resultPage * data.limit >= data.total
}

$('#result-mode').addEventListener('change', () => {
  resultPage = 1
  loadResults()
})

customSelect($<HTMLSelectElement>('#result-mode'))

$('#prev').addEventListener('click', () => {
  resultPage--
  loadResults()
})

$('#next').addEventListener('click', () => {
  resultPage++
  loadResults()
})

const dayFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

async function loadSeasons() {
  const { seasons } = await api('seasons')
  $('#season-list').replaceChildren(
    ...seasons
      .slice()
      .reverse()
      .map((s: any) =>
        el('li', {
          textContent: `${s.name}: ${dayFormat.format(Date.parse(s.startsAt))} — ${dayFormat.format(Date.parse(s.endsAt))}`,
        }),
      ),
  )
}

async function loadKeys() {
  const { keys } = await api('keys')
  $('#key-list').replaceChildren(
    ...keys.map((k: any) =>
      el(
        'li',
        { className: 'row' },
        el(
          'div',
          { className: 'row-main' },
          el('strong', { textContent: k.label }),
          el('small', {
            textContent: k.revokedAt
              ? `Отозван ${ago(k.revokedAt)}`
              : `Действует, создан ${ago(k.createdAt)}`,
          }),
        ),
        k.revokedAt
          ? null
          : button(
              'Отозвать',
              async () => {
                if (
                  !(await ask({
                    title: `Отозвать ключ «${k.label}»?`,
                    text: 'Сервер с этим ключом перестанет отправлять результаты матчей, пока ему не выдадут новый.',
                    ok: 'Отозвать',
                    danger: true,
                  }))
                )
                  return
                await run($('#key-form .form-status'), async () => {
                  await api('keys/revoke', 'POST', { id: k.id })
                  await loadKeys()
                  return 'Ключ отозван.'
                })
              },
              'small danger',
              `Отозвать ключ «${k.label}»`,
            ),
      ),
    ),
  )
}

$<HTMLFormElement>('#key-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const form = e.currentTarget as HTMLFormElement,
    line = form.querySelector<HTMLElement>('.form-status')!
  run(
    line,
    async () => {
      const { key } = await api('keys', 'POST', {
        serverId: (form.elements.namedItem('serverId') as HTMLInputElement).value
          .trim()
          .toLowerCase(),
        label: (form.elements.namedItem('label') as HTMLInputElement).value,
      })
      form.reset()
      loadKeys()
      line.replaceChildren(
        'Ключ создан. Скопируйте его сейчас — больше он показан не будет:',
        el('div', { className: 'secret', textContent: key }),
      )
    },
    form,
  ).then(() => {
    if (!line.firstElementChild && line.textContent === 'применяем…') line.textContent = ''
  })
})

export { loadResults, loadSeasons, loadKeys, matchTitle }
