// Admin journal tab (audit sentence, rows, live prepend).
// Extracted verbatim from src/pages/admin.astro (SITE95-U3).
import { CLASS_NAMES, WORKSHOP_PLACES } from '../lib/game-names'
import { mapName } from '../lib/admin-workshop'
import { matchTitle } from '../lib/admin-stats'
import { OUTCOMES } from '../lib/admin-overview'
import { $, ROLES, ago, api, date, el, friendly } from '../lib/admin-shell'

function sentence(a: any): [string, string, string] {
  let d: any = {}
  try {
    d = a.detail ? JSON.parse(a.detail) : {}
  } catch {
    // Legacy journal details may be plain text rather than JSON.
  }
  const player = d.player ?? a.target,
    reason = d.reason ? `, причина: «${d.reason}»` : ''
  const match = d.room ? ` «${d.room.name}»${d.room.map ? ` на карте ${d.room.map}` : ''}` : ''
  const result = d.mode ? ` «${matchTitle(d)}» от ${date(d.endedAt)}` : ''
  const cls = ` «${CLASS_NAMES[a.target] ?? 'неизвестный'}»`
  switch (a.action) {
    case 'mode':
      return a.target === 'workshop'
        ? ['открыл', 'открыть', ' сеанс мастерской']
        : a.target === 'test'
          ? ['начал', 'начать', ' тест карты в мастерской']
          : d.recover
            ? ['восстановил', 'восстановить', ' мастерскую']
            : ['вернул', 'вернуть', ' мастерскую в редактор']
    case 'cancel':
      return ['отменил', 'отменить', ' смену режима мастерской']
    case 'message':
      return ['изменил', 'изменить', ` сообщение для игроков: «${d.message ?? ''}»`]
    case 'rcon:say':
      return ['написал', 'написать', ` всем: «${d.text ?? ''}»`]
    case 'rcon:kick':
      return ['выгнал', 'выгнать', ` игрока ${player}${reason}`]
    case 'rcon:ban':
      return ['забанил', 'забанить', ` игрока ${player}${reason}`]
    case 'rcon:pardon':
      return ['разбанил', 'разбанить', ` игрока ${player}`]
    case 'rcon:team-kick':
      return ['убрал', 'убрать', ` игрока ${player} из матча`]
    case 'rcon:class-lock':
      return ['закрыл', 'закрыть', ` класс${cls}`]
    case 'rcon:class-unlock':
      return ['открыл', 'открыть', ` класс${cls}`]
    case 'rcon:range':
      return a.target === 'open'
        ? ['открыл', 'открыть', ' полигон']
        : a.target === 'close'
          ? ['закрыл', 'закрыть', ' полигон']
          : ['сбросил', 'сбросить', ' полигон']
    case 'rcon:stop-room':
      return [
        'завершил',
        'завершить',
        ` матч${match} — ${(OUTCOMES.find((o) => o[0] === d.outcome)?.[1] ?? 'без итога').toLowerCase()}${reason}`,
      ]
    case 'rcon:maintenance-status':
      return ['проверил', 'проверить', ' состояние техработ']
    case 'rcon:drain':
      return ['запретил', 'запретить', ' начинать новые матчи']
    case 'rcon:resume':
      return ['разрешил', 'разрешить', ' начинать новые матчи']
    case 'rcon:interrupt':
      return ['прервал', 'прервать', ` все матчи${reason}`]
    case 'settings':
      return ['изменил', 'изменить', ' настройки игры']
    case 'kits':
      return ['изменил', 'изменить', ' наборы снаряжения и назначения режимов']
    case 'map-create':
      return ['создал', 'создать', ` пустую карту «${d.name ?? mapName(a.target)}»`]
    case 'map-properties':
      return [
        'изменил',
        'изменить',
        ` название черновика карты на «${d.name ?? mapName(a.target)}»`,
      ]
    case 'map-availability':
      return [
        d.enabled ? 'включил' : 'отключил',
        d.enabled ? 'включить' : 'отключить',
        ` карту «${mapName(a.target)}» для новых матчей`,
      ]
    case 'role-grant':
      return [
        'назначил',
        'назначить',
        ` ${d.name ?? 'игрока'} на роль «${ROLES[d.role]?.name ?? 'участник'}»`,
      ]
    case 'role-revoke':
      return ['убрал', 'убрать', ` ${d.name ?? 'игрока'} из команды`]
    case 'workshop-sync':
      return ['обновил', 'обновить', ' доступ в мастерскую']
    case 'workshop-maps':
      return ['изменил', 'изменить', ` карты для ${d.name ?? 'строителя'} в мастерской`]
    case 'workshop-candidate':
      return [
        'отправил',
        'отправить',
        ` на проверку карту «${WORKSHOP_PLACES[a.target] ?? 'другая карта'}»${d.from === 'game' ? ' (из игры)' : ''}`,
      ]
    case 'workshop-publish':
      return [
        'выложил',
        'выложить',
        ` в игру карту «${WORKSHOP_PLACES[a.target] ?? 'другая карта'}»`,
      ]
    case 'workshop-reject':
      return [
        'отклонил',
        'отклонить',
        ` версию карты «${WORKSHOP_PLACES[a.target] ?? 'другая карта'}»`,
      ]
    case 'workshop-rollback':
      return ['восстановил', 'восстановить', ` прежнюю версию карты «${mapName(a.target)}»`]
    case 'map-snapshot-create':
      return ['создал', 'создать', ` снимок ${d.name ?? ''} карты «${mapName(a.target)}»`]
    case 'map-snapshot-delete':
      return ['удалил', 'удалить', ` снимок ${d.name ?? ''} карты «${mapName(a.target)}»`]
    case 'map-commit':
      return ['сохранил', 'сохранить', ` версию карты «${mapName(a.target)}»`]
    case 'map-compare':
      return ['сравнил', 'сравнить', ` версии карты «${mapName(a.target)}»`]
    case 'map-sessions':
      return ['открыл', 'открыть', ' список сохранённых черновиков']
    case 'workshop-map-access':
      return d.from === 'game'
        ? [
            d.allowed ? 'разрешил' : 'запретил',
            d.allowed ? 'разрешить' : 'запретить',
            ` ${d.target ?? 'строителю'} строить: «${WORKSHOP_PLACES[a.target] ?? 'другая карта'}» (из игры)`,
          ]
        : [
            'изменил',
            'изменить',
            ` список строителей: «${WORKSHOP_PLACES[a.target] ?? 'другая карта'}»`,
          ]
    case 'result-void':
      return ['исключил', 'исключить', ` из статистики матч${result}`]
    case 'result-restore':
      return ['вернул', 'вернуть', ` в статистику матч${result}`]
    case 'ingest-key-create':
      return ['создал', 'создать', ` ключ приёма результатов «${d.label ?? ''}»`]
    case 'ingest-key-revoke':
      return ['отозвал', 'отозвать', ' ключ приёма результатов']
    case 'rcon:raw':
      return [
        'выполнил',
        'выполнить',
        a.target
          ? ` в консоли: «${a.target}»${d.rejected ? ' — сервер не принял' : ''}`
          : ' команду в консоли',
      ]
    default:
      return ['выполнил', 'выполнить', ' действие в панели']
  }
}

function auditRow(a: any) {
  const [past, attempt, rest] = sentence(a),
    error = friendly(String(a.error ?? '').replace(/\s\(.*\)$/, ''), 400)
  if (a.pending)
    return el(
      'li',
      { className: 'pending', 'data-audit-id': a.id },
      el(
        'span',
        {},
        el('strong', { textContent: a.actorName }),
        ` ${attempt}${rest} — `,
        el('span', { className: 'run', textContent: 'выполняется…' }),
      ),
      el('time', {
        dateTime: new Date(a.at).toISOString(),
        title: date(a.at),
        textContent: ago(a.at),
      }),
    )
  return el(
    'li',
    { className: a.ok ? '' : 'failed', 'data-audit-id': a.id },
    el(
      'span',
      {},
      el('strong', { textContent: a.actorName }),
      a.ok ? ` ${past}${rest}` : ` пытался ${attempt}${rest} — `,
      a.ok
        ? null
        : el('span', {
            className: 'fail',
            textContent: `не получилось: ${error.charAt(0).toLowerCase()}${error.slice(1)}`,
          }),
    ),
    el('time', {
      dateTime: new Date(a.at).toISOString(),
      title: date(a.at),
      textContent: ago(a.at),
    }),
  )
}

function prependAudit(entry: any) {
  const list = $('#audit-list')
  if (
    entry.action === 'rcon:list' ||
    [...list.children].some((row) => (row as HTMLElement).dataset.auditId === String(entry.id))
  )
    return
  list.querySelector('.empty')?.remove()
  list.prepend(auditRow(entry))
  while (list.children.length > 200) list.lastElementChild!.remove()
}

async function loadAudit() {
  const { entries } = await api('audit')
  const shown = entries.filter((a: any) => a.action !== 'rcon:list').slice(0, 200)
  $('#audit-list').replaceChildren(
    ...(shown.length
      ? shown.map(auditRow)
      : [el('li', { className: 'empty', textContent: 'Пока никто ничего не делал.' })]),
  )
}

export { sentence, auditRow, prependAudit, loadAudit }
