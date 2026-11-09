// Admin players tab (online list, bans, player actions).
// Extracted verbatim from src/pages/admin.astro (SITE95-U3).
import { $, ago, api, ask, button, can, el, moderate, reasonField, say } from '../lib/admin-shell'

const PLAYER_ACTIONS: Record<
  string,
  {
    ok: string
    title: (p: string) => string
    text: (p: string) => string
    done: (p: string) => string
    reason: boolean
  }
> = {
  kick: {
    ok: 'Выгнать',
    title: (p) => `Выгнать ${p}?`,
    text: (p) => `${p} будет отключён от сервера, но сможет сразу зайти снова.`,
    done: (p) => `${p} выгнан с сервера.`,
    reason: true,
  },
  'team-kick': {
    ok: 'Убрать из матча',
    title: (p) => `Убрать ${p} из матча?`,
    text: (p) => `${p} покинет команду в текущем матче. С сервера его не выгонит.`,
    done: (p) => `${p} убран из матча.`,
    reason: false,
  },
  ban: {
    ok: 'Забанить',
    title: (p) => `Забанить ${p}?`,
    text: (p) => `${p} будет отключён и не сможет зайти на сервер, пока его не разбанят.`,
    done: (p) => `${p} забанен.`,
    reason: true,
  },
  pardon: {
    ok: 'Разбанить',
    title: (p) => `Разбанить ${p}?`,
    text: (p) => `${p} снова сможет заходить на сервер.`,
    done: (p) => `${p} разбанен.`,
    reason: false,
  },
}

async function playerAction(action: string, player: string, line: HTMLElement) {
  const spec = PLAYER_ACTIONS[action]
  const answer = await ask({
    title: spec.title(player),
    text: spec.text(player),
    ok: spec.ok,
    danger: action !== 'pardon',
    fields: spec.reason ? [reasonField()] : [],
  })
  if (!answer) return
  await moderate(
    line,
    { action, player, reason: String(answer.get('reason') ?? '') },
    spec.done(player),
    () => {
      if (action === 'ban' || action === 'pardon') loadBans()
      if (action !== 'pardon') setTimeout(loadOnline, 1000)
    },
  )
}

async function loadOnline() {
  const summary = $('#online-summary')
  try {
    const { players } = await api('rcon', 'POST', { action: 'list' })
    summary.className = 'muted'
    summary.textContent = players.length
      ? `Игроков на сервере: ${players.length}.`
      : 'На сервере никого нет.'
    $('#online-list').replaceChildren(
      ...players.map((name: string) =>
        el(
          'li',
          { className: 'row' },
          el('div', { className: 'row-main' }, el('strong', { textContent: name })),
          el(
            'div',
            { className: 'actions' },
            button(
              'Выгнать',
              () => playerAction('kick', name, summary),
              'small',
              `Выгнать ${name}`,
            ),
            button(
              'Убрать из матча',
              () => playerAction('team-kick', name, summary),
              'small',
              `Убрать ${name} из матча`,
            ),
            can('ban')
              ? button(
                  'Забанить',
                  () => playerAction('ban', name, summary),
                  'small danger',
                  `Забанить ${name}`,
                )
              : null,
          ),
        ),
      ),
    )
  } catch (error) {
    say(summary, (error as Error).message, 'error')
    $('#online-list').replaceChildren()
  }
}

async function loadBans() {
  const { bans } = await api('bans')
  $('#ban-list').replaceChildren(
    ...(bans.length
      ? bans.map((b: any) =>
          el(
            'li',
            { className: 'row' },
            el(
              'div',
              { className: 'row-main' },
              el('strong', { textContent: b.player }),
              el('small', {
                textContent: `Забанил ${b.by} ${ago(b.at)}${b.reason ? ` · причина: «${b.reason}»` : ''}`,
              }),
            ),
            button(
              'Разбанить',
              () => playerAction('pardon', b.player, $('#ban-status')),
              'small',
              `Разбанить ${b.player}`,
            ),
          ),
        )
      : [el('li', { className: 'empty', textContent: 'Никто не забанен.' })]),
  )
}

export { PLAYER_ACTIONS, playerAction, loadOnline, loadBans }
