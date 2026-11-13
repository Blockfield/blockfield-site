// Admin statistics tab (seasons from CP; match moderation & ingest moved to CP).
import { MAP_NAMES, MODE_NAMES } from '../lib/game-names'
import { $, api, el } from '../lib/admin-shell'

const dayFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
  timeZoneName: 'short',
})

const matchTitle = (r: { kind: string; mode: string; mapId: string | null }) =>
  `${MODE_NAMES[r.mode] ?? 'Матч'} · ${r.kind === 'campaign' ? 'итог кампании' : (MAP_NAMES[r.mapId ?? ''] ?? 'другая карта')}`

async function loadSeasons() {
  try {
    const { seasons } = await api('seasons')
    $('#season-list').replaceChildren(
      ...(seasons.length
        ? seasons
            .slice()
            .reverse()
            .map((s: any) =>
              el('li', {
                textContent: `${s.name}: ${dayFormat.format(Date.parse(s.startsAt))} — ${dayFormat.format(Date.parse(s.endsAt))}`,
              }),
            )
        : [el('li', { className: 'empty', textContent: 'Сезоны сейчас недоступны.' })]),
    )
  } catch (error) {
    $('#season-list').replaceChildren(
      el('li', { className: 'empty', textContent: 'Сезоны сейчас недоступны.' }),
    )
    throw error
  }
}

export { loadSeasons, matchTitle }
