// Admin settings area: tabs "Настройки игры", "Оружие" and "Наборы" (settings and
// gun-balance forms, kits, kill-streak rewards, settings autosave, settings SSE event).
// Extracted verbatim from src/pages/admin.astro (SITE95-U2).
import {
  BALANCE_DEFAULTS,
  ARENA_MODES,
  BALANCE_GROUPS,
  BALANCE_LABELS,
  BALANCE_SCOPES,
  CLASS_COSTS,
  CLASS_NAMES,
  KIT_GUNS,
  PARCOOL_ACTIONS,
  PARCOOL_FILE_DEFAULT,
} from '../lib/game-names'
import { settingsBody, settingsReceipt } from '../lib/settings-form'
import {
  DEFAULT_STREAK_ENTRIES,
  entriesToRows,
  parseStreakEntries,
  rowsToEntries,
  streakCycle,
  streakPeriod,
} from '../lib/streak-table'
import type { StreakEntry, StreakRow } from '../lib/streak-table'
import { bodyPartSummary, renderBodyPartField } from '../lib/body-part-form'
import { weaponFields } from '../lib/gun-fields'
import { finalDamageVsMatchKit } from '../lib/gun-damage'
import { effectiveKits, renderKitForm } from '../lib/kit-form'
import { validateKitChanges } from '../lib/kit-schema'
import type { KitCatalog, KitDefinition } from '../lib/kit-schema'
import { customSelect, customCombo } from '../lib/custom-select'
import type { GunBalanceCatalog, GunDefinition, GunField, GunOverrides } from '../lib/gun-balance'
import { $, ago, number, api, el, say, run, ask, field, toast, me } from '../lib/admin-shell'
const mapAvailabilityWaiters = new Set<(data: any) => void>()

const GUN_LABELS: Record<string, string> = {
  ammo: 'Боеприпас',
  ammo_amount: 'Вместимость магазина',
  extended_mag_ammo_amount: 'Вместимость расширенного магазина',
  damage: 'Урон',
  armor_ignore: 'Бронепробитие',
  head_shot: 'Множитель урона в голову',
  body_part_multipliers: 'Урон по частям тела',
  can_crawl: 'Стрельба ползком',
  can_slide: 'Стрельба в подкате',
  bolt: 'Затвор',
  rpm: 'Выстрелов в минуту',
  bullet: 'Пуля и урон',
  draw_time: 'Доставание, секунды',
  put_away_time: 'Убирание, секунды',
  sprint_time: 'Выход из спринта, секунды',
  aim_time: 'Прицеливание, секунды',
  bolt_action_time: 'Работа затвора, секунды',
  bolt_feed_time: 'Подача патрона, секунды',
  fire_sound: 'Дальность звука выстрела',
  reload: 'Перезарядка',
  fire_mode: 'Режимы огня',
  fire_mode_adjust: 'Настройки режимов огня',
  burst_data: 'Очередь',
  crawl_recoil_multiplier: 'Множитель отдачи ползком',
  recoil: 'Отдача',
  hurt_bob_tweak_multiplier: 'Множитель качания при уроне',
  inaccuracy: 'Разброс',
  movement_speed: 'Скорость движения',
  melee: 'Ближний бой',
  heat: 'Нагрев',
  allow_attachment_types: 'Типы обвесов',
  exclusive_attachments: 'Разрешённые обвесы',
  weight: 'Вес',
  builtin_attachments: 'Встроенные обвесы',
  script: 'ID скрипта',
  script_param: 'Параметры скрипта',
  charging: 'Зарядка',
}

const GUN_VALUE_LABELS: Record<string, string> = {
  open_bolt: 'Открытый затвор',
  closed_bolt: 'Закрытый затвор',
  manual_action: 'Ручное перезаряжание',
  magazine: 'Магазинная',
  manual: 'Ручная',
  fuel: 'Топливная',
  inventory: 'Из инвентаря',
  auto: 'Автоматический',
  semi: 'Одиночный',
  burst: 'Очередь',
  hold: 'Удержание',
  delay: 'С задержкой',
  stand: 'Стоя',
  move: 'В движении',
  sneak: 'Крадучись',
  lie: 'Лёжа',
  aim: 'В прицеле',
  scope: 'Прицел',
  muzzle: 'Дуло',
  stock: 'Приклад',
  grip: 'Рукоять',
  laser: 'Лазер',
  extended_mag: 'Расширенный магазин',
}

const gunValueLabel = (value: string) => GUN_VALUE_LABELS[value] ?? value

const GUN_GROUP_TITLES: Record<string, string> = { bullet: 'Пуля' }

const gunGroupTitle = (top: string) => GUN_GROUP_TITLES[top] ?? GUN_LABELS[top] ?? top

let gunCatalog: GunBalanceCatalog | undefined,
  gunOverrides: GunOverrides = {},
  gunRevision = 0

function gunOrphanIds() {
  return !gunCatalog
    ? []
    : Object.keys(gunOverrides).filter((id) => !gunCatalog!.guns.some((gun) => gun.id === id))
}

function renderOrphans() {
  const box = $('#gun-orphans')
  const orphans = gunOrphanIds()
  box.replaceChildren()
  box.hidden = !orphans.length
  if (!orphans.length) return
  const count = orphans.length
  const plural = new Intl.PluralRules('ru').select(count)
  box.append(
    el('span', {
      textContent: `${count} ${plural === 'one' ? 'запись' : plural === 'few' ? 'записи' : 'записей'} для оружия, которого нет в каталоге (${orphans.join(', ')}). Они не отправляются и пропадут из сохранённых настроек при следующем сохранении. `,
    }),
    // button() is a const helper the extracted-function tests cannot see; el() builds the same node.
    el('button', {
      type: 'button',
      className: 'small',
      textContent: 'Удалить сейчас',
      onclick: () => void removeOrphans(),
    }),
  )
}

async function removeOrphans() {
  if (!gunOrphanIds().length || !gunCatalog) return
  const status = $('#gun-balance-status')
  say(status, 'удаляем…', 'pending')
  for (let attempt = 0; attempt < 2; attempt++) {
    const overrides = structuredClone(gunOverrides)
    for (const id of Object.keys(overrides))
      if (!gunCatalog!.guns.some((gun) => gun.id === id)) delete overrides[id]
    try {
      const result = await api('gun-balance', 'PUT', {
        expectedRevision: settingsRevision,
        cpRevisions: typeof settingsCpRevisions !== 'undefined' ? settingsCpRevisions : {},
        gunBalance: overrides,
      })
      settingsRevision = Math.max(settingsRevision, result.settings.revision)
      gunRevision = settingsRevision
      gunOverrides = structuredClone(result.settings.gunBalance ?? {})
      await loadSettings(0, true, result)
      filterGuns(true)
      say(status, 'осиротевшие записи удалены', 'ok')
      return
    } catch (error) {
      if (attempt || (error as Error & { status?: number }).status !== 409) {
        say(status, autosaveError(error), 'error')
        return
      }
      const fresh = await api('settings')
      await loadSettings(0, false, fresh)
    }
  }
}

let selectedGun: GunDefinition | undefined

const gunReaders = new Map<string, () => unknown>()

let gunFinalsRefresh: (() => void) | null = null

const gunText = (value: unknown) => JSON.stringify(value) ?? 'null'

function gunSummary(value: unknown): string {
  if (value === null || value === undefined) return 'не задано'
  if (typeof value === 'boolean') return value ? 'да' : 'нет'
  if (Array.isArray(value)) {
    const band = (item: any) =>
      item && typeof item === 'object' && 'distance' in item && 'damage' in item
    if (value.length && value.every(band))
      return value
        .map((item, i) =>
          item.distance === 'infinite' || i === value.length - 1
            ? `дальше — ${item.damage}`
            : `до ${item.distance} м — ${item.damage}`,
        )
        .join('; ')
    return value.length ? value.map(gunSummary).join(', ') : 'пусто'
  }
  if (typeof value === 'object')
    return (
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => `${GUN_LABELS[key] ?? key}: ${gunSummary(child)}`)
        .join('; ') || 'пусто'
    )
  return String(value)
}

function gunValues(base: any, overrides: any): any {
  if (
    !base ||
    !overrides ||
    typeof base !== 'object' ||
    typeof overrides !== 'object' ||
    Array.isArray(base) ||
    Array.isArray(overrides)
  )
    return overrides
  return Object.fromEntries([
    ...Object.entries(base),
    ...Object.entries(overrides).map(([key, value]) => [key, gunValues(base[key], value)]),
  ])
}

function gunBandInsert(
  bands: { distance: number | string; damage: number }[],
  fallbackDamage: number,
): { distance: number | string; damage: number }[] {
  const list = (Array.isArray(bands) ? bands : []).map((band) => ({ ...band }))
  if (!list.length) return [{ distance: 'infinite', damage: fallbackDamage }]
  const prev = list[list.length - 2] ?? list[list.length - 1]
  const finite = list
    .map((band) => band.distance)
    .filter((d): d is number => typeof d === 'number' && Number.isFinite(d))
  list.splice(list.length - 1, 0, {
    distance: (finite.length ? finite[finite.length - 1] : 0) + 25,
    damage: typeof prev?.damage === 'number' ? prev.damage : fallbackDamage,
  })
  return list
}

function gunBandRemove<T>(bands: T[], index: number): T[] {
  const list = (Array.isArray(bands) ? bands : []).slice()
  if (index >= 0 && index < list.length) list.splice(index, 1)
  return list
}

const gunPretty = (id: string) =>
  id
    .split(':')
    .at(-1)!
    .split(/[_/-]+/)
    .filter(Boolean)
    .map((part) =>
      /\d/.test(part) ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(' ')

const gunLabel = (gun: GunDefinition) =>
  gun.name.endsWith('.name') ? `${gunPretty(gun.id)} · ${gun.id}` : `${gun.name} · ${gun.id}`

function gunShape(field: GunField): string {
  if (field.type === 'object')
    return Object.entries(field.fields ?? {})
      .map(([key, child]) => `${key}: ${gunShape(child)}`)
      .join('; ')
  if (field.type === 'array') return `массив (${gunShape(field.items!)})`
  if (field.type === 'map')
    return `ключ: ${field.keys?.values?.join(' / ') ?? field.keys?.type}; значение: ${gunShape(field.items!)}`
  const words: Record<string, string> = {
    number: 'число',
    integer: 'целое число',
    boolean: 'да / нет',
    string: 'текст',
    resource: 'ID ресурса',
    json: 'число, текст, да/нет, список или набор полей',
  }
  return field.values?.map(gunValueLabel).join(' / ') ?? words[field.type] ?? field.type
}

function gunRowValue(row: Element) {
  return JSON.stringify(
    [...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].map((c) =>
      c instanceof HTMLInputElement && c.validity.badInput
        ? { unfinished: true }
        : c.type === 'checkbox'
          ? (c as HTMLInputElement).checked
          : c.value,
    ),
  )
}

function renderGun(live = false) {
  const gun = selectedGun
  const oldReaders = new Map(gunReaders)
  const oldRows = [
    ...$('#gun-fields').children,
    ...$('#gun-advanced-fields').children,
  ] as HTMLElement[]
  gunReaders.clear()
  gunFinalsRefresh = null
  if (!gun || !gunCatalog) {
    $('#gun-fields').replaceChildren()
    $('#gun-advanced-fields').replaceChildren()
    $('#gun-advanced').hidden = true
    return
  }
  $('#gun-about').textContent =
    gun.weaponKind === 'throwable'
      ? `${gunLabel(gun)} · прямое попадание. Взрыв, огонь и область поражения сохраняют обычный урон.`
      : gun.weaponKind === 'mounted'
        ? `${gunLabel(gun)} · орудие техники. Множители меняют только прямое попадание.`
        : gun.id === 'item:superbwarfare/taser'
          ? `${gunLabel(gun)} · множители меняют только урон дротика (1). Электрошок (2 сразу и ещё 4 раза по 2) не меняется, поэтому множитель до 2 при попадании не заметен.`
          : `${gunLabel(gun)} · ${gun.type}`
  // Aliases share native TaCZ data: the row shows this index's own defaults, but the game
  // runs the shared values. Only body multipliers are per-index.
  const sharers = gunCatalog.guns
    .filter((other) => other.id !== gun.id && other.data === gun.data)
    .map((other) => other.id)
  if (sharers.length)
    $('#gun-about').textContent +=
      ` Общие данные с ${sharers.join(', ')}: всё, кроме урона по частям тела, действует и для ${sharers.length === 1 ? 'него' : 'них'}.`
  $('#gun-warnings').textContent = gun.warnings.join(' ')
  {
    // «Дополнительно» по умолчанию свернуто для каждого оружия; живое обновление
    // каталога раскрытый блок не трогает. Состояние храним в DOM: тесты извлекают
    // renderGun без новых имён верхнего уровня.
    const adv = $<HTMLDetailsElement>('#gun-advanced')
    if (adv.dataset.gun !== gun.id) {
      adv.dataset.gun = gun.id
      adv.open = false
    }
  }
  // «Основные» — то, что крутит обычный админ; остальное — в «Дополнительно».
  // Всё это живёт внутри renderGun: тесты извлекают её целиком и не знают новых имён.
  const GUN_MAIN_TOP = new Set([
    'rpm',
    'ammo',
    'ammo_amount',
    'extended_mag_ammo_amount',
    'draw_time',
    'put_away_time',
    'sprint_time',
    'aim_time',
    'bolt_action_time',
    'bolt_feed_time',
    'damage',
    'armor_ignore',
    'head_shot',
    'reload',
  ])
  // Порядок «Основного»: сначала урон и магазин, затем остальное в порядке каталога.
  const GUN_MAIN_ORDER = [
    'bullet-damage',
    'bullet-extra_damage-damage_adjust',
    'bullet-extra_damage-armor_ignore',
    'bullet-extra_damage-head_shot_multiplier',
    'body_part_multipliers',
    'rpm',
    'ammo_amount',
    'extended_mag_ammo_amount',
    'reload',
    'ammo',
  ]
  const GUN_FLAT_PARENTS = new Set(['bullet', 'inaccuracy'])
  // Физика пули (жизнь, скорость, падение…) — не для «Основного»: уходит в «Дополнительно».
  const GUN_BULLET_PHYSICS = new Set([
    'life',
    'speed',
    'gravity',
    'knockback',
    'friction',
    'ignite_entity_time',
    'tracer_count_interval',
  ])
  const GUN_NULL_LABELS: Record<string, string> = {
    extra_damage: 'Не использовать доп. урон',
    extended_mag_ammo_amount: 'Без расширенного магазина',
    explosion: 'Без взрыва',
  }
  const gunNullLabel = (rk: string) =>
    (GUN_NULL_LABELS[rk.split('-').at(-1)!] ?? 'Не задано (как в ганпаке)') as string
  const GUN_CHILD_LABELS: Record<string, string> = {
    damage: 'Урон',
    armor_ignore: 'Бронепробитие',
    head_shot: 'Множитель урона в голову',
    distance: 'Дистанция',
    head_shot_multiplier: 'Множитель урона в голову',
    damage_adjust: 'Урон по дистанциям',
    extra_damage: 'Доп. урон',
    explosion: 'Взрыв',
    ignite: 'Поджог',
    feed: 'Досылка',
    cooldown: 'Дозарядка',
    empty: 'Пустой',
    tactical: 'Тактическая',
    heat: 'Нагрев',
    charging: 'Зарядка',
    fire_mode_adjust: 'Правки режимов огня',
    exclusive_attachments: 'Разрешённые обвесы',
    builtin_attachments: 'Встроенные обвесы',
    movement_speed: 'Скорость движения',
    burst_data: 'Очередь',
    fire_sound: 'Звук выстрела',
    script_param: 'Параметры скрипта',
    melee: 'Ближний бой',
    default: 'Обычный удар',
    pitch: 'Вверх',
    yaw: 'Вбок',
    time: 'Время',
    value: 'Значение',
    stand: 'Стоя',
    aim: 'В прицеле',
    move: 'В движении',
    sneak: 'Крадучись',
    lie: 'Лёжа',
    life: 'Время жизни пули',
    bullet_amount: 'Дробин за выстрел',
    speed: 'Скорость пули',
    gravity: 'Падение пули',
    knockback: 'Отбрасывание',
    friction: 'Трение пули',
    pierce: 'Пробивает целей',
    entity: 'Сущность',
    block: 'Блок',
    ignite_entity_time: 'Время поджога',
    tracer_count_interval: 'Трассировка',
    explode: 'Взрыв',
    radius: 'Радиус',
    destroy_block: 'Разрушение блоков',
    delay: 'Задержка',
    type: 'Тип',
    infinite: 'Бесконечная',
    fire_multiplier: 'Без глушителя',
    silence_multiplier: 'С глушителем',
    base: 'Обычная',
    continuous_shoot: 'Непрерывная',
    count: 'Выстрелов в очереди',
    bpm: 'Темп очереди',
    min_interval: 'Пауза',
    max: 'Максимум',
    per_shot: 'За выстрел',
    cooling_multiplier: 'Скорость остывания',
  }
  const GUN_HINTS: Record<string, string> = {
    armor_ignore:
      'Какая доля урона проходит сквозь броню: 0 — вся режется бронёй, 1 — броня не мешает.',
    inaccuracy: 'Разброс при стрельбе: больше число — кучность хуже.',
    tracer_count_interval: 'Каждая какая пуля трассирующая (0 — все).',
    extra_damage: 'Доп. правила урона: броня, голова, дистанции.',
    damage_adjust: 'Урон по дистанциям: чем дальше, тем меньше.',
  }
  const gunIsComplex = (field: GunField) =>
    ['object', 'array', 'map', 'json'].includes(field.type) || !!field.acceptsInfinite
  const gunIsObject = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  // Простые значения внутри bullet/reload/inaccuracy — отдельными полями в «Основных».
  const gunFlatKids = (top: string, field: GunField): [string, GunField][] | null => {
    if (!GUN_FLAT_PARENTS.has(top) || field.nullable) return null
    if (field.type === 'object')
      return Object.entries(field.fields ?? {}).filter(
        ([name, child]) =>
          !gunIsComplex(child) &&
          !child.nullable &&
          (top !== 'bullet' || !GUN_BULLET_PHYSICS.has(name)),
      )
    if (field.type === 'map' && field.items && !gunIsComplex(field.items)) {
      const names = field.keys?.values ?? Object.keys((gun.defaults[top] ?? {}) as object)
      return names.map((name) => [name, field.items!])
    }
    return null
  }
  const gunSame = (a: unknown, b: unknown) => gunText(a) === gunText(b)
  const gunMark = (node: HTMLElement, overridden: boolean, reset: HTMLElement | null) => {
    node.toggleAttribute('data-override', overridden)
    node.querySelector<HTMLElement>('.gun-badge')!.hidden = !overridden
    if (reset) reset.hidden = !overridden
  }
  const gunCurrentTop = (top: string) => {
    const over = Object.hasOwn(gunOverrides[gun.id] ?? {}, top)
    return {
      over,
      effective: over ? gunValues(gun.defaults[top], gunOverrides[gun.id][top]) : gun.defaults[top],
    }
  }
  const gunParentShape = (value: unknown) =>
    value === undefined
      ? 'missing'
      : value === null
        ? 'disabled'
        : gunIsObject(value)
          ? 'object'
          : typeof value
  const gunParentConflict = () =>
    new Error('Группа удалена, отключена или изменила тип. Обновите страницу и повторите правку.')
  const gunCheckParent = (expected: string, latest: unknown) => {
    if (
      !gunIsObject(latest) &&
      !(expected === 'missing' && latest === undefined) &&
      !(expected === 'disabled' && latest === null)
    )
      throw gunParentConflict()
  }
  // DOM snapshots only retain unfinished input; saves never read these as confirmed values.
  const gunSyncControls = (
    row: HTMLElement,
    write: (preserve?: ReadonlySet<HTMLElement>) => void,
    after = () => {},
  ) => {
    const controls = [
      ...row.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select'),
    ]
    const shown = new Map(controls.map((control) => [control, controlValue(control)]))
    return (accepted?: HTMLElement, submitted?: string) => {
      const nativeDrafts = new Set(
        controls.filter(
          (control) => control instanceof HTMLInputElement && control.validity.badInput,
        ),
      )
      const drafts = controls
        .filter(
          (control) =>
            controlValue(control) !== shown.get(control) &&
            !(control === accepted && controlValue(control) === submitted) &&
            !nativeDrafts.has(control),
        )
        .map((control) => [control, controlValue(control)] as const)
      // A native invalid number has no readable raw value; never assign to that input.
      write(nativeDrafts)
      for (const control of controls)
        if (!nativeDrafts.has(control)) shown.set(control, controlValue(control))
      if (!nativeDrafts.size) row.dataset.saved = gunRowValue(row)
      for (const [control, value] of drafts) setControl(control, value)
      after()
    }
  }
  const built: { rk: string; node: HTMLElement; main: boolean }[] = []
  for (const [key, field] of Object.entries(weaponFields(gunCatalog, gun).fields!)) {
    const hasOverride = Object.hasOwn(gunOverrides[gun.id] ?? {}, key)
    const value = hasOverride
      ? gunValues(gun.defaults[key], gunOverrides[gun.id][key])
      : gun.defaults[key]
    if (key === 'body_part_multipliers') {
      const body = renderBodyPartField(value as Record<string, any>, field, hasOverride)
      const state = el('span', { className: 'state', role: 'status' })
      const badge = el('span', {
        className: 'gun-badge',
        hidden: !hasOverride,
        textContent: 'изменено',
      })
      const row = el('div', { className: 'field row body-part-row', title: key }, body.node, state)
      row.dataset.rk = key
      const summary = body.node.querySelector('summary')!
      summary.id = `gun-field-${key}`
      summary.append(badge)
      gunReaders.set(key, body.read)
      body.node.addEventListener('input', () => gunFinalsRefresh?.())
      let bodyEnabled = hasOverride
      const confirmed = (preserve?: ReadonlySet<HTMLElement>) => {
        const enabled = Object.hasOwn(gunOverrides[gun.id] ?? {}, key)
        bodyEnabled = enabled
        body.write(
          (enabled
            ? gunValues(gun.defaults[key], gunOverrides[gun.id][key])
            : gun.defaults[key]) as Record<string, any>,
          enabled,
          preserve,
        )
        row.toggleAttribute('data-override', enabled)
        badge.hidden = !enabled
        if (!preserve?.size) row.dataset.saved = gunRowValue(row)
        gunFinalsRefresh?.()
      }
      const sync = gunSyncControls(row, confirmed, body.sync)
      gunReaders.set(`sync:${key}`, () => sync())
      body.node.addEventListener('change', (event) => {
        const control = event.target
        if (!(control instanceof HTMLInputElement)) return
        if (control.type === 'checkbox' && control.checked) {
          fieldState(state, '', '')
          body.node.querySelector<HTMLInputElement>('[type=number]')!.focus()
          return
        }
        const enabledBefore = bodyEnabled
        const submitted = controlValue(control)
        let next: Record<string, number> | undefined
        try {
          const values = body.read()
          next =
            values && Object.fromEntries(Object.entries(values).filter(([, value]) => value !== 1))
          if (next && !Object.keys(next).length) next = undefined
        } catch (error) {
          fieldState(state, (error as Error).message, 'error')
          return
        }
        void commitGun(
          control,
          state,
          gun.id,
          key,
          control.type === 'checkbox'
            ? undefined
            : () => {
                if (enabledBefore && !Object.hasOwn(gunOverrides[gun.id] ?? {}, key))
                  throw gunParentConflict()
                const part = control.id.slice('body-part-'.length)
                const merged = {
                  ...(gunCurrentTop(key).effective as Record<string, number>),
                  [part]: next?.[part] ?? 1,
                }
                const changed = Object.fromEntries(
                  Object.entries(merged).filter(([, value]) => value !== 1),
                )
                return Object.keys(changed).length ? changed : undefined
              },
          () => {
            row.toggleAttribute('data-override', Object.hasOwn(gunOverrides[gun.id] ?? {}, key))
            badge.hidden = !row.hasAttribute('data-override')
            sync(control, submitted)
            gunFinalsRefresh?.()
          },
          confirmed,
          'Урон по частям тела',
        ).then(body.sync)
      })
      row.toggleAttribute('data-override', hasOverride)
      row.dataset.saved = gunRowValue(row)
      const old = oldRows.find((row) => row.dataset.rk === key)
      if (
        live &&
        old &&
        (gunPending ||
          old.querySelector('.state[data-s="error"]') ||
          old.contains(document.activeElement) ||
          gunRowValue(old) !== old.dataset.saved)
      ) {
        old.toggleAttribute('data-override', hasOverride)
        old.querySelector<HTMLElement>('.gun-badge')!.hidden = !hasOverride
        oldReaders.get(`sync:${key}`)?.()
        gunReaders.set(`sync:${key}`, oldReaders.get(`sync:${key}`)!)
        gunReaders.set(key, oldReaders.get(key)!)
        built.push({ rk: key, node: old, main: true })
        continue
      }
      built.push({ rk: key, node: row, main: true })
      continue
    }
    const buildRow = (
      top: string,
      field: GunField,
      childKey?: string,
      childField?: GunField,
      main = false,
      shared = false,
    ) => {
      const sub = childField ?? field
      const rk = childKey ? `${top}-${childKey}` : top
      const id = `gun-field-${rk}`
      const { effective: parentEffective } = gunCurrentTop(top)
      const parentDefault = gun.defaults[top]
      let expectedParent = gunParentShape(parentEffective)
      const defaultValue = childKey
        ? gunIsObject(parentDefault)
          ? parentDefault[childKey]
          : undefined
        : parentDefault
      const value = childKey
        ? gunIsObject(parentEffective)
          ? parentEffective[childKey]
          : undefined
        : parentEffective
      const overridden = !gunSame(value, defaultValue)
      // Nullable: пустое поле — «по умолчанию», явный null — тумблер с понятной подписью.
      const off =
        !childKey && field.nullable
          ? el('input', {
              type: 'checkbox',
              checked: value === null,
              ariaLabel: gunNullLabel(rk),
            })
          : null
      const options =
        sub.values && !sub.values.includes(String(value ?? ''))
          ? [...sub.values, String(value ?? '')]
          : sub.values
      const input =
        sub.type === 'boolean'
          ? el('input', { id, type: 'checkbox', checked: value === true })
          : options
            ? el(
                'select',
                { id },
                ...options.map((v) => el('option', { value: v, textContent: gunValueLabel(v) })),
              )
            : el('input', {
                id,
                type: ['integer', 'number'].includes(sub.type) ? 'number' : 'text',
                value: value === null || value === undefined ? '' : String(value),
                placeholder:
                  defaultValue === null || defaultValue === undefined ? '' : String(defaultValue),
                step: sub.type === 'integer' ? '1' : 'any',
                ...(sub.min === undefined ? {} : { min: sub.min, max: sub.max }),
                maxLength: 256,
              })
      if (input instanceof HTMLSelectElement) input.value = String(value ?? '')
      gunReaders.set(rk, () => {
        if (off?.checked) return null
        if (sub.type === 'boolean') return (input as HTMLInputElement).checked
        if (input instanceof HTMLSelectElement) return input.value
        if (['integer', 'number'].includes(sub.type)) {
          // Недописанное число даёт value === '' с badInput: это ошибка, а не сброс.
          if ((input as HTMLInputElement).validity?.badInput) throw new Error('Введите число.')
          if (!input.value.trim()) return childKey ? structuredClone(defaultValue) : undefined
          if (!Number.isFinite(Number(input.value))) throw new Error('Введите число.')
          const parsed = Number(input.value)
          checkGunField(parsed, sub)
          return parsed
        }
        if (!input.value.trim()) return childKey ? structuredClone(defaultValue) : undefined
        return input.value
      })
      const state = el('span', { className: 'state', role: 'status' })
      const bare = top === 'bullet'
      const label = childKey
        ? bare
          ? (GUN_CHILD_LABELS[childKey] ?? GUN_LABELS[childKey] ?? childKey)
          : `${GUN_LABELS[top] ?? top} · ${GUN_CHILD_LABELS[childKey] ?? GUN_LABELS[childKey] ?? childKey}`
        : (GUN_LABELS[top] ?? top)
      const writeEffective = (preserve?: ReadonlySet<HTMLElement>) => {
        const { effective } = gunCurrentTop(top)
        if (gunIsObject(effective)) expectedParent = 'object'
        const shown = childKey
          ? gunIsObject(effective)
            ? effective[childKey]
            : undefined
          : effective
        if (!preserve?.has(input)) {
          if (input instanceof HTMLSelectElement) input.value = String(shown ?? '')
          else if (input.type === 'checkbox') input.checked = shown === true
          else input.value = shown === null || shown === undefined ? '' : String(shown)
        }
        if (off && !preserve?.has(off)) off.checked = shown === null
        if (input instanceof HTMLSelectElement && input.isConnected) customSelect(input)
      }
      const refreshMark = () => {
        const { effective } = gunCurrentTop(top)
        const shown = childKey
          ? gunIsObject(effective)
            ? effective[childKey]
            : undefined
          : effective
        gunMark(row, !gunSame(shown, defaultValue), reset)
      }
      const commit = (control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement) => {
        const submitted = controlValue(input)
        let next: unknown, childNext: unknown
        try {
          next = gunReaders.get(rk)!()
          childNext = next
          if (!childKey && next !== undefined && next !== null) checkGunField(next, field)
        } catch (error) {
          fieldState(state, (error as Error).message, 'error')
          return
        }
        // Родитель собирается при отправке из подтверждённого состояния: так не теряются
        // соседние поля, сохранённые раньше или другим редактором (409).
        const assemble = () => {
          if (childKey) gunCheckParent(expectedParent, gunCurrentTop(top).effective)
          if (childNext === undefined) return undefined
          const merged = childKey
            ? {
                ...(gunIsObject(gunCurrentTop(top).effective)
                  ? (gunCurrentTop(top).effective as object)
                  : {}),
                [childKey]: childNext,
              }
            : childNext
          return gunSame(merged, parentDefault) ? undefined : merged
        }
        next = assemble()
        void commitGun(
          control,
          state,
          gun.id,
          top,
          assemble,
          () => {
            refreshMark()
            sync(input, submitted)
            refreshBandFinals()
            if (shared) renderGun(true)
          },
          () => {
            writeEffective()
            refreshMark()
          },
          label,
          undefined,
          childKey
            ? {
                before: gunSummary(value) ?? 'null',
                after: gunSummary(next === undefined ? defaultValue : childNext) ?? 'null',
              }
            : undefined,
        )
      }
      const badge = el('span', {
        className: 'gun-badge',
        hidden: !overridden,
        textContent: 'изменено',
      })
      const defaultRepr = gunSummary(defaultValue) ?? 'null'
      const reset = el('button', {
        type: 'button',
        className: 'gun-reset',
        hidden: !overridden,
        title: `Вернуть значение ганпака (${defaultRepr.length > 120 ? `${defaultRepr.slice(0, 117)}…` : defaultRepr})`,
        ariaLabel: 'Вернуть значение ганпака',
        textContent: '↺',
        onclick: () => {
          if (input instanceof HTMLSelectElement) input.value = String(defaultValue ?? '')
          else if (input.type === 'checkbox') input.checked = defaultValue === true
          else
            input.value =
              defaultValue === null || defaultValue === undefined ? '' : String(defaultValue)
          if (off) off.checked = defaultValue === null
          commit(reset as HTMLButtonElement)
        },
      })
      input.onchange = () => commit(input)
      if (off) off.onchange = () => commit(off)
      // Лента дистанций заменяет базовый урон: база действует, только если её нет.
      const bandAdjust = (parentEffective as any)?.extra_damage?.damage_adjust
      const hasBands = rk === 'bullet-damage' && Array.isArray(bandAdjust) && bandAdjust.length > 0
      const hintText =
        rk === 'bullet-damage' && hasBands
          ? 'Используется, только если урон по дистанциям не задан.'
          : main
            ? (GUN_HINTS[childKey ?? top] ?? GUN_HINTS[top])
            : undefined
      const row = el(
        'div',
        { className: 'field row', title: top },
        el(
          'label',
          { htmlFor: id },
          label,
          el('small', {
            textContent:
              hintText ??
              `${gunShape(sub)}${sub.min === undefined ? '' : ` · от ${sub.min} до ${sub.max}`}`,
          }),
          badge,
        ),
        el(
          'div',
          { className: 'ctl' },
          input,
          reset,
          off ? el('label', { className: 'check' }, off, gunNullLabel(rk)) : null,
        ),
        state,
      )
      if (rk === 'bullet-damage' && !hasBands)
        gunDamageHint(row.querySelector('.ctl') as HTMLElement, () => {
          try {
            const value = gunReaders.get(rk)!()
            if (typeof value === 'number' && Number.isFinite(value)) return gunDamageText(value)
          } catch {
            // Черновик не числом — считаем от подтверждённого значения.
          }
          try {
            const eff = gunPathGet(gunCurrentTop(top).effective, childKey ? [childKey] : [])
            if (typeof eff === 'number') return gunDamageText(eff)
          } catch {
            // Нет подтверждённого числа — подскажем ввести.
          }
          return 'Введите урон числом — здесь будет итог по игроку в броне.'
        })
      const sync = gunSyncControls(row, writeEffective)
      gunReaders.set(`sync:${rk}`, () => sync())
      row.dataset.rk = rk
      row.toggleAttribute('data-override', overridden)
      row.dataset.saved = gunRowValue(row)
      const old = oldRows.find((row) => row.dataset.rk === rk)
      if (
        live &&
        old &&
        (gunPending ||
          old.querySelector('.state[data-s="error"]') ||
          old.contains(document.activeElement) ||
          gunRowValue(old) !== old.dataset.saved)
      ) {
        const { effective } = gunCurrentTop(top)
        const shown = childKey
          ? gunIsObject(effective)
            ? effective[childKey]
            : undefined
          : effective
        gunMark(old, !gunSame(shown, defaultValue), old.querySelector<HTMLElement>('.gun-reset'))
        oldReaders.get(`sync:${rk}`)?.()
        gunReaders.set(`sync:${rk}`, oldReaders.get(`sync:${rk}`)!)
        gunReaders.set(rk, oldReaders.get(rk)!)
        return { rk, node: old, main }
      }
      return { rk, node: row, main }
    }
    // ---- Структурный редактор: каждое поле рисуется по своему типу, без JSON. ----
    const gunKidLabel = (name: string) => GUN_CHILD_LABELS[name] ?? GUN_LABELS[name] ?? name
    const gunPathGet = (base: unknown, path: string[]): unknown => {
      let node = base
      for (const key of path) {
        if (!gunIsObject(node)) return undefined
        node = node[key] as unknown
      }
      return node
    }
    // Собирает значение всего top-поля из подтверждённого effective с правкой по пути.
    // undefined на месте листа удаляет ключ (с чисткой пустых объектов), null пишет явный null.
    const gunPathTop = (
      top: string,
      path: string[],
      leaf: unknown,
      parents?: string[],
    ): unknown => {
      if (!path.length) return leaf
      const { effective } = gunCurrentTop(top)
      parents?.forEach((expected, i) =>
        gunCheckParent(expected, gunPathGet(effective, path.slice(0, i))),
      )
      const base = (gunIsObject(effective) ? structuredClone(effective) : {}) as Record<
        string,
        unknown
      >
      const nodes: Record<string, unknown>[] = [base]
      let node = base
      for (const key of path.slice(0, -1)) {
        const child = gunIsObject(node[key]) ? { ...(node[key] as Record<string, unknown>) } : {}
        node[key] = child
        node = child
        nodes.push(node)
      }
      const last = path[path.length - 1]
      if (leaf === undefined) delete node[last]
      else node[last] = leaf
      for (let depth = nodes.length - 1; depth > 0; depth--) {
        const parent = nodes[depth - 1],
          key = path[depth - 1]
        if (gunIsObject(parent[key]) && !Object.keys(parent[key] as object).length)
          delete parent[key]
        else break
      }
      if (!Object.keys(base).length && gunIsObject(gun.defaults[top])) return undefined
      return base
    }
    const gunDamageParts = () => {
      const over = gunOverrides[gun.id]?.body_part_multipliers
      const base = gun.defaults.body_part_multipliers
      let merged = (over ? gunValues(base, over) : base) as Record<string, number> | undefined
      // Допустимый черновик множителей важнее подтверждённого значения.
      try {
        const reader = gunReaders.get('body_part_multipliers')
        // Снятая отметка (reader → undefined) — черновик сброса: считаем по умолчанию.
        if (reader) {
          const draft = reader()
          merged = (gunIsObject(draft) ? draft : base) as Record<string, number> | undefined
        }
      } catch {
        // Недописанное число — считаем от подтверждённого.
      }
      const part = (name: string) =>
        gunCatalog?.bodyPartsEnabled !== false && typeof merged?.[name] === 'number'
          ? (merged as Record<string, number>)[name]
          : 1
      return {
        head: part('head'),
        torso: part('torso'),
        limbs: [part('left_arm'), part('right_arm'), part('left_leg'), part('right_leg')],
      }
    }
    const gunDamageKit = () => {
      let group = gunPathGet(gunCurrentTop('bullet').effective, ['extra_damage'])
      try {
        const draft = gunReaders.get('bullet-extra_damage-off')?.()
        if (gunIsObject(draft)) {
          if (draft.extra_damage === null) group = null
          else if (group === null) group = gunPathGet(gun.defaults.bullet, ['extra_damage'])
        }
      } catch {
        // An invalid draft leaves the confirmed group in force.
      }
      // Refabricated's null branch initializes both native modifiers to zero.
      if (!gunIsObject(group)) return { armorIgnore: 0, headMult: 0 }
      const extra = (key: string, fallback: number) =>
        typeof group[key] === 'number' ? (group[key] as number) : fallback
      const num = (rk: string, fallback: number) => {
        try {
          // Черновик читаем листом поля: общий reader отдаёт весь родитель.
          const value = (gunReaders.get(`leaf:${rk}`) ?? gunReaders.get(rk))?.()
          return typeof value === 'number' && Number.isFinite(value) ? value : fallback
        } catch {
          return fallback
        }
      }
      return {
        armorIgnore: num('bullet-extra_damage-armor_ignore', extra('armor_ignore', 0)),
        headMult: num('bullet-extra_damage-head_shot_multiplier', extra('head_shot_multiplier', 1)),
      }
    }
    // Итоги считаются для истощённой плиты; PR #223 (2.78.2): плита снова прикрывает
    // конечности, а выстрелы в голову обходят её, но расходуют.
    const gunPlateNote =
      'Бронеплита (30 ед.) в итог не входит: она сначала забирает урон по груди, а после обновления 2.78.2 и по рукам и ногам; выстрелы в голову плиту обходят, но расходуют её.'
    const gunDamageText = (damage: number) => {
      const { armorIgnore, headMult } = gunDamageKit()
      const parts = gunDamageParts()
      const fmt = (x: number) => String(Math.round(x * 10) / 10)
      const final = (part: 'head' | 'torso' | 'limbs', bodyMult: number) =>
        fmt(
          finalDamageVsMatchKit({
            damage,
            armorIgnore,
            headMult,
            bodyMult,
            part,
          }),
        )
      const lo = Math.min(...parts.limbs),
        hi = Math.max(...parts.limbs)
      const limbText =
        lo === hi
          ? `${fmt(damage * lo)} → ${final('limbs', lo)}`
          : `${fmt(damage * lo)}–${fmt(damage * hi)} → ${final('limbs', lo)}–${final('limbs', hi)}`
      return `По игроку в броне: в голову ${fmt(damage * headMult * parts.head)} → ${final('head', parts.head)} · в тело ${fmt(damage * parts.torso)} → ${final('torso', parts.torso)} · руки/ноги ${limbText} · ${gunPlateNote}`
    }
    const gunDamageHint = (box: HTMLElement, paintText: () => string) => {
      const id = `gun-dmg-${Math.random().toString(36).slice(2)}`
      const pop = el('span', {
        className: 'gun-dmg-pop',
        id,
        role: 'note',
        hidden: true,
      })
      const paint = () => {
        pop.textContent = paintText()
      }
      const btn = el('button', {
        type: 'button',
        className: 'gun-dmg-btn',
        ariaDescribedby: id,
        title: 'Сколько урона дойдёт до игрока в броне',
        textContent: '?',
      })
      const show = () => {
        paint()
        pop.hidden = false
      }
      btn.addEventListener('mouseenter', show)
      btn.addEventListener('focus', show)
      btn.addEventListener('mouseleave', () => (pop.hidden = true))
      btn.addEventListener('blur', () => (pop.hidden = true))
      box.append(el('span', { className: 'gun-dmg' }, btn, pop))
    }
    const isGunDamagePath = (top: string, path: string[]) =>
      top === 'bullet' &&
      path[path.length - 1] === 'damage' &&
      (path.length === 1 || path.includes('damage_adjust'))
    type GunEdit = (latest: unknown) => unknown
    type GunChange = (control: HTMLElement, edit?: GunEdit) => void
    type GunCtl = {
      node: HTMLElement
      read: () => unknown
      write: (value: unknown) => void
      sync?: (value: unknown, accepted?: HTMLElement) => void
    }
    // Only an explicit edit may change a leaf; siblings always come from the server.
    const gunChildEdit = (latest: unknown, key: string, edit: GunEdit) => {
      const next = { ...(gunIsObject(latest) ? latest : {}) }
      const value = edit(next[key])
      if (value === undefined) delete next[key]
      else
        Object.defineProperty(next, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      return Object.keys(next).length ? next : undefined
    }
    const gunEditValue = (ctl: GunCtl, edit?: GunEdit): GunEdit => {
      if (edit) return edit
      try {
        const value = structuredClone(ctl.read())
        return () => value
      } catch (error) {
        return () => {
          throw error
        }
      }
    }
    const gunBandFinal = (damage: number) => {
      const { armorIgnore, headMult } = gunDamageKit()
      const parts = gunDamageParts()
      const fmt = (x: number) => String(Math.round(x * 10) / 10)
      const head = fmt(
        finalDamageVsMatchKit({
          damage,
          armorIgnore,
          headMult,
          bodyMult: parts.head,
          part: 'head',
        }),
      )
      const torso = fmt(
        finalDamageVsMatchKit({
          damage,
          armorIgnore,
          headMult,
          bodyMult: parts.torso,
          part: 'torso',
        }),
      )
      return `голова ${head} · тело ${torso}`
    }
    const refreshBandFinals = (root: ParentNode = document) => {
      for (const span of root.querySelectorAll('.gun-band-final')) {
        const row = (span as HTMLElement).closest('.gun-list-row')
        const input = row?.querySelector('input[type=number]') as HTMLInputElement | null
        const damage = Number(input?.value)
        span.textContent =
          input && Number.isFinite(damage) ? `итог: ${gunBandFinal(damage)}` : 'итог: —'
      }
    }
    gunFinalsRefresh = () => refreshBandFinals()
    // Компактная таблица «Урон по дистанциям»: одна строка на диапазон, итог сразу виден.
    // Последняя строка — открытая («от X м и дальше»), без ввода дистанции: хранится
    // маркер infinite из каталога, руками его никто не вводит. Удаление последней строки
    // делает открытой предыдущую, «+» вставляет конечную строку перед последней.
    const gunBandControl = (
      top: string,
      path: string[],
      field: GunField,
      onChange: GunChange,
    ): GunCtl => {
      const distField = field.items!.fields!.distance
      const dmgField = field.items!.fields!.damage
      const list = el('div', { className: 'gun-list' })
      let shown = ''
      const rows = () => [...list.children] as HTMLElement[]
      const distInput = (row: HTMLElement) =>
        row.querySelector('.gun-band-dist') as HTMLInputElement
      // Поле текстовое (там бывает «∞»), поэтому запятую-разделитель разбираем сами.
      const parseDistance = (raw: string) =>
        Number(/^\d+,\d+$/.test(raw) ? raw.replace(',', '.') : raw)
      const prevFinite = (before: number): number | undefined => {
        let found: number | undefined
        for (const row of rows().slice(0, before)) {
          const n = parseDistance(distInput(row).value.trim())
          if (Number.isFinite(n)) found = n
        }
        return found
      }
      const paintRows = (fill: boolean) => {
        const all = rows()
        all.forEach((row, index) => {
          const last = index === all.length - 1
          const dist = distInput(row)
          const lab = row.querySelector('.gun-band-lab')!
          const unit = row.querySelector('.gun-band-unit')!
          if (last) {
            const prev = prevFinite(index)
            lab.textContent = prev === undefined ? 'на любой дистанции' : `от ${prev} м и дальше`
            unit.textContent = '— урон'
            dist.hidden = true
          } else {
            if (
              fill &&
              (!dist.value.trim() ||
                dist.value.trim() === '∞' ||
                dist.value.trim().toLowerCase() === 'infinite')
            )
              dist.value = String((prevFinite(index) ?? 0) + 25)
            dist.hidden = false
            lab.textContent = 'до'
            unit.textContent = 'м · урон'
          }
        })
      }
      const readBand = (row: HTMLElement) => {
        const dmgInput = row.querySelector('input[type=number]') as HTMLInputElement
        const rawDmg = dmgInput.value.trim()
        if (!rawDmg) throw new Error('Заполните все строки или удалите пустые.')
        const damage = Number(rawDmg)
        if (!Number.isFinite(damage)) throw new Error('Введите число.')
        checkGunField(damage, dmgField)
        if (rows().indexOf(row) === rows().length - 1) return { distance: 'infinite', damage }
        const rawDist = distInput(row).value.trim()
        if (!rawDist) throw new Error('Укажите дистанцию или удалите строку.')
        const distance = parseDistance(rawDist)
        if (!Number.isFinite(distance)) throw new Error('Дистанция — число.')
        checkGunField(distance, distField)
        return { distance, damage }
      }
      const readAll = () => {
        const bands = rows().map((row) => readBand(row))
        // TaCZ берёт первую подходящую строку: границы обязаны строго расти.
        bands.forEach((band, index) => {
          const prev = bands[index - 1]
          if (
            index > 0 &&
            typeof band.distance === 'number' &&
            typeof prev.distance === 'number' &&
            band.distance <= prev.distance
          )
            throw new Error('Дистанции должны идти по возрастанию, без повторов.')
        })
        return bands
      }
      const appendBand = (distance: unknown, damage: unknown) => {
        const row = el('div', { className: 'gun-list-row' })
        const dist = el('input', {
          type: 'text',
          maxLength: 256,
          className: 'gun-band-dist',
          value:
            distance === 'infinite'
              ? '∞'
              : typeof distance === 'number'
                ? String(distance)
                : (distance ?? ''),
          title: 'Дистанция в метрах',
        })
        const dmg = el('input', {
          type: 'number',
          step: 'any',
          value: typeof damage === 'number' ? String(damage) : (damage ?? ''),
          title: 'Урон на этой дистанции',
        })
        const final = el('span', { className: 'gun-band-final' })
        const del = el('button', {
          type: 'button',
          className: 'gun-mini',
          textContent: '×',
          title: 'Удалить',
          ariaLabel: 'Удалить',
          onclick: () => {
            const index = rows().indexOf(row)
            try {
              write(gunBandRemove(readAll(), index))
            } catch {
              row.remove()
              paintRows(true)
            }
            onChange(del)
          },
        })
        // Строка 1 — ввод и ×, строка 2 (flex 100%) — итог; «?» живёт в шапке таблицы.
        const band = el(
          'span',
          { className: 'gun-band' },
          el('span', { className: 'gun-band-lab', textContent: 'до' }),
          dist,
          el('span', { className: 'gun-band-lab gun-band-unit', textContent: 'м · урон' }),
          dmg,
          del,
          final,
        )
        row.append(band)
        list.append(row)
        dist.onchange = () => onChange(dist)
        dmg.onchange = () => onChange(dmg)
        return row
      }
      list.addEventListener('input', () => {
        paintRows(false)
        refreshBandFinals()
      })
      const add = el('button', {
        type: 'button',
        className: 'small',
        textContent: '+ Добавить дистанцию',
        title: 'Добавить',
        ariaLabel: 'Добавить дистанцию',
        onclick: () => {
          let bands
          try {
            bands = readAll()
          } catch {
            // Commit покажет ошибку, черновик останется цел.
            onChange(add)
            return
          }
          const base = gunPathGet(gunCurrentTop(top).effective, ['damage'])
          const next = gunBandInsert(bands, typeof base === 'number' ? base : 0)
          write(next)
          rows()[Math.max(0, next.length - 2)]?.querySelector('input')?.focus()
          onChange(add)
        },
      })
      const box = el('div', { className: 'gun-sub' }, list, add)
      const write = (value: unknown) => {
        list.replaceChildren()
        for (const item of Array.isArray(value) ? value : []) {
          const band = (item ?? {}) as Record<string, unknown>
          appendBand(band.distance, band.damage)
        }
        paintRows(true)
        refreshBandFinals(box)
        shown = gunRowValue(box)
      }
      const ctl: GunCtl = {
        node: box,
        read: readAll,
        write,
        sync: (value, accepted) => {
          if (accepted || shown === gunRowValue(box)) {
            try {
              const bands = readAll()
              if (
                Array.isArray(value) &&
                value.length === bands.length &&
                value.every(
                  (band, i) =>
                    gunIsObject(band) &&
                    band.distance === bands[i].distance &&
                    band.damage === bands[i].damage,
                )
              ) {
                // Подтверждённая лента равна текущей: снапшот догоняет, DOM не трогаем.
                shown = gunRowValue(box)
                return
              }
            } catch {
              // A genuinely changed server list replaces an invalid accepted value.
            }
            write(value)
          }
        },
      }
      return ctl
    }
    const gunControl = (
      top: string,
      path: string[],
      field: GunField,
      changed: GunChange,
    ): GunCtl => {
      let parentShape = 'missing'
      const observeParent = (value: unknown) => {
        if (gunIsObject(value)) parentShape = 'object'
      }
      const onChange: GunChange = (control, edit) => {
        if (!edit || !['object', 'map'].includes(field.type)) return changed(control, edit)
        const expected = parentShape
        changed(control, (latest) => {
          gunCheckParent(expected, latest)
          return edit(latest)
        })
      }
      // Урон по дистанциям — компактная таблица с итогом, а не generic-список объектов.
      if (
        top === 'bullet' &&
        path.length === 2 &&
        path[0] === 'extra_damage' &&
        path[1] === 'damage_adjust'
      )
        return gunBandControl(top, path, field, onChange)
      const rk = [top, ...path].join('-')
      const id = `gun-field-${rk}`
      // Имя для скринридера: «Режим огня, пункт 2»; сгенерированные i0/e0 в имени не нужны.
      const ariaName = [
        GUN_LABELS[top] ?? top,
        ...path.filter((seg) => seg && !/^[ie]\d+$/.test(seg)).map(gunKidLabel),
      ].join(' · ')
      const nameControls = (node: HTMLElement, text: string) => {
        const controls = node.matches('input, select')
          ? [node]
          : [...node.querySelectorAll<HTMLElement>('input, select')]
        for (const control of controls)
          if (!control.hasAttribute('aria-label') && !(control as HTMLInputElement).labels?.length)
            control.setAttribute('aria-label', text)
      }
      const current = () => gunPathGet(gunCurrentTop(top).effective, path)
      const readNumber = (input: HTMLInputElement, blank: unknown) => {
        if (input.validity?.badInput) throw new Error('Введите число.')
        if (!input.value.trim()) return blank
        if (!Number.isFinite(Number(input.value))) throw new Error('Введите число.')
        const parsed = Number(input.value)
        checkGunField(parsed, field)
        return parsed
      }
      const checkout = (input: HTMLInputElement) => {
        input.onchange = () => onChange(input)
        return input
      }
      const selectout = (select: HTMLSelectElement) => {
        select.onchange = () => onChange(select)
        return select
      }
      const leaf = (
        node: HTMLElement,
        read: () => unknown,
        write: (value: unknown) => void,
      ): GunCtl => {
        let shown: string
        const snapshot = () =>
          node.matches('input, select')
            ? JSON.stringify([
                (node as HTMLInputElement).value,
                (node as HTMLInputElement).checked,
                (node as HTMLInputElement).validity?.badInput,
              ])
            : gunRowValue(node)
        const put = (value: unknown) => {
          parentShape = gunParentShape(value)
          write(value)
          shown = snapshot()
        }
        return {
          node,
          read,
          write: put,
          sync: (value, accepted) => {
            if (
              (accepted && (node === accepted || node.contains(accepted))) ||
              shown === snapshot()
            )
              put(value)
          },
        }
      }
      // Скаляры и enum: пустое поле — «по умолчанию».
      if (['integer', 'number'].includes(field.type) && !field.acceptsInfinite && !field.values) {
        const input = el('input', {
          id,
          type: 'number',
          step: field.type === 'integer' ? '1' : 'any',
          placeholder: 'как в ганпаке',
          ...(field.min === undefined ? {} : { min: field.min, max: field.max }),
        })
        checkout(input)
        const ctl = leaf(
          input,
          () => readNumber(input, undefined),
          (value) => {
            input.value = typeof value === 'number' ? String(value) : ''
          },
        )
        if (isGunDamagePath(top, path)) {
          const box = el('span', { className: 'gun-dmg-wrap' }, input)
          gunDamageHint(box, () => {
            try {
              const value = readNumber(input, undefined)
              if (typeof value === 'number' && Number.isFinite(value)) return gunDamageText(value)
              const eff = current()
              if (typeof eff === 'number') return gunDamageText(eff)
            } catch {
              // Нет числа — подскажем ввести.
            }
            return 'Введите урон числом — здесь будет итог по игроку в броне.'
          })
          return { ...ctl, node: box }
        }
        return ctl
      }
      if (field.type === 'boolean' && !field.values) {
        const input = checkout(el('input', { id, type: 'checkbox' }))
        return leaf(
          input,
          () => input.checked,
          (value) => {
            input.checked = value === true
          },
        )
      }
      if (field.values || field.type === 'string' || field.type === 'resource') {
        if (field.values) {
          const opts = [...field.values]
          const select = selectout(el('select', { id }))
          const paint = (value: unknown) => {
            select.replaceChildren(
              ...opts.map((v) => el('option', { value: v, textContent: gunValueLabel(v) })),
              typeof value === 'string' && !opts.includes(value) && value !== ''
                ? el('option', { value: value, textContent: `${value} (устаревшее)` })
                : null,
              value === null
                ? el('option', {
                    value: '',
                    textContent: 'устаревшее — выберите значение',
                    disabled: true,
                  })
                : null,
            )
            if (value === null) select.selectedIndex = opts.length
            else select.value = typeof value === 'string' ? value : (opts[0] ?? '')
          }
          return leaf(
            select,
            () => {
              if (select.selectedOptions[0]?.disabled) return null
              if (!select.value) return undefined
              if (!opts.includes(select.value)) throw new Error('Выберите допустимое значение')
              checkGunField(select.value, field)
              return select.value
            },
            (value) => {
              paint(value)
              if (select.isConnected) customSelect(select)
            },
          )
        }
        const input = checkout(
          el('input', { id, type: 'text', maxLength: 256, placeholder: 'текст' }),
        )
        return leaf(
          input,
          () => {
            if (!input.value.trim()) return undefined
            checkGunField(input.value, field)
            return input.value
          },
          (value) => {
            input.value = typeof value === 'string' ? value : ''
          },
        )
      }
      if (field.acceptsInfinite) {
        const input = checkout(
          el('input', { id, type: 'text', maxLength: 256, placeholder: 'число или infinite' }),
        )
        return leaf(
          input,
          () => {
            if (!input.value.trim()) return undefined
            const parsed = input.value.trim() === 'infinite' ? 'infinite' : Number(input.value)
            checkGunField(parsed, field)
            return parsed
          },
          (value) => {
            input.value = value === null || value === undefined ? '' : String(value)
          },
        )
      }
      if (field.type === 'json') {
        // Свободный JSON без текстового редактора: тип опредем по текущему значению.
        const kinds = ['число', 'текст', 'да/нет', 'список', 'объект'] as const
        const box = el('div', { className: 'gun-sub' })
        const kind = el('select', { ariaLabel: 'Тип значения' })
        const pending = el('small', {
          textContent: 'Новый тип сохранится после ввода значения.',
          hidden: true,
        })
        let inner: GunCtl | null = null
        const infer = (value: unknown): (typeof kinds)[number] =>
          typeof value === 'number'
            ? 'число'
            : typeof value === 'boolean'
              ? 'да/нет'
              : Array.isArray(value)
                ? 'список'
                : gunIsObject(value)
                  ? 'объект'
                  : 'текст'
        const pseudo = (value: unknown): GunField =>
          typeof value === 'number'
            ? { type: 'number', nullable: true, min: -1_000_000_000, max: 1_000_000_000 }
            : typeof value === 'boolean'
              ? { type: 'boolean', nullable: true }
              : Array.isArray(value)
                ? { type: 'array', nullable: true, items: { type: 'json', nullable: true } }
                : gunIsObject(value)
                  ? {
                      type: 'map',
                      nullable: true,
                      keys: { type: 'string', nullable: false },
                      items: { type: 'json', nullable: true },
                    }
                  : { type: 'string', nullable: true }
        const rebuild = (k: (typeof kinds)[number], value: unknown) => {
          const seed =
            k === 'число'
              ? typeof value === 'number'
                ? value
                : 0
              : k === 'да/нет'
                ? value === true
                : k === 'список'
                  ? Array.isArray(value)
                    ? value
                    : []
                  : k === 'объект'
                    ? gunIsObject(value)
                      ? value
                      : {}
                    : typeof value === 'string'
                      ? value
                      : ''
          inner = gunControl(top, [...path, ''], pseudo(seed), (control, edit) => {
            if (!inner) return
            if (box.dataset.typeDraft !== undefined) {
              let value: unknown
              try {
                value = inner.read()
              } catch (error) {
                onChange(control, () => {
                  throw error
                })
                return
              }
              if (value === undefined) return
              delete box.dataset.typeDraft
              pending.hidden = true
              onChange(control, () => value)
            } else onChange(control, gunEditValue(inner, edit))
          })
          inner.write(seed)
          // customSelect owns a sibling menu for this select; keep it attached across rebuilds.
          const menu = kind.nextElementSibling?.classList.contains('cselect')
            ? kind.nextElementSibling
            : null
          box.replaceChildren(kind, ...(menu ? [menu] : []), inner.node, pending)
          // Новые поля созданы заново: даём им имя настройки (тип уже подписан).
          nameControls(inner.node, ariaName)
          if (kind.isConnected) customSelect(kind)
        }
        kind.replaceChildren(...kinds.map((k) => el('option', { value: k, textContent: k })))
        kind.onchange = () => {
          rebuild(kind.value as (typeof kinds)[number], null)
          // Type selection is local; only entering a valid value replaces the saved leaf.
          box.dataset.typeDraft = ''
          pending.hidden = false
        }
        const ctl = leaf(
          box,
          () => (box.dataset.typeDraft !== undefined ? undefined : inner?.read()),
          (value) => {
            delete box.dataset.typeDraft
            pending.hidden = true
            kind.value = infer(value)
            rebuild(kind.value as (typeof kinds)[number], value)
          },
        )
        ctl.sync = (value, accepted) => {
          if (box.dataset.typeDraft !== undefined) return
          if (infer(value) === kind.value) inner?.sync?.(value, accepted)
          else ctl.write(value)
        }
        return ctl
      }
      if (field.type === 'object') {
        const wrap = el('div', { className: 'gun-sub' })
        if (field.acceptsBoolean) {
          // TaCZ принимает и простое да/нет, и подробный объект (ignite).
          const mode = selectout(el('select', { ariaLabel: 'Режим значения' }))
          const holder = el('div')
          let kids: GunCtl[] = []
          let modeDraft = false
          const paintKids = (value: unknown) => {
            holder.replaceChildren()
            kids = Object.entries(field.fields ?? {}).map(([name, sub]) => {
              const ctl = gunControl(top, [...path, name], sub, (control, edit) => {
                if (modeDraft) {
                  try {
                    const value = group.read()
                    if (value === undefined) return
                    modeDraft = false
                    delete wrap.dataset.typeDraft
                    changed(control, () => value)
                  } catch (error) {
                    changed(control, () => {
                      throw error
                    })
                  }
                } else {
                  const change = gunEditValue(ctl, edit)
                  onChange(control, (latest) => gunChildEdit(latest, name, change))
                }
              })
              const row = el('div', { className: 'gun-sub-row' })
              const lab = el('label', {
                htmlFor: `gun-field-${[top, ...path, name].join('-')}`,
              })
              lab.textContent = gunKidLabel(name)
              row.append(lab, ctl.node)
              holder.append(row)
              return ctl
            })
            const obj = gunIsObject(value) ? value : {}
            kids.forEach((ctl, i) =>
              ctl.write((obj as Record<string, unknown>)[Object.keys(field.fields ?? {})[i]]),
            )
            if (holder.isConnected)
              holder.querySelectorAll('select').forEach((s) => customSelect(s))
          }
          const paintMode = (value: unknown) => {
            modeDraft = false
            delete wrap.dataset.typeDraft
            mode.replaceChildren(
              el('option', { value: 'object', textContent: 'подробно' }),
              el('option', { value: 'true', textContent: 'да' }),
              el('option', { value: 'false', textContent: 'нет' }),
            )
            mode.value = typeof value === 'boolean' ? String(value) : 'object'
            holder.hidden = mode.value !== 'object'
            if (mode.value === 'object') paintKids(value)
          }
          mode.onchange = () => {
            paintMode(mode.value === 'object' ? {} : mode.value === 'true')
            if (mode.value === 'object') {
              modeDraft = true
              wrap.dataset.typeDraft = ''
            } else onChange(mode)
          }
          wrap.append(mode, holder)
          const group = leaf(
            wrap,
            () => {
              if (mode.value !== 'object') return mode.value === 'true'
              const out: Record<string, unknown> = {}
              for (const [name] of Object.entries(field.fields ?? {})) {
                const v = kids[Object.keys(field.fields ?? {}).indexOf(name)].read()
                if (v !== undefined) out[name] = v
              }
              return Object.keys(out).length ? out : undefined
            },
            paintMode,
          )
          group.sync = (value, accepted) => {
            if (modeDraft) return
            observeParent(value)
            if (mode.value === 'object' && typeof value !== 'boolean') {
              const obj = gunIsObject(value) ? value : {}
              Object.keys(field.fields ?? {}).forEach((name, i) =>
                kids[i].sync?.(obj[name], accepted),
              )
            } else group.write(value)
          }
          return group
        }
        const rows = Object.entries(field.fields ?? {}).map(([name, sub]) => {
          const ctl = gunControl(top, [...path, name], sub, (control, edit) => {
            const change = gunEditValue(ctl, edit)
            onChange(control, (latest) => gunChildEdit(latest, name, change))
          })
          const row = el('div', { className: 'gun-sub-row' })
          const lab = el('label', { htmlFor: `gun-field-${[top, ...path, name].join('-')}` })
          lab.textContent = gunKidLabel(name)
          row.append(lab, ctl.node)
          return { name, ctl, row }
        })
        wrap.append(...rows.map((r) => r.row))
        const ctl = leaf(
          wrap,
          () => {
            const out: Record<string, unknown> = {}
            for (const { name, ctl } of rows) {
              const v = ctl.read()
              if (v !== undefined) out[name] = v
            }
            return Object.keys(out).length ? out : undefined
          },
          (value) => {
            const obj = gunIsObject(value) ? (value as Record<string, unknown>) : {}
            for (const { name, ctl } of rows) ctl.write(obj[name])
          },
        )
        ctl.sync = (value, accepted) => {
          observeParent(value)
          const obj = gunIsObject(value) ? value : {}
          for (const { name, ctl } of rows) ctl.sync?.(obj[name], accepted)
        }
        return ctl
      }
      if (field.type === 'array') {
        const list = el('div', { className: 'gun-list' })
        const itemControls = new Map<HTMLElement, GunCtl>()
        let arrayBase: unknown[] = []
        let itemSeq = 0
        const blank = (): unknown => {
          const items = field.items!
          if (items.values?.length) return items.values[0]
          if (items.type === 'boolean') return false
          if (['integer', 'number'].includes(items.type)) return items.min ?? 0
          if (items.type === 'object' || items.type === 'map') return {}
          if (items.type === 'array') return []
          if (items.type === 'json') return 0
          return ''
        }
        const appendRow = (value: unknown) => {
          const items = field.items!
          const ctl = gunControl(top, [...path, `i${itemSeq++}`], items, (control, edit) => {
            const index = [...itemControls.keys()].indexOf(row)
            const change = gunEditValue(ctl, edit)
            const base = structuredClone(arrayBase)
            onChange(control, (latest) => {
              if (!Array.isArray(latest) || latest.length !== base.length)
                throw new Error('Список изменился. Обновите страницу и повторите правку.')
              if (base.some((item, i) => i !== index && !gunSame(item, latest[i])))
                throw new Error('Список изменился. Обновите страницу и повторите правку.')
              const next = structuredClone(latest)
              const value = change(next[index])
              if (value === undefined) throw new Error('Заполните все строки или удалите пустые.')
              next[index] = value
              return next
            })
          })
          const row = el('div', { className: 'gun-list-row' })
          const del = el('button', {
            type: 'button',
            className: 'gun-mini',
            textContent: '×',
            title: 'Удалить',
            ariaLabel: 'Удалить',
            onclick: () => {
              const index = [...itemControls.keys()].indexOf(row)
              const base = structuredClone(arrayBase)
              itemControls.delete(row)
              row.remove()
              onChange(del, (latest) => {
                if (!gunSame(latest, base))
                  throw new Error('Список изменился. Обновите страницу и повторите удаление.')
                return base.filter((_, i) => i !== index)
              })
            },
          })
          row.append(ctl.node, del)
          list.append(row)
          itemControls.set(row, ctl)
          nameControls(ctl.node, `${ariaName}, пункт ${list.children.length}`)
          ctl.write(value)
          const select = ctl.node.querySelector('select')
          if (select && select.isConnected) customSelect(select)
        }
        const add = el('button', {
          type: 'button',
          className: 'gun-mini',
          textContent: '+',
          title: 'Добавить',
          ariaLabel: 'Добавить',
          onclick: () => {
            // Строка добавляется пустой; сохранение — при её изменении.
            appendRow(blank())
          },
        })
        const box = el(
          'div',
          { className: 'gun-sub', role: 'group', ariaLabel: ariaName },
          list,
          add,
        )
        const ctl = leaf(
          box,
          () => {
            const out: unknown[] = []
            for (const ctl of itemControls.values()) {
              const v = ctl.read()
              if (v === undefined) throw new Error('Заполните все строки или удалите пустые.')
              out.push(v)
            }
            return out
          },
          (value) => {
            list.replaceChildren()
            itemControls.clear()
            arrayBase = structuredClone(Array.isArray(value) ? value : [])
            for (const item of arrayBase) appendRow(item)
          },
        )
        ctl.sync = (value, accepted) => {
          const items = Array.isArray(value) ? value : []
          if (items.length !== itemControls.size) {
            if (
              (accepted || arrayBase.length === itemControls.size) &&
              !box.querySelector('[data-type-draft]')
            )
              ctl.write(value)
          } else {
            arrayBase = structuredClone(items)
            ;[...itemControls.values()].forEach((child, i) => child.sync?.(items[i], accepted))
          }
        }
        return ctl
      }
      // map — по ключам; пустой ключ пропускается, дубли отвергаются чтением.
      const entries = el('div', { className: 'gun-list' })
      const unusedKeys = () =>
        (field.keys?.values ?? []).filter(
          (k) =>
            ![...entries.children].some(
              (row) =>
                (row.querySelector('[data-gunkey]') as HTMLInputElement | HTMLSelectElement)
                  ?.value === k,
            ),
        )
      const addEntry = el('button', {
        type: 'button',
        className: 'gun-mini',
        textContent: '+',
        title: 'Добавить',
        ariaLabel: 'Добавить',
        onclick: () => {
          const keys = field.keys
          appendEntry(keys?.values ? (unusedKeys()[0] ?? '') : '')
        },
      })
      const readEntries = () => {
        const out: Record<string, unknown> = {}
        for (const row of entries.children) {
          const key = (
            row.querySelector('[data-gunkey]') as HTMLInputElement | HTMLSelectElement
          ).value.trim()
          if (!key) continue
          if (Object.hasOwn(out, key)) throw new Error(`Ключ «${key}» уже есть.`)
          if (field.keys) checkGunField(key, field.keys)
          const ctl = entryControls.get(row as HTMLElement)
          const v = ctl?.read()
          if (v !== undefined) out[key] = v
        }
        return out
      }
      const entryControls = new Map<HTMLElement, GunCtl>()
      let entrySeq = 0
      const appendEntry = (key: string, value?: unknown, values?: GunField) => {
        void values
        const row = el('div', { className: 'gun-list-row' })
        const keyCtl = field.keys?.values
          ? selectout(
              el(
                'select',
                { dataGunkey: '' },
                ...(field.keys.values.map((v) =>
                  el('option', { value: v, textContent: gunValueLabel(v) }),
                ) as HTMLOptionElement[]),
              ),
            )
          : checkout(el('input', { type: 'text', maxLength: 256, dataGunkey: '' }))
        if (keyCtl instanceof HTMLSelectElement) {
          if (key && field.keys?.values?.includes(key)) keyCtl.value = key
        } else keyCtl.value = key
        let sourceKey = key
        const readKey = () => {
          const key = keyCtl.value.trim()
          if (!key) return ''
          if (field.keys) checkGunField(key, field.keys)
          if (
            [...entries.children].some(
              (other) =>
                other !== row &&
                (other.querySelector('[data-gunkey]') as HTMLInputElement)?.value.trim() === key,
            )
          )
            throw new Error(`Ключ «${key}» уже есть.`)
          return key
        }
        const val = gunControl(top, [...path, `e${entrySeq++}`], field.items!, (control, edit) => {
          try {
            const key = readKey()
            if (!key) return
            const change = gunEditValue(val, edit)
            sourceKey = key
            onChange(control, (latest) => gunChildEdit(latest, key, change))
          } catch (error) {
            onChange(control, () => {
              throw error
            })
          }
        })
        keyCtl.onchange = () => {
          try {
            const target = readKey(),
              source = sourceKey
            if (!target || target === source) return
            const added = source ? undefined : structuredClone(val.read())
            if (!source && added === undefined) return
            sourceKey = target
            onChange(keyCtl, (latest) => {
              const obj = gunIsObject(latest) ? latest : {}
              if (Object.hasOwn(obj, target)) throw new Error(`Ключ «${target}» уже есть.`)
              const value = source ? obj[source] : added
              const removed = source ? gunChildEdit(obj, source, () => undefined) : obj
              return value === undefined ? removed : gunChildEdit(removed, target, () => value)
            })
          } catch (error) {
            onChange(keyCtl, () => {
              throw error
            })
          }
        }
        entryControls.set(row, val)
        const del = el('button', {
          type: 'button',
          className: 'gun-mini',
          textContent: '×',
          title: 'Удалить',
          ariaLabel: 'Удалить',
          onclick: () => {
            const key = sourceKey
            entryControls.delete(row)
            row.remove()
            onChange(del, (latest) => gunChildEdit(latest, key, () => undefined))
          },
        })
        keyCtl.setAttribute('aria-label', `${ariaName}, ключ`)
        row.append(keyCtl, val.node, del)
        entries.append(row)
        val.write(value)
        nameControls(val.node, `${ariaName}, значение`)
        if (keyCtl instanceof HTMLSelectElement && keyCtl.isConnected) customSelect(keyCtl)
        const select = val.node.querySelector('select')
        if (select && select.isConnected) customSelect(select)
      }
      const mapBox = el(
        'div',
        { className: 'gun-sub', role: 'group', ariaLabel: ariaName },
        entries,
        addEntry,
      )
      const mapCtl = leaf(
        mapBox,
        () => {
          const out = readEntries()
          return Object.keys(out).length ? out : undefined
        },
        (value) => {
          entries.replaceChildren()
          entryControls.clear()
          for (const [k, v] of Object.entries(
            gunIsObject(value) ? (value as Record<string, unknown>) : {},
          ))
            appendEntry(k, v)
        },
      )
      mapCtl.sync = (value, accepted) => {
        observeParent(value)
        const obj = gunIsObject(value) ? value : {}
        const seen = new Set<string>()
        for (const [row, ctl] of entryControls) {
          const key = (row.querySelector('[data-gunkey]') as HTMLInputElement).value.trim()
          seen.add(key)
          if (Object.hasOwn(obj, key)) ctl.sync?.(obj[key], accepted)
          else if (
            key &&
            !row.querySelector('[data-type-draft]') &&
            !row.contains(document.activeElement)
          ) {
            entryControls.delete(row)
            row.remove()
          }
        }
        for (const [key, value] of Object.entries(obj)) if (!seen.has(key)) appendEntry(key, value)
      }
      return mapCtl
    }
    const gunNullWrap = (
      field: GunField,
      inner: GunCtl,
      onChange: GunChange,
      nullLabel = 'Не задано (как в ганпаке)',
    ): GunCtl => {
      if (!field.nullable) return inner
      const off = el('input', { type: 'checkbox', ariaLabel: nullLabel })
      off.onchange = () => {
        inner.node.toggleAttribute('inert', off.checked)
        onChange(off)
      }
      const box = el(
        'div',
        { className: 'gun-null' },
        el('label', { className: 'check' }, off, nullLabel),
        inner.node,
      )
      return {
        node: box,
        read: () => (off.checked ? null : inner.read()),
        sync: (value, accepted) => {
          off.checked = value === null
          inner.node.toggleAttribute('inert', off.checked)
          inner.sync?.(value === null ? undefined : value, accepted)
        },
        write: (value) => {
          off.checked = value === null
          inner.node.toggleAttribute('inert', off.checked)
          inner.write(value)
        },
      }
    }
    const buildStructuredRow = (
      top: string,
      path: string[],
      field: GunField,
      main = false,
      shared = false,
      shortLabel = '',
    ) => {
      const rk = [top, ...path].join('-')
      const id = `gun-field-${rk}`
      const parentDefault = gun.defaults[top]
      const defaultValue = gunPathGet(parentDefault, path)
      // Массив и null заменяют значение целиком, поэтому смотрим на наличие ключа, а не на тип.
      const readLeaf = () => gunPathGet(gunCurrentTop(top).effective, path)
      const parents = path.map((_, i) =>
        gunParentShape(gunPathGet(gunCurrentTop(top).effective, path.slice(0, i))),
      )
      const overridden = !gunSame(readLeaf(), defaultValue)
      const state = el('span', { className: 'state', role: 'status' })
      const badge = el('span', {
        className: 'gun-badge',
        hidden: !overridden,
        textContent: 'изменено',
      })
      const segs = [top, ...path]
      const segKnown = (s: string, i: number) =>
        i
          ? GUN_CHILD_LABELS[s] !== undefined || GUN_LABELS[s] !== undefined
          : GUN_LABELS[s] !== undefined
      const segName = (s: string, i: number) => (i ? gunKidLabel(s) : (GUN_LABELS[s] ?? s))
      // Сырой ключ в конце — не главная подпись: показываем русскую группу,
      // а ключ уходит в мелкий вторичный текст. В «Дополнительно» группа уходит
      // в общий заголовок, строке остаётся только короткая подпись.
      const fullLabel = segKnown(segs.at(-1)!, segs.length - 1)
        ? segs.map(segName).join(' · ')
        : segs.slice(0, -1).map(segName).join(' · ') || 'Параметр'
      const label = (shortLabel ||
        (!main && segs.length > 1
          ? segKnown(segs.at(-1)!, segs.length - 1)
            ? segName(segs.at(-1)!, segs.length - 1)
            : segs.at(-1)!
          : fullLabel)) as string
      const rawKeys = segs.filter((s, i) => !segKnown(s, i))
      const ctl = gunNullWrap(
        field,
        gunControl(top, path, field, (c, edit) => commit(c, edit)),
        (c) => commit(c),
        gunNullLabel(rk),
      )
      ctl.write(readLeaf() === undefined ? defaultValue : readLeaf())
      const writeEffective = () => ctl.write(readLeaf() === undefined ? defaultValue : readLeaf())
      const refreshMark = () => gunMark(row, !gunSame(readLeaf(), defaultValue), reset)
      const commit = (control: HTMLElement, edit?: GunEdit) => {
        let next: unknown
        let change: GunEdit
        const submitted = gunRowValue(row)
        // Re-evaluate the operation on every attempt, including a 409 refresh.
        const assemble = () => {
          const leaf = change(readLeaf())
          if (leaf !== undefined) checkGunField(leaf, field)
          const merged = gunPathTop(top, path, leaf, parents)
          return merged !== undefined && gunSame(merged, parentDefault) ? undefined : merged
        }
        try {
          change = gunEditValue(ctl, edit)
          if (!edit && field.type === 'array' && control !== reset) {
            const before = structuredClone(readLeaf())
            const replace = change
            change = (latest) => {
              if (!gunSame(latest, before))
                throw new Error('Список изменился. Обновите страницу и повторите правку.')
              return replace(latest)
            }
          }
          next = assemble()
        } catch (error) {
          fieldState(state, (error as Error).message, 'error')
          return
        }
        void commitGun(
          control as HTMLInputElement | HTMLSelectElement | HTMLButtonElement,
          state,
          gun.id,
          top,
          assemble,
          () => {
            refreshMark()
            ctl.sync?.(readLeaf(), submitted === gunRowValue(row) ? control : undefined)
            row.dataset.saved = gunRowValue(row)
            refreshBandFinals()
            if (shared) renderGun(true)
          },
          () => {
            writeEffective()
            refreshMark()
          },
          label,
          undefined,
          {
            before: gunSummary(readLeaf()) ?? 'null',
            after: gunSummary(next === undefined ? defaultValue : gunPathGet(next, path)) ?? 'null',
          },
        )
      }
      const defaultRepr = gunSummary(defaultValue) ?? 'null'
      const reset = el('button', {
        type: 'button',
        className: 'gun-reset',
        hidden: !overridden,
        title: `Вернуть значение ганпака (${defaultRepr.length > 120 ? `${defaultRepr.slice(0, 117)}…` : defaultRepr})`,
        ariaLabel: 'Вернуть значение ганпака',
        textContent: '↺',
        onclick: () => {
          ctl.write(defaultValue)
          commit(reset as HTMLButtonElement)
        },
      })
      const leafHint = GUN_HINTS[path.at(-1) ?? top] ?? GUN_HINTS[top]
      const hintBase =
        leafHint && field.type !== 'map'
          ? leafHint
          : field.type === 'array'
            ? 'Список: «+» добавляет строку, «×» удаляет.'
            : field.type === 'map'
              ? 'Записи по ключам; строка с пустым ключом пропускается.'
              : (leafHint ??
                (field.type === 'object'
                  ? 'Пустые поля — «по умолчанию».'
                  : `${gunShape(field)}${field.min === undefined ? '' : ` · от ${field.min} до ${field.max}`}`))
      const hint = rawKeys.length ? `${hintBase} · ключ: ${rawKeys.join(' · ')}` : hintBase
      const row = el(
        'div',
        { className: 'field row', title: rk },
        el('label', { htmlFor: id }, label, el('small', { textContent: hint }), badge),
        el('div', { className: 'ctl' }, ctl.node, reset),
        state,
      )
      if (rk === 'bullet-extra_damage-damage_adjust') {
        // Лента заменяет базу: «?» с итогом по дистанциям живёт в шапке таблицы.
        const bandsHint = () => {
          let bands: { distance: unknown; damage: unknown }[]
          try {
            bands = ctl.read() as { distance: unknown; damage: unknown }[]
          } catch {
            return 'Заполните дистанции — здесь будет итог по игроку в броне.'
          }
          if (!Array.isArray(bands) || !bands.length)
            return 'Добавьте дистанции — здесь будет итог по игроку в броне.'
          return bands
            .map((band, index) => {
              const where = index === bands.length - 1 ? 'дальше' : `до ${String(band.distance)} м`
              return typeof band.damage === 'number' && Number.isFinite(band.damage)
                ? `${where} — ${String(band.damage)}: ${gunBandFinal(band.damage)}`
                : `${where}: введите урон числом`
            })
            .concat(gunPlateNote)
            .join('\n')
        }
        gunDamageHint(row.querySelector('label') as HTMLElement, bandsHint)
        // «?» — в строку с названием, а не под хинт.
        {
          const lab = row.querySelector('label') as HTMLElement
          const dmg = lab.querySelector('.gun-dmg')
          const hint = lab.querySelector('small')
          if (dmg && hint) lab.insertBefore(dmg, hint)
        }
      }
      row.dataset.rk = rk
      row.toggleAttribute('data-override', overridden)
      row.dataset.saved = gunRowValue(row)
      gunReaders.set(rk, () => gunPathTop(top, path, ctl.read()))
      gunReaders.set(`leaf:${rk}`, () => ctl.read())
      gunReaders.set(`sync:${rk}`, () => {
        parents.forEach((_, i) => {
          if (gunIsObject(gunPathGet(gunCurrentTop(top).effective, path.slice(0, i))))
            parents[i] = 'object'
        })
        ctl.sync?.(readLeaf())
      })
      // Итоги по дистанциям следят за незаписанным черновиком брони и множителя в голову.
      if (rk.startsWith('bullet-extra_damage-'))
        row.addEventListener('input', () => refreshBandFinals())
      const old = oldRows.find((row) => row.dataset.rk === rk)
      if (
        live &&
        old &&
        (gunPending ||
          old.querySelector('[data-type-draft]') ||
          old.querySelector('.state[data-s="error"]') ||
          old.contains(document.activeElement) ||
          gunRowValue(old) !== old.dataset.saved)
      ) {
        gunMark(
          old,
          !gunSame(readLeaf(), defaultValue),
          old.querySelector<HTMLElement>('.gun-reset'),
        )
        oldReaders.get(`sync:${rk}`)?.()
        gunReaders.set(`sync:${rk}`, oldReaders.get(`sync:${rk}`)!)
        gunReaders.set(rk, oldReaders.get(rk)!)
        gunReaders.set(`leaf:${rk}`, oldReaders.get(`leaf:${rk}`)!)
        return { rk, node: old, main }
      }
      return { rk, node: row, main }
    }
    // Тумблер «не использовать» для nullable-группы без дублирования её редактора.
    const buildNullToggleRow = (top: string, path: string[], legend: string, main = false) => {
      const toggleRk = [top, ...path, 'off'].join('-')
      const toggleId = `gun-field-${toggleRk}`
      const toggleParentDefault = gun.defaults[top]
      const toggleDefault = gunPathGet(toggleParentDefault, path)
      const toggleRead = () => gunPathGet(gunCurrentTop(top).effective, path)
      const toggleParents = path.map((_, i) =>
        gunParentShape(gunPathGet(gunCurrentTop(top).effective, path.slice(0, i))),
      )
      const toggleOverridden = !gunSame(toggleRead(), toggleDefault)
      const toggleState = el('span', { className: 'state', role: 'status' })
      const toggleBadge = el('span', {
        className: 'gun-badge',
        hidden: !toggleOverridden,
        textContent: 'изменено',
      })
      const toggleOff = el('input', {
        id: toggleId,
        type: 'checkbox',
        checked: toggleRead() === null,
      })
      const toggleDefaultRepr = gunSummary(toggleDefault) ?? 'null'
      const toggleReset = el('button', {
        type: 'button',
        className: 'gun-reset',
        hidden: !toggleOverridden,
        title: `Вернуть значение ганпака (${toggleDefaultRepr.length > 120 ? `${toggleDefaultRepr.slice(0, 117)}…` : toggleDefaultRepr})`,
        ariaLabel: 'Вернуть значение ганпака',
        textContent: '↺',
        onclick: () => {
          toggleOff.checked = toggleDefault === null
          toggleCommit(toggleReset as HTMLButtonElement)
        },
      })
      const toggleWrite = (preserve?: ReadonlySet<HTMLElement>) => {
        if (!preserve?.has(toggleOff)) toggleOff.checked = toggleRead() === null
      }
      const toggleMark = () =>
        gunMark(toggleRow, !gunSame(toggleRead(), toggleDefault), toggleReset)
      const toggleCommit = (control: HTMLInputElement | HTMLButtonElement) => {
        const submitted = controlValue(toggleOff)
        const leaf = toggleOff.checked ? null : undefined
        const assemble = () => {
          const next = gunPathTop(top, path, leaf, toggleParents)
          return next !== undefined && gunSame(next, toggleParentDefault) ? undefined : next
        }
        const fixed = assemble()
        void commitGun(
          control,
          toggleState,
          gun.id,
          top,
          assemble,
          () => {
            toggleMark()
            toggleSync(toggleOff, submitted)
            renderGun(true)
          },
          () => {
            toggleWrite()
            toggleMark()
          },
          legend,
          undefined,
          {
            before: gunSummary(toggleRead()) ?? 'null',
            after: gunSummary(fixed === undefined ? toggleDefault : null) ?? 'null',
          },
        )
      }
      toggleOff.onchange = () => toggleCommit(toggleOff)
      const toggleRow = el(
        'div',
        { className: 'field row', title: toggleRk },
        el(
          'label',
          { htmlFor: toggleId },
          legend,
          el('small', {
            textContent:
              toggleDefault === null
                ? 'По умолчанию не используется.'
                : 'По умолчанию используется.',
          }),
          toggleBadge,
        ),
        el('div', { className: 'ctl' }, toggleOff, toggleReset),
        toggleState,
      )
      const toggleSync = gunSyncControls(toggleRow, toggleWrite)
      gunReaders.set(`sync:${toggleRk}`, () => toggleSync())
      toggleRow.dataset.rk = toggleRk
      toggleRow.toggleAttribute('data-override', toggleOverridden)
      toggleRow.dataset.saved = gunRowValue(toggleRow)
      gunReaders.set(toggleRk, () => gunPathTop(top, path, toggleOff.checked ? null : undefined))
      const toggleOld = oldRows.find((row) => row.dataset.rk === toggleRk)
      if (
        live &&
        toggleOld &&
        (gunPending ||
          toggleOld.querySelector('.state[data-s="error"]') ||
          toggleOld.contains(document.activeElement) ||
          gunRowValue(toggleOld) !== toggleOld.dataset.saved)
      ) {
        gunMark(
          toggleOld,
          !gunSame(toggleRead(), toggleDefault),
          toggleOld.querySelector<HTMLElement>('.gun-reset'),
        )
        oldReaders.get(`sync:${toggleRk}`)?.()
        gunReaders.set(`sync:${toggleRk}`, oldReaders.get(`sync:${toggleRk}`)!)
        gunReaders.set(toggleRk, oldReaders.get(toggleRk)!)
        return { rk: toggleRk, node: toggleOld, main }
      }
      return { rk: toggleRk, node: toggleRow, main }
    }
    const kids = gunFlatKids(key, field) ?? []
    const kidNames = new Set(kids.map(([childKey]) => childKey))
    const leftovers =
      field.type === 'object' && kids.length
        ? Object.entries(field.fields ?? {}).filter(([childKey]) => !kidNames.has(childKey))
        : []
    // Каждое значение правится ровно один раз: простые дети — строками, остальное —
    // структурными редакторами; полного JSON-дубликата больше нет.
    for (const [childKey, childField] of kids)
      built.push(buildRow(key, field, childKey, childField, true, leftovers.length > 0))
    // Доп. урон пули — наверх «Основного» теми же значениями, без дублирующего редактора.
    let extraSurfaced = false
    if (key === 'bullet' && field.type === 'object') {
      const extra = field.fields?.extra_damage
      if (extra?.type === 'object' && extra.fields) {
        extraSurfaced = true
        if (extra.fields.armor_ignore)
          built.push(
            buildStructuredRow(
              key,
              ['extra_damage', 'armor_ignore'],
              extra.fields.armor_ignore,
              true,
              false,
              'Бронепробитие',
            ),
          )
        if (extra.fields.head_shot_multiplier)
          built.push(
            buildStructuredRow(
              key,
              ['extra_damage', 'head_shot_multiplier'],
              extra.fields.head_shot_multiplier,
              true,
              false,
              'Множитель урона в голову',
            ),
          )
        if (extra.fields.damage_adjust)
          built.push(
            buildStructuredRow(
              key,
              ['extra_damage', 'damage_adjust'],
              extra.fields.damage_adjust,
              true,
              false,
              'Урон по дистанциям',
            ),
          )
        if (extra.nullable)
          built.push(buildNullToggleRow(key, ['extra_damage'], GUN_NULL_LABELS.extra_damage, false))
      }
    }
    if (!kids.length) {
      if (
        ['number', 'integer', 'boolean', 'string', 'resource'].includes(field.type) &&
        !field.acceptsInfinite
      )
        built.push(
          buildRow(
            key,
            field,
            undefined,
            undefined,
            GUN_MAIN_TOP.has(key) && !field.nullable,
            false,
          ),
        )
      else built.push(buildStructuredRow(key, [], field, GUN_MAIN_TOP.has(key)))
    }
    for (const [childKey, childField] of leftovers) {
      if (extraSurfaced && childKey === 'extra_damage') continue
      built.push(buildStructuredRow(key, [childKey], childField, false, kids.length > 0))
    }
  }
  const mainRows = built.filter((row) => row.main)
  // Порядок «Основного»: урон и магазин сверху, остальное в порядке каталога.
  mainRows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        (GUN_MAIN_ORDER.indexOf(a.row.rk) === -1
          ? GUN_MAIN_ORDER.length
          : GUN_MAIN_ORDER.indexOf(a.row.rk)) -
          (GUN_MAIN_ORDER.indexOf(b.row.rk) === -1
            ? GUN_MAIN_ORDER.length
            : GUN_MAIN_ORDER.indexOf(b.row.rk)) || a.index - b.index,
    )
    .forEach(({ row }, at) => (mainRows[at] = row))
  const advRows = built.filter((row) => !row.main)
  // Группы «Дополнительно»: общий заголовок вместо повтора префикса в каждой строке.
  const advNodes: HTMLElement[] = []
  {
    const groups = new Map<string, typeof advRows>()
    for (const row of advRows) {
      const top = row.rk.split('-')[0]
      groups.set(top, [...(groups.get(top) ?? []), row])
    }
    for (const [top, rows] of groups) {
      if (rows.length > 1 || rows.some((row) => row.rk.includes('-')))
        advNodes.push(el('div', { className: 'gun-group-title', textContent: gunGroupTitle(top) }))
      for (const row of rows) advNodes.push(row.node)
    }
  }
  const syncRows = (container: Element, list: { rk: string; node: HTMLElement }[]) => {
    if (!live) {
      container.replaceChildren(...list.map((row) => row.node))
      return
    }
    list.forEach((row, index) => {
      const old = container.children[index]
      if (!old) container.append(row.node)
      else if (old !== row.node) old.replaceWith(row.node)
    })
    while (container.children.length > list.length) container.lastElementChild!.remove()
  }
  const syncNodes = (container: Element, want: HTMLElement[]) => {
    if (!live) {
      container.replaceChildren(...want)
      return
    }
    want.forEach((node, index) => {
      const old = container.children[index]
      if (!old) container.append(node)
      else if (old !== node) old.replaceWith(node)
    })
    while (container.children.length > want.length) container.lastElementChild!.remove()
  }
  syncRows($('#gun-fields'), mainRows)
  syncNodes($('#gun-advanced-fields'), advNodes)
  $('#gun-advanced').hidden = !advRows.length
  for (const box of ['#gun-fields', '#gun-advanced-fields'])
    $(box).querySelectorAll('select').forEach(customSelect)
  gunFinalsRefresh?.()
}

function filterGuns(live = false) {
  if (!gunCatalog) return
  const query = $<HTMLInputElement>('#gun-search').value.toLowerCase().trim()
  const guns = gunCatalog.guns
    .filter((gun) =>
      `${gun.name} ${gun.id} ${gun.type} ${gunPretty(gun.id)}`.toLowerCase().includes(query),
    )
    .sort(
      (a, b) =>
        Number(KIT_GUNS.has(b.id)) - Number(KIT_GUNS.has(a.id)) ||
        Number(!!gunOverrides[b.id]) - Number(!!gunOverrides[a.id]) ||
        a.id.localeCompare(b.id),
    )
  const select = $<HTMLSelectElement>('#gun-select')
  select.replaceChildren(
    ...guns.map((gun) =>
      el('option', {
        value: gun.id,
        textContent: `${gunLabel(gun)}${gunOverrides[gun.id] ? ' · изменено' : ''}`,
      }),
    ),
  )
  select.value =
    selectedGun && guns.some((gun) => gun.id === selectedGun!.id)
      ? selectedGun.id
      : (guns[0]?.id ?? '')
  selectedGun = gunCatalog.guns.find((gun) => gun.id === select.value)
  customSelect(select)
  renderGun(live)
  renderOrphans()
  if (!guns.length) $('#gun-about').textContent = 'Оружие не найдено. Измените запрос.'
}

async function loadGunBalance() {
  const [availability, { settings }] = await Promise.all([api('gun-balance'), api('settings')])
  const form = $<HTMLFormElement>('#gun-balance-form')
  form.hidden = !availability.available
  if (!availability.available) {
    say($('#gun-balance-status'), availability.error, 'error')
    return
  }
  gunCatalog = availability.catalog
  if ((settings.revision ?? 0) >= observedSettingsRevision)
    await loadSettings(0, true, { settings })
  gunRevision = Math.max(gunRevision, settings.revision ?? 0)
  settingsRevision = Math.max(settingsRevision, gunRevision)
  filterGuns(true)
  const count = gunCatalog!.guns.length
  const plural = new Intl.PluralRules('ru').select(count)
  say(
    $('#gun-balance-status'),
    `${count} ${plural === 'one' ? 'оружие' : plural === 'few' ? 'оружия' : 'оружий'} в каталоге${gunCatalog!.bodyPartsEnabled === false ? '. Урон по частям тела пока выключен на сервере; множители можно подготовить заранее.' : ''}`,
  )
}

function checkGunField(value: any, field: GunField, depth = 0) {
  if (value === null && (field.nullable || (field.type === 'json' && depth > 0))) return
  if (field.acceptsInfinite && value === 'infinite') return
  if (field.acceptsBoolean && typeof value === 'boolean') return
  const fail = (text: string): never => {
    throw new Error(text)
  }
  if (value === null) fail('Значение null недоступно')
  if (depth > (field.type === 'json' ? 8 : 16)) fail('Слишком много вложенных полей')
  if (typeof value === 'object' && Object.keys(value).length > 256)
    fail('Слишком много элементов. Сократите список.')
  if (field.type === 'json') {
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 1_000_000_000))
      fail('Проверьте число')
    if (typeof value === 'string' && value.length > 4096) fail('Слишком длинный текст')
    if (typeof value === 'object')
      Object.values(value).forEach((child) => checkGunField(child, field, depth + 1))
    return
  }
  if (['number', 'integer'].includes(field.type)) {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (field.type === 'integer' && !Number.isInteger(value))
    )
      fail('Введите число')
    if (
      (field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max)
    )
      fail(`от ${field.min} до ${field.max}`)
  } else if (field.type === 'boolean') {
    if (typeof value !== 'boolean') fail('Выберите значение')
  } else if (field.type === 'array') {
    if (!Array.isArray(value)) fail('Нужен список значений')
    value.forEach((v: unknown) => checkGunField(v, field.items!, depth + 1))
  } else if (field.type === 'object' || field.type === 'map') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Нужна группа значений')
    for (const [key, child] of Object.entries(value)) {
      if (field.type === 'map') checkGunField(key, field.keys!)
      const rule = field.type === 'map' ? field.items : field.fields?.[key]
      if (!rule) fail('Неизвестное поле')
      checkGunField(child, rule!, depth + 1)
    }
  } else {
    if (typeof value !== 'string' || !value.trim() || value.length > 256)
      fail('Введите текст до 256 символов')
    if (field.type === 'resource' && !/^(?:[a-z0-9_.-]+:)?[a-z0-9/._-]+$/.test(value))
      fail('Проверьте ID')
  }
  if (field.values && !field.values.some((v) => v === value || v.toUpperCase() === value))
    fail('Выберите допустимое значение')
}

let gunQueue = Promise.resolve(),
  gunPending = 0

let gunQueueVersion = 0

function commitGun(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement,
  line: HTMLElement,
  id: string,
  key: string | null,
  // Готовое значение или функция: её вызывают при отправке (и при повторе после 409),
  // чтобы собрать изменение из последнего подтверждённого состояния.
  requested: unknown,
  saved: () => void,
  restore: () => void,
  label: string,
  canUndo?: () => boolean,
  summary?: { before: string; after: string },
) {
  const queueVersion = gunQueueVersion
  gunPending++
  gunQueue = gunQueue.then(async () => {
    if (queueVersion !== gunQueueVersion) {
      gunPending--
      return
    }
    const defaults =
      gunCatalog?.guns?.find((gun) => gun.id === id)?.defaults ?? selectedGun?.defaults
    let old: any, oldValue: unknown
    const feedback = key === 'body_part_multipliers' ? bodyPartSummary : gunSummary
    fieldState(line, 'сохраняем…', 'saving')
    const release = lockControl(control)
    let rejected = false
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const value = typeof requested === 'function' ? requested() : requested
        if (canUndo && !canUndo()) {
          toast(`${label}: значение уже изменил ${remoteSettingsName}`)
          return
        }
        // База для «Отменить» берётся для той попытки, что дошла до сервера: после
        // 409-обновления это уже состояние с чужими правками.
        old = structuredClone(key ? gunOverrides[id]?.[key] : gunOverrides[id])
        oldValue = key
          ? old === undefined
            ? defaults?.[key]
            : gunValues(defaults?.[key], old)
          : (old ?? defaults)
        const overrides = structuredClone(gunOverrides)
        if (key === null) {
          if (value === undefined) delete overrides[id]
          else overrides[id] = value as GunOverrides[string]
        } else {
          const gun = (overrides[id] ??= {})
          if (value === undefined) delete gun[key]
          else gun[key] = value as GunOverrides[string][string]
          if (!Object.keys(gun).length) delete overrides[id]
        }
        // Orphaned entries (guns missing from the catalog) would fail the whole save
        // with 400: they stay out of the payload and are offered for removal instead.
        if (gunCatalog)
          for (const entry of Object.keys(overrides))
            if (!gunCatalog.guns.some((gun) => gun.id === entry)) delete overrides[entry]
        try {
          const result = await api('gun-balance', 'PUT', {
            expectedRevision: settingsRevision,
            cpRevisions: typeof settingsCpRevisions !== 'undefined' ? settingsCpRevisions : {},
            gunBalance: overrides,
          })
          settingsRevision = Math.max(settingsRevision, result.settings.revision)
          gunRevision = settingsRevision
          if (result.settings.revision >= observedSettingsRevision) {
            gunOverrides = structuredClone(result.settings.gunBalance ?? {})
            saved()
          }
          const select = $<HTMLSelectElement>('#gun-select')
          for (const option of select.options) {
            const gun = gunCatalog?.guns.find((gun) => gun.id === option.value)
            if (gun)
              option.textContent = `${gunLabel(gun)}${gunOverrides[gun.id] ? ' · изменено' : ''}`
          }
          customSelect(select)
          await loadSettings(0, true, result)
          renderOrphans()
          settingsMeta()
          fieldState(line, 'сохранено', 'saved')
          // Сервер отдаёт компактный override (без равных ганпаку соседей): «Отменить»
          // сверяется с ним, а не с отправленным полным значением.
          // Берём из ответа на наш сохранённый запрос, а не из глобального состояния:
          // более новая чужая ревизия не должна считаться нашим результатом.
          const savedOverrides = result.settings.gunBalance ?? {}
          const canonical = JSON.stringify(key ? savedOverrides[id]?.[key] : savedOverrides[id])
          changeToast(
            label,
            summary?.before ?? feedback(oldValue),
            summary?.after ??
              (value === undefined
                ? key === 'body_part_multipliers'
                  ? bodyPartSummary(defaults?.[key])
                  : 'как в ганпаке'
                : feedback(key ? gunValues(defaults?.[key], value) : value)),
            false,
            () => {
              const current = key ? gunOverrides[id]?.[key] : gunOverrides[id]
              if (JSON.stringify(current) !== canonical) {
                toast(`${label}: значение уже изменил ${remoteSettingsName}`)
                return
              }
              void commitGun(
                control,
                line,
                id,
                key,
                old,
                () => {
                  if (selectedGun?.id === id) {
                    renderGun()
                    let target = key
                      ? (document.getElementById(`gun-field-${key}`) ??
                        document.querySelector(`[id^="gun-field-${key}-"]`))
                      : $('#gun-reset')
                    if (target && 'disabled' in target && target.disabled)
                      target =
                        target
                          .closest('.field')
                          ?.querySelector<HTMLInputElement>('input, select, textarea, button') ??
                        target
                    if (target instanceof HTMLSelectElement)
                      document.getElementById(`${target.id}-btn`)?.focus()
                    else (target as HTMLElement | null)?.focus()
                  }
                },
                restore,
                label,
                () =>
                  JSON.stringify(key ? gunOverrides[id]?.[key] : gunOverrides[id]) === canonical,
              )
            },
          )
          break
        } catch (error) {
          if (attempt || (error as Error & { status?: number }).status !== 409) throw error
          const fresh = await api('settings')
          await loadSettings(0, false, fresh)
        }
      }
    } catch (error) {
      if ((error as Error & { status?: number }).status === 403) gunQueueVersion++
      rejected = true
      fieldState(line, autosaveError(error), 'error')
    } finally {
      release()
      if (rejected) restore()
      gunPending--
      if (!gunPending && !rejected) {
        for (const [key, sync] of gunReaders) if (key.startsWith('sync:')) sync()
        gunFinalsRefresh?.()
      }
    }
  })
  return gunQueue
}

let kitCatalog: KitCatalog | undefined,
  kitRevision = 0,
  selectedKit = '',
  kitOverrides: Record<string, KitDefinition> = Object.create(null),
  kitBindings: Record<string, string | null> = {},
  kitClassCosts: Record<string, number> = {},
  kitSnapshot = ''

let kitQueue = Promise.resolve(),
  kitPending = 0

type KitPatch = { path: string[]; value: any }

const kitChanges = new Map<HTMLElement, KitPatch[]>(),
  kitTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

let kitEditingControl: HTMLElement | null = null

function kitDiff(before: any, after: any, path: string[] = []): KitPatch[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return []
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    Array.isArray(before) === Array.isArray(after) &&
    (!Array.isArray(before) || before.length === after.length)
  )
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      kitDiff(before[key], after[key], [...path, key]),
    )
  if (before === undefined && after && typeof after === 'object' && !Object.keys(after).length)
    return []
  return [{ path, value: after }]
}

function kitDraftDiff(before: any, after: any) {
  return kitDiff(
    { ...before, kits: effectiveKits(kitCatalog!, before.kits, kitClassCosts) },
    { ...after, kits: effectiveKits(kitCatalog!, after.kits, kitClassCosts) },
  )
}

function kitPatch(body: any, { path, value }: KitPatch) {
  let parent = body
  for (const key of path.slice(0, -1)) parent = parent[key] ??= {}
  const key = path.at(-1)!
  if (value === undefined) delete parent[key]
  else parent[key] = structuredClone(value)
}

function kitValue(body: any, path: string[]) {
  return path.reduce((value, key) => value?.[key], body)
}

function rememberKitChange(before: any, after: any, path: string[]) {
  const changes = kitDiff(before, after, path)
  if (kitEditingControl) {
    const previous = kitChanges.get(kitEditingControl) ?? []
    kitChanges.set(kitEditingControl, [
      ...previous.filter(
        (old) =>
          !changes.some((change) => JSON.stringify(change.path) === JSON.stringify(old.path)),
      ),
      ...changes,
    ])
  }
  return changes
}

let kitDraftSnapshot = ''

const kitBody = () => JSON.stringify({ kits: kitOverrides, fixedModeKits: kitBindings })

function kitMeta() {
  $('#kits-meta').textContent =
    `${kitBody() === kitSnapshot ? 'Изменений нет' : 'Есть несохранённые изменения'} · ревизия ${kitRevision}`
}

function renderKits() {
  if (!kitCatalog) return
  const definitions = effectiveKits(kitCatalog, kitOverrides, kitClassCosts),
    select = $<HTMLSelectElement>('#kit-select')
  select.replaceChildren(
    ...Object.values(definitions).map((kit) =>
      el('option', {
        value: kit.id,
        textContent: `${kit.name} · ${kit.id}${kitOverrides[kit.id] ? ' · изменено' : ''}`,
      }),
    ),
  )
  if (!Object.hasOwn(definitions, selectedKit)) selectedKit = Object.keys(definitions)[0] ?? ''
  select.value = selectedKit
  customSelect(select)
  const kit = definitions[selectedKit],
    standard = kitCatalog.kits.find((entry) => entry.id === selectedKit)?.defaults
  $('#kit-about').textContent = kit
    ? standard
      ? 'Сброс вернёт стандартное снаряжение. Уже выданные предметы останутся у игроков.'
      : 'Пользовательский набор. Удаление уберёт его из следующих выдач.'
    : 'Наборов нет. Создайте первый.'
  $('#kit-reset').textContent = standard ? 'Вернуть стандартный набор' : 'Удалить набор'
  $<HTMLButtonElement>('#kit-reset').disabled = !kit
  $<HTMLButtonElement>('#kit-new').disabled =
    Object.keys(definitions).length >= kitCatalog.fields.kits.max
  let previousDraft = structuredClone(kit)
  $('#kit-fields').replaceChildren(
    ...(kit
      ? [
          renderKitForm(kitCatalog, kit, (draft) => {
            const changes = rememberKitChange(previousDraft, draft, ['kits', draft.id])
            previousDraft = structuredClone(draft)
            const body = { kits: kitOverrides, fixedModeKits: kitBindings }
            kitOverrides[draft.id] ??= structuredClone(kit)
            for (const change of changes) kitPatch(body, change)
            renderKitBindings()
            kitMeta()
            scheduleKitSave()
          }),
        ]
      : []),
  )
  renderKitBindings()
  kitMeta()
}

function renderKitBindings() {
  if (!kitCatalog) return
  const definitions = effectiveKits(kitCatalog, kitOverrides, kitClassCosts)
  $('#kit-bindings').replaceChildren(
    ...kitCatalog.modes
      .filter((mode) => mode.supportsFixedKit)
      .map((mode) => {
        const input = el(
          'select',
          {},
          el('option', {
            value: 'default',
            textContent: `Стандарт: ${mode.defaultFixedKitId ? (definitions[mode.defaultFixedKitId]?.name ?? mode.defaultFixedKitId) : 'меню выбора'}`,
          }),
          el('option', { value: 'menu', textContent: 'Меню выбора' }),
          ...Object.values(definitions)
            .filter((kit) => kit.allowedModeIds.includes(mode.id))
            .map((kit) => el('option', { value: `kit:${kit.id}`, textContent: kit.name })),
        )
        input.value = !Object.hasOwn(kitBindings, mode.id)
          ? 'default'
          : kitBindings[mode.id] === null
            ? 'menu'
            : `kit:${kitBindings[mode.id]}`
        input.addEventListener('change', () => {
          const before = kitBindings[mode.id]
          if (input.value === 'default') delete kitBindings[mode.id]
          else kitBindings[mode.id] = input.value === 'menu' ? null : input.value.slice(4)
          rememberKitChange(before, kitBindings[mode.id], ['fixedModeKits', mode.id])
          kitMeta()
          scheduleKitSave(input)
        })
        return field(ARENA_MODES[mode.id as keyof typeof ARENA_MODES] ?? mode.id, input)
      }),
  )
  $('#kit-bindings').querySelectorAll<HTMLSelectElement>('select').forEach(customSelect)
}

async function loadKits(live = false) {
  if (
    live &&
    kitCatalog &&
    (kitPending || kitBody() !== kitSnapshot || $('#kits-form').contains(document.activeElement))
  )
    return
  const [availability, { settings }] = await Promise.all([api('kits'), api('settings')])
  $<HTMLFormElement>('#kits-form').hidden = !availability.available
  if (!availability.available) {
    say($('#kits-status'), availability.error, 'error')
    return
  }
  if (settings.revision < observedSettingsRevision) return
  if (
    live &&
    kitCatalog &&
    (kitPending || kitBody() !== kitSnapshot || $('#kits-form').contains(document.activeElement))
  )
    return
  kitCatalog = availability.catalog
  kitOverrides = Object.assign(Object.create(null), structuredClone(settings.kits ?? {}))
  kitBindings = structuredClone(settings.fixedModeKits ?? {})
  kitRevision = settings.revision
  kitClassCosts = structuredClone(settings.classCosts ?? {})
  kitSnapshot = kitDraftSnapshot = kitBody()
  kitChanges.clear()
  await loadSettings(0, true, { settings })
  renderKits()
  say(
    $('#kits-status'),
    `${kitCatalog!.kits.length} наборов в каталоге. Выдача следует подтверждённым настройкам сервера.`,
  )
}

function scheduleKitSave(control = kitEditingControl) {
  if (!control) return
  clearTimeout(kitTimers.get(control))
  kitTimers.set(
    control,
    setTimeout(() => void commitKits(undefined, control), 1200),
  )
}

function commitKits(
  undo?: { before: KitPatch[]; after: KitPatch[] },
  control: HTMLElement | null = document.activeElement instanceof HTMLElement &&
  $('#kits-form').contains(document.activeElement)
    ? document.activeElement
    : null,
) {
  if (control) {
    clearTimeout(kitTimers.get(control))
    kitTimers.delete(control)
  }
  const draft = JSON.parse(kitBody()),
    baseline = JSON.parse(kitDraftSnapshot),
    changes =
      undo?.before ??
      (control && kitChanges.get(control)) ??
      (control ? [] : kitDraftDiff(baseline, draft)),
    line = control?.closest('.field')?.querySelector<HTMLElement>('.state') ?? $('#kits-status')
  if (!changes.length) return kitQueue
  if (!undo && control instanceof HTMLInputElement && !control.checkValidity()) {
    fieldState(line, 'Исправьте значение.', 'error')
    return kitQueue
  }
  if (!undo && !control && !$<HTMLFormElement>('#kits-form').checkValidity()) {
    fieldState(line, 'Исправьте значение.', 'error')
    return kitQueue
  }
  if (!undo) {
    for (const change of changes) kitPatch(baseline, change)
    kitDraftSnapshot = JSON.stringify(baseline)
    if (control) kitChanges.delete(control)
  }
  kitPending++
  fieldState(line, 'сохраняем…', 'saving')
  kitQueue = kitQueue.then(async () => {
    try {
      if (!kitCatalog) throw new Error('Каталог наборов недоступен.')
      for (let attempt = 0; attempt < 2; attempt++) {
        const fresh = await api('settings'),
          body: any = {
            kits: structuredClone(fresh.settings.kits ?? {}),
            fixedModeKits: structuredClone(fresh.settings.fixedModeKits ?? {}),
          },
          effective = effectiveKits(kitCatalog, body.kits, fresh.settings.classCosts ?? {})
        for (const { path } of changes)
          if (path[0] === 'kits' && path.length > 2 && !body.kits[path[1]]) {
            if (!effective[path[1]] && JSON.parse(kitSnapshot).kits[path[1]])
              throw new Error('Набор уже удалён. Обновите каталог.')
            body.kits[path[1]] = structuredClone(effective[path[1]] ?? draft.kits[path[1]])
          }
        if (
          undo &&
          undo.after.some(
            ({ path, value }) => JSON.stringify(kitValue(body, path)) !== JSON.stringify(value),
          )
        ) {
          toast('Наборы уже изменены. Отмена недоступна.')
          return
        }
        const before = changes.map(({ path }) => ({
          path,
          value: structuredClone(kitValue(body, path)),
        }))
        for (const change of changes) kitPatch(body, change)
        validateKitChanges(
          body.kits,
          body.fixedModeKits,
          kitCatalog,
          fresh.settings.classCosts ?? {},
        )
        try {
          const result = await api('kits', 'PUT', {
            expectedRevision: fresh.settings.revision,
            cpRevisions: fresh.cpRevisions ?? {},
            ...body,
          })
          if (result.settings.revision >= observedSettingsRevision) {
            const expected = JSON.parse(kitSnapshot),
              current = JSON.parse(kitBody())
            for (const change of changes) {
              kitPatch(expected, change)
              if (
                undo &&
                undo.after.some(
                  (saved) =>
                    JSON.stringify(saved.path) === JSON.stringify(change.path) &&
                    JSON.stringify(kitValue(current, saved.path)) === JSON.stringify(saved.value),
                )
              )
                kitPatch(current, change)
            }
            const local = kitDraftDiff(expected, current)
            kitRevision = result.settings.revision
            kitSnapshot = JSON.stringify(body)
            kitDraftSnapshot = kitSnapshot
            const merged = structuredClone(body)
            for (const change of local) kitPatch(merged, change)
            kitOverrides = merged.kits
            kitBindings = merged.fixedModeKits
            if (undo && !local.length && !$('#kits-form').contains(document.activeElement))
              renderKits()
            await loadSettings(0, true, result)
          }
          kitMeta()
          fieldState(line, 'сохранено', 'saved')
          say($('#kits-status'), 'Сохранено. Новую выдачу подтвердит игровой сервер.', 'pending')
          if (!undo)
            changeToast(
              'Наборы',
              'прежние значения',
              'новые значения',
              false,
              () => void commitKits({ before, after: changes }, control),
            )
          return
        } catch (error) {
          if (attempt || (error as Error & { status?: number }).status !== 409) throw error
        }
      }
    } catch (error) {
      fieldState(line, autosaveError(error), 'error')
      say($('#kits-status'), autosaveError(error), 'error')
      kitDraftSnapshot = kitSnapshot
      if (control && !kitChanges.has(control)) kitChanges.set(control, changes)
    } finally {
      kitPending--
    }
  })
  return kitQueue
}

type Rule = { type: 'int' | 'double' | 'bool'; min?: number; max?: number }

let rules: Record<string, Rule> = {},
  settingsRevision = 0,
  settingsCpRevisions: Record<string, number> = {},
  balance: Record<string, Record<string, number | boolean>> = {},
  scope = '*',
  extraLocks: string[] = [],
  hadLocks = false

let defaults: Record<string, string> = {}

const LOBBY = [
  {
    key: 'pvpCooldownSeconds',
    label: 'Задержка перед выключением PvP',
    unit: 'сек',
    min: 0,
    max: 600,
    def: 10,
  },
]

const ROOMS = [
  { key: 'maxRooms', label: 'Матчей одновременно', unit: 'шт', min: 1, max: 16, def: 2 },
  {
    key: 'idleCloseSeconds',
    label: 'Закрывать пустую комнату через',
    unit: 'сек',
    min: 30,
    max: 3600,
    def: 600,
  },
  {
    key: 'abandonCloseSeconds',
    label: 'Завершать матч без игроков через',
    unit: 'сек',
    min: 5,
    max: 600,
    def: 30,
  },
]

const DEATHMATCH = [
  { key: 'minPlayers', label: 'Игроков для старта', unit: 'чел', min: 1, max: 24, def: 2 },
]

const SETTING_LABELS: Record<string, string> = {
  pvpEnabled: 'PvP в лобби',
  classLocks: 'Закрытые классы',
  classCosts: 'Стоимость высадки',
  parcool: 'Ограничения паркура',
  ...Object.fromEntries([...LOBBY, ...ROOMS, ...DEATHMATCH].map((f) => [f.key, f.label])),
  ...BALANCE_LABELS,
}

function numberField(
  label: string,
  name: string,
  min: number,
  max: number,
  step: string,
  value: number,
  unit?: string,
  about?: string,
) {
  const input = el('input', {
    type: 'number',
    name,
    min,
    max,
    step,
    inputMode: step === '1' ? 'numeric' : 'decimal',
    value,
    required: true,
  })
  const wrap = unit
    ? el(
        'div',
        { className: 'unit' },
        input,
        el('span', { className: 'unit__suffix', textContent: unit, ariaHidden: 'true' }),
      )
    : undefined
  return field(label, input, `${about ? `${about} ` : ''}${number(min)}–${number(max)}`, wrap)
}

const scopeDefault = (key: string, selectedScope = scope) =>
  selectedScope === '*'
    ? BALANCE_DEFAULTS.room[key]
    : (balance['*']?.[key] ?? BALANCE_DEFAULTS[selectedScope][key])

function renderBalance(live = false, serverBalance?: typeof balance) {
  const values = (serverBalance ?? balance)[scope] ?? {}
  $('#scope-hint').textContent =
    scope === '*'
      ? 'Общие значения для всех кампаний и обычных боёв.'
      : 'Значения только для этих матчей, поверх общих.'
  replaceSettingsFields(
    $('#balance-fields'),
    live,
    ...BALANCE_GROUPS.map((group) =>
      el(
        'div',
        { className: 'group' },
        el('h4', { textContent: group.title }),
        el(
          'div',
          { className: 'fields' },
          ...group.fields.map((f) => {
            const rule = rules[f.key],
              name = `b_${f.key}`,
              def = scopeDefault(f.key)
            defaults[f.key] = rule.type === 'bool' ? String(def) : String(def)
            if (rule.type === 'bool') {
              const value = values[f.key] ?? def
              const select = el(
                'select',
                { name },
                ...[
                  ['true', 'Да'],
                  ['false', 'Нет'],
                ].map(([v, text]) =>
                  el('option', {
                    value: v,
                    textContent: text,
                    selected: String(value) === v,
                  }),
                ),
              )
              // customSelect() must run after the select has a parent — it inserts its painted button as select's
              // next sibling, which is a no-op on a detached node (this select is field()'s child, not yet attached here).
              const wrapped = field(f.label, select, f.hint)
              customSelect(select)
              return wrapped
            }
            return numberField(
              f.label,
              name,
              rule.min!,
              rule.max!,
              rule.type === 'int' ? '1' : '0.1',
              Number(values[f.key] ?? def),
              f.unit,
              f.hint,
            )
          }),
        ),
      ),
    ),
  )
}

function collectBalance() {
  const form = $<HTMLFormElement>('#settings-form'),
    values: Record<string, number | boolean> = {}
  for (const key of Object.keys(rules)) {
    const raw = (form.elements.namedItem(`b_${key}`) as HTMLInputElement | null)?.value ?? ''
    if (raw !== '' && raw !== defaults[key])
      values[key] = rules[key].type === 'bool' ? raw === 'true' : Number(raw)
  }
  if (Object.keys(values).length) balance[scope] = values
  else delete balance[scope]
}

function renderScopes() {
  const known = new Set(BALANCE_SCOPES.map((s) => s.id))
  $('#scope').replaceChildren(
    ...BALANCE_SCOPES.map((s) =>
      el('option', {
        value: s.id,
        textContent: `${s.name}${balance[s.id] ? ' — есть изменения' : ''}`,
        selected: s.id === scope,
      }),
    ),
  )
  // Sections for campaigns the site does not know are kept as they are.
  for (const id of Object.keys(balance))
    if (!known.has(id))
      $('#scope').append(
        el('option', {
          value: id,
          textContent: 'Другая кампания — есть изменения',
          selected: id === scope,
        }),
      )
  customSelect($<HTMLSelectElement>('#scope'))
}

function syncParcool() {
  const on = $<HTMLInputElement>('#parcool-on').checked
  $('#parcool-list')
    .querySelectorAll<HTMLInputElement>('input')
    .forEach((i) => {
      i.disabled = !on
    })
}

let streakRows: StreakRow[] = []

let streakBase = ''

let streakError: string | null = null

let streakReset = false

let lastSettingsSnapshot: any = null

function streakBaseOf(entries: StreakEntry[]) {
  return JSON.stringify(rowsToEntries(entriesToRows(entries)))
}

function streakEditingActive() {
  return (
    streakSerialized() !== streakBase ||
    ($('#streak-table')?.contains(document.activeElement) ?? false)
  )
}

const streakLabels = new Map<string, string>()

let streakOptionsLoaded = false

function streakTableOf(settings: any): StreakEntry[] {
  try {
    return parseStreakEntries(settings?.deathmatch?.streakRewards ?? DEFAULT_STREAK_ENTRIES)
  } catch {
    return [...DEFAULT_STREAK_ENTRIES]
  }
}

function streakSerialized(): string | null {
  try {
    return JSON.stringify(rowsToEntries(streakRows))
  } catch {
    return null
  }
}

function streakStored() {
  return Array.isArray(lastSettingsSnapshot?.deathmatch?.streakRewards)
}

function readStreakForSave(): StreakEntry[] | null | undefined {
  const serialized = streakSerialized()
  if (serialized === null) return undefined
  if (streakReset && streakStored() && serialized === JSON.stringify(DEFAULT_STREAK_ENTRIES))
    return null
  return serialized !== streakBase ? (JSON.parse(serialized) as StreakEntry[]) : undefined
}

function itemLabel(id: string) {
  return streakLabels.get(id) ?? id
}

function resolveItemId(text: string): string | null {
  const trimmed = text.trim()
  if (streakOptionsLoaded) {
    for (const [id, label] of streakLabels) if (label === trimmed) return id
    return /^[a-z0-9_.-]+:[a-z0-9/._-]+$/.test(trimmed) ? trimmed : null
  }
  return trimmed || null
}

function refreshStreakPreview() {
  const serialized = streakSerialized()
  const line = $('#streak-preview')
  if (serialized === null) {
    line.textContent = ''
    return
  }
  const entries = JSON.parse(serialized) as StreakEntry[],
    period = streakPeriod(entries),
    unset = streakStored()
      ? ''
      : 'Не задана в админке: действует таблица из файла сервера, иначе по умолчанию. '
  if (!period) {
    line.textContent = `${unset}Таблица пуста: серия не даёт наград.`
    return
  }
  const cycle = streakCycle(entries, 2)
    .map((grant) => `${grant.kills}: ${itemLabel(grant.id)} ×${grant.count}`)
    .join('; ')
  line.textContent = `${unset}Период ${period}. Цикл 2: ${cycle}.`
}

function validateStreakDraft() {
  try {
    rowsToEntries(streakRows)
    streakError = null
  } catch (error) {
    streakError = (error as Error).message
  }
  const line = $('#streak-status')
  if (streakError) say(line, streakError, 'error')
  else if (line.dataset.s === 'error') line.textContent = ''
  refreshStreakPreview()
}

function updateStreakNote(settings: any, applied: any) {
  if (streakError) return
  const receipt = settingsReceipt(settings?.revision ?? 0, applied)
  const lines = Array.isArray(applied?.errors) ? applied.errors : []
  const rejected = lines.filter(
    (text: unknown) => typeof text === 'string' && text.includes('streakRewards'),
  )
  const line = $('#streak-status')
  if ((receipt === 'rejected' || receipt === 'partial') && rejected.length) {
    line.dataset.s = 'error'
    line.textContent = `Сервер отклонил таблицу: ${rejected[0]}`
  } else if (line.dataset.s === 'error') line.textContent = ''
}

function renderStreakTable() {
  const table = $('#streak-table')
  table.replaceChildren(
    ...streakRows.map((row, index) =>
      el(
        'div',
        { className: 'streak-row' },
        el(
          'div',
          { className: 'streak-head' },
          el(
            'label',
            {},
            'Убийств ',
            el('input', {
              type: 'number',
              min: 1,
              max: 2147483647,
              step: 1,
              value: row.kills,
              'aria-label': 'Убийств',
              onchange: (e: Event) => {
                const value = Number((e.target as HTMLInputElement).value)
                streakRows[index] = { ...streakRows[index], kills: value }
                validateStreakDraft()
              },
            }),
          ),
          el('span', { className: 'spacer' }),
          el('button', {
            type: 'button',
            textContent: 'Убрать порог',
            onclick: () => {
              streakRows = streakRows.filter((_, i) => i !== index)
              renderStreakTable()
              void commitStreak()
            },
          }),
        ),
        el(
          'div',
          { className: 'streak-item streak-cols', 'aria-hidden': 'true' },
          el('span', { className: 'muted', textContent: 'Предмет' }),
          el('span', { className: 'muted', textContent: 'Кол-во' }),
          el('span', { className: 'muted', textContent: 'Умножать по циклам' }),
          el('span'),
        ),
        ...row.items.map((item, itemIndex) =>
          el(
            'div',
            { className: 'streak-item' },
            el('input', {
              value: itemLabel(item.id),
              'aria-label': 'Предмет',
              placeholder: 'пространство:предмет',
              autocomplete: 'off',
              ...(streakOptionsLoaded ? {} : { title: 'ID предмета из реестра игры' }),
              oninput: (e: Event) => {
                const input = e.target as HTMLInputElement,
                  id = resolveItemId(input.value) ?? input.value.trim()
                streakRows[index].items[itemIndex] = {
                  ...streakRows[index].items[itemIndex],
                  id,
                }
                validateStreakDraft()
              },
            }),
            el('input', {
              type: 'number',
              min: 1,
              max: 2147483647,
              step: 1,
              value: item.count,
              'aria-label': 'Кол-во',
              onchange: (e: Event) => {
                streakRows[index].items[itemIndex] = {
                  ...streakRows[index].items[itemIndex],
                  count: Number((e.target as HTMLInputElement).value),
                }
                validateStreakDraft()
              },
            }),
            el(
              'label',
              { className: 'check' },
              el('input', {
                type: 'checkbox',
                checked: item.scale,
                'aria-label': 'Умножать по циклам',
                onchange: (e: Event) => {
                  streakRows[index].items[itemIndex] = {
                    ...streakRows[index].items[itemIndex],
                    scale: (e.target as HTMLInputElement).checked,
                  }
                  validateStreakDraft()
                },
              }),
              'Умножать по циклам',
            ),
            el('button', {
              type: 'button',
              textContent: 'Убрать',
              onclick: () => {
                streakRows[index] = {
                  ...streakRows[index],
                  items: streakRows[index].items.filter((_, i) => i !== itemIndex),
                }
                renderStreakTable()
                void commitStreak()
              },
            }),
          ),
        ),
        el(
          'div',
          { className: 'streak-actions' },
          el('button', {
            type: 'button',
            textContent: '+ Предмет',
            onclick: () => {
              streakRows[index] = {
                ...streakRows[index],
                items: [...streakRows[index].items, { id: '', count: 1, scale: true }],
              }
              renderStreakTable()
              validateStreakDraft()
            },
          }),
        ),
      ),
    ),
    el(
      'div',
      { className: 'streak-actions' },
      el('button', {
        type: 'button',
        textContent: '+ Порог',
        onclick: () => {
          const kills = streakRows.length ? Math.max(...streakRows.map((row) => row.kills)) + 1 : 2
          streakRows = [...streakRows, { kills, items: [] }]
          renderStreakTable()
          validateStreakDraft()
        },
      }),
      el('button', {
        type: 'button',
        textContent: 'По умолчанию',
        onclick: () => {
          streakRows = entriesToRows([...DEFAULT_STREAK_ENTRIES])
          streakReset = true
          renderStreakTable()
          void commitStreak()
        },
      }),
    ),
  )
  // The extracted-script test harness may stub customCombo away: plain inputs stay usable.
  if (streakOptionsLoaded && typeof customCombo === 'function')
    for (const input of table.querySelectorAll<HTMLInputElement>('input[aria-label="Предмет"]'))
      customCombo(input, [...streakLabels.values()])
  validateStreakDraft()
}

function attachStreakCombos() {
  if (typeof customCombo !== 'function') return
  for (const input of $('#streak-table').querySelectorAll<HTMLInputElement>(
    'input[aria-label="Предмет"]',
  )) {
    customCombo(input, [...streakLabels.values()])
    if (document.activeElement !== input) {
      const known = streakLabels.get(input.value.trim())
      if (known) input.value = known
    }
  }
}

async function loadStreakItemOptions() {
  if (streakOptionsLoaded) return
  streakOptionsLoaded = true
  try {
    const { catalog } = await api('kits')
    for (const group of ['items', 'guns', 'ammos', 'throwables', 'attachments'] as const) {
      for (const entry of catalog?.[group] ?? [])
        if (entry?.id && !streakLabels.has(entry.id))
          streakLabels.set(
            entry.id,
            entry.name && entry.name !== entry.id && !entry.name.endsWith('.name')
              ? `${entry.name} · ${entry.id}`
              : entry.id,
          )
    }
    if (streakEditingActive()) attachStreakCombos()
    else {
      streakRows = entriesToRows(streakTableOf(lastSettingsSnapshot))
      renderStreakTable()
      attachStreakCombos()
    }
  } catch {
    // Free text with format validation stays: the server checks membership.
  }
}

async function commitStreak() {
  const line = $('#streak-status')
  let entries: StreakEntry[]
  try {
    entries = rowsToEntries(streakRows)
  } catch (error) {
    streakError = (error as Error).message
    say(line, streakError, 'error')
    return
  }
  const removing = streakReset && streakStored()
  if (!removing && JSON.stringify(entries) === streakBase) return
  streakError = null
  say(line, 'сохраняем…', 'pending')
  try {
    const body = collectSettingsBody(settingsRevision)
    const result = await api('settings', 'PUT', body)
    settingsRevision = Math.max(settingsRevision, result.settings.revision)
    gunRevision = settingsRevision
    streakBase = streakBaseOf(streakTableOf(result.settings))
    streakReset = false
    await loadSettings(0, true, result)
    settingsMeta()
    refreshStreakPreview()
    say(line, 'сохранено', 'ok')
  } catch (error) {
    if ((error as { status?: number }).status === 409) {
      try {
        const fresh = await api('settings')
        settingsRevision = Math.max(settingsRevision, fresh.settings?.revision ?? 0)
        // Drop the conflicted draft: kept dirty, any later unrelated save would silently overwrite the other admin's table.
        const freshTable = streakTableOf(fresh.settings)
        streakBase = streakBaseOf(freshTable)
        streakRows = entriesToRows(freshTable)
        streakReset = false
        await loadSettings(0, true, { settings: fresh.settings, applied: fresh.applied })
      } catch {
        // Fresh state unreadable: still drop the draft (back to the last known table) so no later save resends it.
        streakRows = entriesToRows(JSON.parse(streakBase || '[]') as StreakEntry[])
        streakReset = false
        renderStreakTable()
        if (streakOptionsLoaded) attachStreakCombos()
        say(line, 'Настройки уже изменил кто-то другой. Обновите страницу.', 'error')
        return
      }
      say(
        line,
        'Таблицу уже изменил кто-то другой: показана текущая версия, повторите правки.',
        'error',
      )
    } else say(line, (error as Error).message, 'error')
  }
}

async function loadSettings(waitStarted = 0, statusOnly = false, data?: any) {
  const {
    settings,
    applied: incomingApplied,
    balance: balanceRules,
    cpRevisions: incomingCpRevisions,
  } = data ?? (await api('settings'))
  if ((settings.revision ?? 0) < observedSettingsRevision) return
  remoteSettingsName =
    (typeof settings.updatedBy === 'string' ? settings.updatedBy : settings.updatedBy?.name) ??
    'кто-то'
  gunOverrides = structuredClone(settings.gunBalance ?? {})
  if (selectedGun) renderGun(true)
  if (incomingApplied !== undefined) lastApplied = incomingApplied
  const applied = lastApplied
  if (balanceRules) rules = balanceRules
  settingsRevision = Math.max(settingsRevision, settings.revision ?? 0)
  gunRevision = settingsRevision
  if (incomingCpRevisions && typeof settingsCpRevisions !== 'undefined')
    settingsCpRevisions = incomingCpRevisions
  if (!statusOnly) {
    const form = $<HTMLFormElement>('#settings-form')
    defaults = Object.fromEntries(
      [...LOBBY, ...ROOMS, ...DEATHMATCH].map((f) => [f.key, String(f.def)]),
    )
    defaults.pvpEnabled = 'true'
    const pvp = form.elements.namedItem('pvpEnabled') as HTMLSelectElement
    const pvpValue = String(settings.lobby?.pvpEnabled ?? true)
    const pvpChanged =
      data && settingValues.has(controlKey(pvp)) && settingValues.get(controlKey(pvp)) !== pvpValue
    if (!data || !editingSetting(pvp)) pvp.value = pvpValue
    settingValues.set(controlKey(pvp), pvpValue)
    if (pvpChanged) flashSetting(pvp.closest('.field')!)
    customSelect(pvp)
    hadLocks = Array.isArray(settings.classLocks)
    replaceSettingsFields(
      $('#lobby-fields'),
      Boolean(data),
      ...LOBBY.map((f) =>
        numberField(f.label, f.key, f.min, f.max, '1', settings.lobby?.[f.key] ?? f.def, f.unit),
      ),
    )
    replaceSettingsFields(
      $('#room-fields'),
      Boolean(data),
      ...ROOMS.map((f) =>
        numberField(f.label, f.key, f.min, f.max, '1', settings.rooms?.[f.key] ?? f.def, f.unit),
      ),
    )
    replaceSettingsFields(
      $('#deathmatch-fields'),
      Boolean(data),
      ...DEATHMATCH.map((f) =>
        numberField(
          f.label,
          f.key,
          f.min,
          f.max,
          '1',
          settings.deathmatch?.[f.key] ?? f.def,
          f.unit,
        ),
      ),
    )
    {
      lastSettingsSnapshot = settings
      const incoming = streakTableOf(settings)
      // Dirty check before moving the base, ignoring focus: a clean draft must adopt another admin's table, not resend the stale one.
      const wasEditing = streakSerialized() !== streakBase
      streakBase = streakBaseOf(incoming)
      if (!data || !wasEditing) {
        streakRows = entriesToRows(incoming)
        renderStreakTable()
        if (streakOptionsLoaded) attachStreakCombos()
        else void loadStreakItemOptions()
      }
      updateStreakNote(settings, applied)
    }
    replaceSettingsFields(
      $('#class-costs'),
      Boolean(data),
      ...Object.entries(CLASS_COSTS).map(([id, price]) => {
        const item = numberField(
          CLASS_NAMES[id],
          `cost_${id}`,
          0,
          10000,
          '1',
          settings.classCosts?.[id] ?? price,
          'БК',
        )
        item.querySelector('input')!.required = true
        return item
      }),
    )
    const locks: string[] = settings.classLocks ?? []
    extraLocks = locks.filter((id) => !Object.hasOwn(CLASS_NAMES, id))
    replaceSettingsFields(
      $('#class-list'),
      Boolean(data),
      ...Object.entries(CLASS_NAMES).map(([id, name]) =>
        el(
          'label',
          { className: 'check' },
          el('input', {
            type: 'checkbox',
            name: 'class',
            value: id,
            checked: !locks.includes(id),
          }),
          name,
        ),
      ),
    )
    const parcoolOn = $<HTMLInputElement>('#parcool-on')
    if (!data || !editingSetting(parcoolOn)) parcoolOn.checked = settings.parcool !== undefined
    settingValues.set(controlKey(parcoolOn), String(settings.parcool !== undefined))
    // Effective value while off: the server's base file, shown but disabled — this is not what will be saved.
    const parcoolChecked = new Set(settings.parcool?.allowedActions ?? PARCOOL_FILE_DEFAULT)
    replaceSettingsFields(
      $('#parcool-list'),
      Boolean(data),
      ...PARCOOL_ACTIONS.map(({ id, label, hint }) =>
        el(
          'label',
          { className: 'check', ...(hint ? { title: hint } : {}) },
          el('input', {
            type: 'checkbox',
            name: 'parcool',
            value: id,
            checked: parcoolChecked.has(id),
            disabled: !parcoolOn.checked,
          }),
          el('span', {}, label),
        ),
      ),
    )
    balance = structuredClone(settings.campaignBalance ?? {})
    if (!document.activeElement?.closest('#balance-fields, #scope')) renderScopes()
    renderBalance(Boolean(data), settings.campaignBalance ?? {})
    settingsLoaded = true
    settingsMeta()
    if (!data) rememberSettingsControls()
  }

  observedSettingsRevision = settings.revision ?? 0
  lastSettingsSnapshot = settings
  updateStreakNote(settings, applied)
  const editor =
    typeof settings.updatedBy === 'string' ? settings.updatedBy : settings.updatedBy?.name
  const who = editor ? ` · ${editor} · ${ago(settings.updatedAt)}` : ''
  $('#settings-applied-by').textContent = editor ?? ''
  const receipt = settingsReceipt(settings.revision ?? 0, applied)
  if (!settings.revision) settingsStatus('Значения по умолчанию', 'ok', '')
  else if (receipt === 'rejected' || receipt === 'partial')
    settingsStatus(`отклонено${who}`, 'error', 'отклонено')
  else if (receipt === 'applied') settingsStatus(`применено${who}`, 'ok', 'применено')
  else if (waitStarted && Date.now() - waitStarted > 60_000)
    settingsStatus(`применяем…${who}`, 'pending', 'применяем…')
  else {
    settingsStatus(`применяем…${who}`, 'pending', 'применяем…')
  }
}

function settingsStatus(text: string, tone: 'ok' | 'error' | 'pending', short: string) {
  say($('#settings-state'), text, tone)
  const line = $('#settings-form .savebar .form-status')
  if (short) say(line, text, tone)
  else line.textContent = ''
}

let settingsLoaded = false

let lastApplied: any = null

function collectSettingsBody(revision: number) {
  collectBalance()
  const form = $<HTMLFormElement>('#settings-form'),
    value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value
  return settingsBody(
    revision,
    {
      pvpEnabled: value('pvpEnabled'),
      classCosts: Object.fromEntries(
        Object.keys(CLASS_COSTS).map((id) => [id, value(`cost_${id}`)]),
      ),
      lobby: Object.fromEntries(LOBBY.map((f) => [f.key, value(f.key)])),
      rooms: Object.fromEntries(ROOMS.map((f) => [f.key, value(f.key)])),
      deathmatch: Object.fromEntries(DEATHMATCH.map((f) => [f.key, value(f.key)])),
      streakRewards: readStreakForSave(),
      lockedClasses: [
        ...[...form.querySelectorAll<HTMLInputElement>('input[name=class]')]
          .filter((c) => !c.checked)
          .map((c) => c.value),
        ...extraLocks,
      ],
      hadLocks,
      balance,
      parcool: {
        active: $<HTMLInputElement>('#parcool-on').checked,
        actions: [...form.querySelectorAll<HTMLInputElement>('input[name=parcool]:checked')].map(
          (c) => c.value,
        ),
      },
    },
    defaults,
    typeof settingsCpRevisions !== 'undefined' ? settingsCpRevisions : {},
  )
}

function settingsMeta() {
  $('#settings-meta').textContent = `ревизия ${settingsRevision}`
}

const busyControls = new WeakSet<HTMLElement>()

const stateTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

function fieldState(line: HTMLElement, text: string, state: string) {
  clearTimeout(stateTimers.get(line))
  line.setAttribute('role', 'status')
  line.dataset.s = state
  line.textContent = text
  if (state === 'saved')
    stateTimers.set(
      line,
      setTimeout(() => {
        line.textContent = ''
      }, 2500),
    )
}

function setControl(control: SettingControl, value: string) {
  if (control.type === 'checkbox') (control as HTMLInputElement).checked = value === 'true'
  else {
    control.value = value
    if (control instanceof HTMLSelectElement) customSelect(control)
  }
  if (control.id === 'parcool-on') syncParcool()
}

function autosaveError(error: unknown) {
  if ((error as Error & { status?: number }).status === 403)
    return 'Недостаточно прав. Попросите администратора.'
  return (error as Error & { status?: number }).status
    ? 'Сервер не принял значение. Попробуйте ещё раз'
    : (error as Error).message
}

function lockControl(
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement,
) {
  busyControls.add(control)
  const disabled = control.disabled
  const readonly = 'readOnly' in control ? control.readOnly : false
  const target =
    control instanceof HTMLSelectElement
      ? (control.nextElementSibling?.querySelector<HTMLButtonElement>('.cselect-btn') ?? control)
      : control
  target.setAttribute('aria-disabled', 'true')
  const block = (e: Event) => {
    if (e instanceof KeyboardEvent && ['Tab', 'Escape'].includes(e.key)) return
    e.preventDefault()
    e.stopImmediatePropagation()
  }
  target.addEventListener('click', block, true)
  target.addEventListener('keydown', block, true)
  if (document.activeElement !== target) control.disabled = true
  else if ('readOnly' in control) control.readOnly = true
  if (control instanceof HTMLSelectElement) customSelect(control)
  return () => {
    busyControls.delete(control)
    control.disabled = disabled
    target.removeAttribute('aria-disabled')
    target.removeEventListener('click', block, true)
    target.removeEventListener('keydown', block, true)
    if ('readOnly' in control) control.readOnly = readonly
    if (control instanceof HTMLSelectElement) customSelect(control)
  }
}

function validation(control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  if (control instanceof HTMLInputElement && control.type === 'number' && !control.validity.valid)
    return `от ${control.min} до ${control.max}`
  return control.required && !control.value.trim() ? 'Введите значение' : ''
}

function changeToast(
  label: string,
  old: string,
  value: string,
  checkbox: boolean,
  undo: () => void,
) {
  const node = el(
    'div',
    { className: 'toast' },
    el('span', {
      textContent: `${label}: ${checkbox ? (value === 'true' ? 'включён' : 'выключен') : `${old} → ${value}`}`,
    }),
    el('button', {
      type: 'button',
      textContent: 'Отменить',
      onclick: () => {
        node.remove()
        undo()
      },
    }),
  )
  $('.toasts').append(node)
  setTimeout(() => node.remove(), 5000)
}

let settingsQueue = Promise.resolve()

let settingsQueueVersion = 0

const queuedSettings = new Map<string, number>()

function commitSetting(control: SettingControl, undoValue?: string) {
  if (control.id === 'scope') return
  const row = control.closest('.field') ?? control.closest('.group')!.querySelector('header')!
  const line = row.querySelector<HTMLElement>('.state')!
  const invalid = validation(control)
  if (invalid) {
    fieldState(line, invalid, 'error')
    return
  }
  const key = controlKey(control),
    value = controlValue(control),
    savedScope = scope,
    savedDefault = defaults[control.name.slice(2)]
  const savedValue = () =>
    control.name.startsWith('b_')
      ? String(
          balance[savedScope]?.[control.name.slice(2)] ??
            scopeDefault(control.name.slice(2), savedScope),
        )
      : settingValues.get(key)
  if (value === settingValues.get(key) && !queuedSettings.has(key)) return
  const queueVersion = settingsQueueVersion
  queuedSettings.set(key, (queuedSettings.get(key) ?? 0) + 1)
  const actions =
    control.id === 'parcool-on'
      ? [...$('#parcool-list').querySelectorAll<HTMLInputElement>('input')].map((c) => ({
          control: c,
          checked: c.checked,
          saved: settingValues.get(controlKey(c)) === 'true',
        }))
      : []
  const label =
    control.closest('.check')?.textContent?.trim() ??
    row.querySelector('label')?.firstChild?.textContent?.trim() ??
    SETTING_LABELS[control.name] ??
    'Значение'
  settingsQueue = settingsQueue.then(async () => {
    if (queueVersion !== settingsQueueVersion) {
      const remaining = queuedSettings.get(key)! - 1
      if (remaining) queuedSettings.set(key, remaining)
      else queuedSettings.delete(key)
      return
    }
    const old = settingValues.get(key) ?? ''
    fieldState(line, 'сохраняем…', 'saving')
    const release = lockControl(control)
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (undoValue !== undefined && savedValue() !== undoValue) {
          toast(`${label}: значение уже изменил ${remoteSettingsName}`)
          setControl(control, settingValues.get(key) ?? old)
          return
        }
        // Only this committed value enters the full replacement; other edits stay in their controls.
        const controls = [...$('#settings-form').querySelectorAll<SettingControl>('input, select')]
        const visible = controls.map((c) => controlValue(c))
        const visibleScope = scope
        const storedBalance = structuredClone(balance)
        controls.forEach((c) => {
          const saved = settingValues.get(controlKey(c))
          if (saved !== undefined) setControl(c, saved)
        })
        if (control.name.startsWith('b_') && savedScope !== visibleScope) {
          const balanceKey = control.name.slice(2)
          const values = (balance[savedScope] ??= {})
          if (value === savedDefault) delete values[balanceKey]
          else
            values[balanceKey] =
              rules[balanceKey].type === 'bool' ? value === 'true' : Number(value)
        } else setControl(control, value)
        actions.forEach(({ control, checked }) => {
          control.checked = checked
        })
        let body: ReturnType<typeof collectSettingsBody>
        try {
          body = collectSettingsBody(settingsRevision)
        } finally {
          controls.forEach((c, i) => setControl(c, visible[i]))
          balance = storedBalance
          scope = visibleScope
        }
        try {
          const result = await api('settings', 'PUT', body)
          settingsRevision = Math.max(settingsRevision, result.settings.revision)
          gunRevision = settingsRevision
          if (result.settings.revision >= observedSettingsRevision) {
            balance = structuredClone(result.settings.campaignBalance ?? {})
            settingValues.set(key, value)
            actions.forEach(({ control, checked }) => {
              settingValues.set(
                controlKey(control),
                String(value === 'true' ? checked : PARCOOL_FILE_DEFAULT.includes(control.value)),
              )
            })
          }
          await loadSettings(0, true, result)
          settingsMeta()
          fieldState(line, 'сохранено', 'saved')
          changeToast(label, old, value, control.type === 'checkbox', () => {
            if (savedValue() !== value) {
              toast(`${label}: значение уже изменил ${remoteSettingsName}`)
              return
            }
            const current = [
              ...$('#settings-form').querySelectorAll<SettingControl>('input, select'),
            ].find((c) => controlKey(c) === key)
            if (control.name.startsWith('b_') && scope !== savedScope) {
              scope = savedScope
              renderScopes()
              renderBalance()
              rememberSettingsControls('#balance-fields')
            }
            const target = control.name.startsWith('b_')
              ? $<SettingControl>(`[name="${control.name}"]`)
              : current
            if (target) {
              actions.forEach(({ control, saved }) => {
                const current = $<HTMLInputElement>(`#parcool-list input[value="${control.value}"]`)
                if (current) current.checked = saved
              })
              setControl(target, old)
              commitSetting(target, value)
              if (target instanceof HTMLSelectElement)
                document.getElementById(`${target.id}-btn`)?.focus()
              else target.focus()
            }
          })
          break
        } catch (error) {
          if (attempt || (error as Error & { status?: number }).status !== 409) throw error
          await loadSettings(0, false, await api('settings'))
        }
      }
    } catch (error) {
      if ((error as Error & { status?: number }).status === 403) settingsQueueVersion++
      setControl(control, settingValues.get(key) ?? old)
      fieldState(line, autosaveError(error), 'error')
    } finally {
      release()
      const remaining = queuedSettings.get(key)! - 1
      if (remaining) queuedSettings.set(key, remaining)
      else queuedSettings.delete(key)
    }
  })
}

function autosaveKeys(form: HTMLFormElement) {
  form.addEventListener('submit', (e) => e.preventDefault())
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'number') {
      e.preventDefault()
      e.target.blur()
    }
  })
}

type SettingControl = HTMLInputElement | HTMLSelectElement

const settingValues = new Map<string, string>()

let remoteSettingsName = 'кто-то'

let observedSettingsRevision = 0

function controlKey(control: SettingControl) {
  return `${control.name || control.id}:${control.type === 'checkbox' ? control.value : ''}${control.name.startsWith('b_') ? ':' + scope : ''}`
}

function controlValue(control: SettingControl) {
  return control.type === 'checkbox' ? String((control as HTMLInputElement).checked) : control.value
}

function editingSetting(control: SettingControl) {
  return (
    busyControls.has(control) ||
    queuedSettings.has(controlKey(control)) ||
    control.closest('.field, .check')?.contains(document.activeElement) ||
    controlValue(control) !== settingValues.get(controlKey(control))
  )
}

function rememberSettingsControls(selector = '#settings-form') {
  $(selector)
    .querySelectorAll<SettingControl>('input, select')
    .forEach((control) => {
      settingValues.set(controlKey(control), controlValue(control))
    })
}

function flashSetting(row: Element) {
  row.classList.remove('flash')
  void (row as HTMLElement).offsetWidth
  row.classList.add('flash')
  const stateRow = row.matches('.check')
    ? (row.closest('.group')?.querySelector('header') ?? row)
    : row
  const state =
    stateRow.querySelector<HTMLElement>('.state') ??
    stateRow.appendChild(el('span', { className: 'state', role: 'status' }))
  if (![...row.querySelectorAll<HTMLElement>('input, select')].some((c) => busyControls.has(c))) {
    state.dataset.s = 'other'
    state.textContent = `${remoteSettingsName} · только что`
  }
  setTimeout(() => row.classList.remove('flash'), 1600)
}

function replaceSettingsFields(container: HTMLElement, live: boolean, ...rows: Element[]) {
  if (!live) {
    container.replaceChildren(...rows)
    return
  }
  rows.forEach((fresh, index) => {
    const old = container.children[index]
    if (!old) {
      container.append(fresh)
      return
    }
    const oldFields = old.querySelector<HTMLElement>('.fields')
    const freshFields = fresh.querySelector<HTMLElement>('.fields')
    if (oldFields && freshFields) {
      replaceSettingsFields(oldFields, true, ...freshFields.children)
      return
    }
    const controls = [...old.querySelectorAll<SettingControl>('input, select')]
    const changed = [...fresh.querySelectorAll<SettingControl>('input, select')].some(
      (control) =>
        settingValues.has(controlKey(control)) &&
        settingValues.get(controlKey(control)) !== controlValue(control),
    )
    const preserve = controls.some(editingSetting) || old.contains(document.activeElement)
    if (!preserve && changed) old.replaceWith(fresh)
    fresh
      .querySelectorAll<SettingControl>('input, select')
      .forEach((control) => settingValues.set(controlKey(control), controlValue(control)))
    if (changed) flashSetting(preserve ? old : fresh)
  })
}

async function settingsEvent(data: any) {
  for (const finish of mapAvailabilityWaiters) finish(data)
  if ((data.settings.revision ?? 0) < observedSettingsRevision) return
  const changed = settingsLoaded && data.settings.revision !== observedSettingsRevision
  remoteSettingsName =
    (typeof data.settings.updatedBy === 'string'
      ? data.settings.updatedBy
      : data.settings.updatedBy?.name) ?? 'кто-то'
  await loadSettings(0, false, data)
  if (changed && remoteSettingsName !== me.name) toast(`${remoteSettingsName}: настройки обновлены`)
  if (data.gunBalance) await loadGunBalance()
  if (data.kits) await loadKits(true)
  if (kitCatalog) {
    const receipt = settingsReceipt(kitRevision, data.applied)
    if (receipt === 'applied')
      say($('#kits-status'), 'Наборы применены. Новые выдачи используют эти настройки.')
    else if (receipt === 'rejected' || receipt === 'partial')
      say(
        $('#kits-status'),
        'Сервер отклонил настройки наборов. Прежняя выдача сохранена.',
        'error',
      )
    if (data.settings.revision > kitRevision) await loadKits(true)
  }
}

function initAdminSettings(): void {
  $<HTMLInputElement>('#gun-search').oninput = () => {
    try {
      filterGuns()
    } catch (error) {
      say($('#gun-balance-status'), (error as Error).message, 'error')
    }
  }

  $<HTMLSelectElement>('#gun-select').onchange = (event) => {
    try {
      selectedGun = gunCatalog?.guns.find(
        (gun) => gun.id === (event.target as HTMLSelectElement).value,
      )
      renderGun()
    } catch (error) {
      say($('#gun-balance-status'), (error as Error).message, 'error')
      if (selectedGun) $<HTMLSelectElement>('#gun-select').value = selectedGun.id
    }
  }

  $('#gun-reset').onclick = async () => {
    const gun = selectedGun
    if (
      !gun ||
      !(await ask({
        title: 'Вернуть этому оружию значения ганпака?',
        text: '',
        ok: 'Вернуть',
        danger: true,
      }))
    )
      return
    void commitGun(
      $<HTMLButtonElement>('#gun-reset'),
      $('#gun-balance-status'),
      gun.id,
      null,
      undefined,
      renderGun,
      () => {},
      'Баланс оружия',
    )
  }

  for (const event of ['input', 'change', 'click'])
    $('#kits-form').addEventListener(
      event,
      (event) => {
        kitEditingControl = event.target as HTMLElement
      },
      true,
    )

  $('#kit-select').onchange = () => {
    selectedKit = $<HTMLSelectElement>('#kit-select').value
    renderKits()
  }

  $('#kit-new').onclick = async () => {
    if (!kitCatalog) return
    const form = await ask({
      title: 'Создать набор?',
      text: 'Новый набор начнётся с пустого варианта. Добавьте предметы и выберите режимы до сохранения.',
      ok: 'Создать',
      fields: [
        field(
          'ID набора',
          el('input', {
            name: 'id',
            required: true,
            maxLength: 32,
            pattern: kitCatalog.fields.idPattern,
          }),
        ),
        field('Название', el('input', { name: 'name', required: true, maxLength: 80 })),
      ],
    })
    if (!form) return
    const id = String(form.get('id'))
    if (Object.hasOwn(effectiveKits(kitCatalog, kitOverrides, kitClassCosts), id)) {
      say($('#kits-status'), 'Набор с таким ID уже существует.', 'error')
      return
    }
    kitOverrides[id] = {
      id,
      name: String(form.get('name')),
      allowedModeIds: [],
      deploymentCost: 0,
      playerLimit: 999,
      knifeSlot: 2,
      variants: [{ id: 'default', name: 'Основной', items: [] }],
    }
    selectedKit = id
    renderKits()
    $('#kit-fields input')?.scrollIntoView({ block: 'nearest' })
  }

  $('#kit-reset').onclick = async () => {
    if (!kitCatalog || !selectedKit) return
    const standard = kitCatalog.kits.find((kit) => kit.id === selectedKit)?.defaults
    if (
      !(await ask({
        title: standard ? 'Вернуть стандартный набор?' : 'Удалить пользовательский набор?',
        text: 'Следующие выдачи вернутся к стандарту. Если режим использует этот набор, сначала выберите для него другой.',
        ok: standard ? 'Вернуть стандарт' : 'Удалить',
        danger: true,
      }))
    )
      return
    const control = $('#kit-reset'),
      before = kitOverrides[selectedKit]
    delete kitOverrides[selectedKit]
    kitEditingControl = control
    rememberKitChange(before, undefined, ['kits', selectedKit])
    renderKits()
    scheduleKitSave(control)
  }

  $('#kits-refresh').onclick = async () => {
    if (
      kitBody() !== kitSnapshot &&
      !(await ask({
        title: 'Обновить каталог?',
        text: 'Несохранённые изменения наборов и назначений будут заменены настройками сервера.',
        ok: 'Обновить',
        danger: true,
      }))
    )
      return
    run($('#kits-status'), loadKits, $('#kits-form'))
  }

  $<HTMLFormElement>('#kits-form').onsubmit = (event) => {
    event.preventDefault()
    void commitKits()
  }

  $('#kits-form').addEventListener(
    'change',
    (event) => void commitKits(undefined, event.target as HTMLElement),
  )

  $('#kits-form').addEventListener('focusout', (event) => {
    if (kitBody() !== kitDraftSnapshot) void commitKits(undefined, event.target as HTMLElement)
  })

  $('#scope').addEventListener('change', (e) => {
    scope = (e.target as HTMLSelectElement).value
    renderScopes()
    renderBalance()
    rememberSettingsControls('#balance-fields')
  })

  $('#parcool-on').addEventListener('change', syncParcool)

  autosaveKeys($<HTMLFormElement>('#settings-form'))

  autosaveKeys($<HTMLFormElement>('#gun-balance-form'))

  $('#settings-form').addEventListener('change', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) {
      if ((e.target as HTMLElement).closest('#streak-table')) commitStreak()
      else commitSetting(e.target)
    }
  })
}

export {
  initAdminSettings,
  loadSettings,
  loadGunBalance,
  loadKits,
  settingsEvent,
  changeToast,
  mapAvailabilityWaiters,
  lastApplied,
  settingsLoaded,
  observedSettingsRevision,
  remoteSettingsName,
  kitCatalog,
  kitRevision,
}
