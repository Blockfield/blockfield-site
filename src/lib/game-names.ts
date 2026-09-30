/**
 * Display names for game ids. The site has no access to the game config at runtime, so this mirrors
 * blockfield-server/server/lobby/blockfield/{classes,campaigns,maps,modes}/*.json.
 * ponytail: a hand-kept copy; unknown ids fall back to a neutral label, add rows when the modpack adds content.
 */
export const CLASS_NAMES: Record<string, string> = {
  assault: 'Штурмовик',
  mark: 'Марксман',
  sniper: 'Снайпер',
  tech: 'Инженер',
  drone: 'Оператор FPV',
}
export const CLASS_COSTS: Record<string, number> = { tech: 600, sniper: 800, drone: 1200 }
export const KIT_GUNS = new Set([
  'elitex:ak47',
  'elitex:akx105',
  'elitex:benelli_super',
  'elitex:m4_sopmod',
  'elitex:ro635v3',
  'tacz:ai_awp',
  'tacz:deagle',
  'tacz:glock_17',
  'tacz:hk416d',
  'tacz:m249',
  'tacz:m700',
  'tacz:sks_tactical',
  'tacz:spr15hb',
])
/** Where workshop access applies: the hub plus every map (the mod's scope ids, the controller's MAP_IDS). */
export const WORKSHOP_HUB = 'hub'
export const MAP_NAMES: Record<string, string> = {
  baxmut: 'Бахмут',
  berdichev: 'Бердичев',
  dm_arena: 'Арена',
  fields: 'Степи Донбасса',
  firing_range: 'Полигон',
  konstaxa: 'Константиновка',
  kozyatyn: 'Казатин',
  zaliznichne: 'Железнодорожное',
  snipers_towers: 'Вышки',
  dust2: 'Dust II',
  train: 'Train',
  mirage: 'Mirage',
  inferno: 'Inferno',
  overpass: 'Overpass',
  ancient: 'Ancient',
  anubis: 'Anubis',
  nuke: 'Nuke',
  vertigo: 'Vertigo',
}
export const MODE_NAMES: Record<string, string> = {
  campaign: 'Ranked-кампания',
  room: 'Обычный бой',
  deathmatch: 'Каждый сам за себя',
}
export const TEAM_NAMES: Record<string, string> = { RED: 'красных', BLUE: 'синих' }

/** Balance scopes of settings.json `campaignBalance`: "*" for all, campaign ids, "room" for Casual rooms. */
export const BALANCE_SCOPES: { id: string; name: string }[] = [
  { id: '*', name: 'Все матчи' },
  { id: 'Center', name: 'Кампания Центр' },
  { id: 'South', name: 'Кампания Юг' },
  { id: 'room', name: 'Обычные бои' },
]
const FILE_BALANCE = {
  max_tickets: 500,
  ticket_bleed_multiplier: 2,
  ticket_bleed_timer_seconds: 5,
  death_ticket_cost: 5,
  capture_speed_percent_per_tick: 2,
  uncapture_speed_percent_per_tick: 3,
  score_per_kill: 15,
  score_per_obj_sec: 0.5,
  score_per_capture: 50,
  score_per_uncapture: 25,
  preparation_time_seconds: 60,
  transition_time_seconds: 10,
  enable_spawn_shield: true,
  spawn_shield_duration_seconds: 5,
  safe_spawn_threshold: 90,
  base_warn_radius: 100,
  base_kill_radius: 80,
  max_players_per_team: 16,
  base_spawn_time_seconds: 10,
  spawn_time_per_point_seconds: 5,
  shuffle_teams_between_rounds: false,
  min_players_per_team: 1,
  ready_countdown_seconds: 15,
  reserve_seconds: 180,
  ready_timeout_seconds: 120,
} as Record<string, number | boolean>
/**
 * Values from the game's own files, shown as "по умолчанию". Keys no file sets use CampaignConfig's code defaults
 * (min_players_per_team 1, ready_countdown_seconds 15, reserve_seconds 180, ready_timeout_seconds 120).
 */
export const BALANCE_DEFAULTS: Record<string, Record<string, number | boolean>> = {
  Center: FILE_BALANCE,
  South: { ...FILE_BALANCE, max_tickets: 100 },
  room: FILE_BALANCE,
}

export type Field = { key: string; label: string; unit?: string; hint?: string }
/** Balance keys grouped by meaning; every key of BALANCE in admin.ts appears exactly once. */
export const BALANCE_GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Тикеты и победа',
    fields: [
      {
        key: 'max_tickets',
        label: 'Тикеты команды на старте',
        hint: 'Команда проигрывает, когда тикеты кончаются.',
      },
      { key: 'death_ticket_cost', label: 'Тикеты за одну смерть' },
      {
        key: 'ticket_bleed_multiplier',
        label: 'Потеря тикетов за перевес по точкам',
        hint: 'За каждую точку, которой у врага больше.',
      },
      {
        key: 'ticket_bleed_timer_seconds',
        label: 'Как часто списываются тикеты за точки',
        unit: 'сек',
      },
    ],
  },
  {
    title: 'Захват точек',
    fields: [
      { key: 'capture_speed_percent_per_tick', label: 'Скорость захвата', unit: '% в сек' },
      {
        key: 'uncapture_speed_percent_per_tick',
        label: 'Скорость нейтрализации',
        unit: '% в сек',
        hint: 'Как быстро точка врага становится ничьей.',
      },
      { key: 'safe_spawn_threshold', label: 'Точка годится для возрождения от', unit: '%' },
    ],
  },
  {
    title: 'Очки игроков',
    fields: [
      { key: 'score_per_kill', label: 'Очки за убийство' },
      { key: 'score_per_capture', label: 'Очки за захват точки' },
      { key: 'score_per_uncapture', label: 'Очки за нейтрализацию точки' },
      { key: 'score_per_obj_sec', label: 'Очки за секунду на точке' },
    ],
  },
  {
    title: 'Время и возрождение',
    fields: [
      { key: 'preparation_time_seconds', label: 'Подготовка перед боем', unit: 'сек' },
      { key: 'transition_time_seconds', label: 'Пауза между картами', unit: 'сек' },
      { key: 'base_spawn_time_seconds', label: 'Время возрождения', unit: 'сек' },
      {
        key: 'spawn_time_per_point_seconds',
        label: 'Добавка к возрождению за каждую свою точку',
        unit: 'сек',
      },
      { key: 'enable_spawn_shield', label: 'Защита сразу после возрождения' },
      { key: 'spawn_shield_duration_seconds', label: 'Длительность защиты', unit: 'сек' },
    ],
  },
  {
    title: 'Базы',
    fields: [
      {
        key: 'base_warn_radius',
        label: 'Предупреждение у вражеской базы',
        unit: 'блоков',
        hint: 'Ближе этого расстояния игрок видит предупреждение.',
      },
      {
        key: 'base_kill_radius',
        label: 'Гибель у вражеской базы',
        unit: 'блоков',
        hint: 'Должно быть не больше радиуса предупреждения.',
      },
    ],
  },
  {
    title: 'Команды и сбор игроков',
    fields: [
      { key: 'max_players_per_team', label: 'Максимум игроков в команде' },
      {
        key: 'min_players_per_team',
        label: 'Минимум игроков в команде для старта',
        hint: 'Не больше максимума.',
      },
      { key: 'shuffle_teams_between_rounds', label: 'Перемешивать команды между картами' },
      { key: 'ready_countdown_seconds', label: 'Отсчёт, когда все готовы', unit: 'сек' },
      {
        key: 'ready_timeout_seconds',
        label: 'Сколько ждать неготового игрока',
        unit: 'сек',
        hint: 'Потом он возвращается в лобби.',
      },
      { key: 'reserve_seconds', label: 'Сколько держать место вышедшего игрока', unit: 'сек' },
    ],
  },
]
export const BALANCE_LABELS: Record<string, string> = Object.fromEntries(
  BALANCE_GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f.label])),
)

export const WORKSHOP_PLACES: Record<string, string> = {
  [WORKSHOP_HUB]: 'Хаб мастерской',
  lobby: 'Игровое лобби',
  limbo: 'Лобби прокси',
  ...MAP_NAMES,
}

/**
 * ParCool action ids, in the mod's own order (`settings.json` `parcool.allowedActions`, a subset, any order).
 * ponytail: a hand-kept copy of ParCool's action enum; add a row if ParCool adds an action.
 */
export const PARCOOL_ACTIONS: { id: string; label: string; hint?: string }[] = [
  { id: 'BreakfallReady', label: 'Страховка при падении (подготовка)' },
  { id: 'CatLeap', label: 'Кошачий прыжок с бега' },
  { id: 'ChargeJump', label: 'Заряженный прыжок' },
  { id: 'ClimbPoles', label: 'Лазание по столбам' },
  {
    id: 'ClimbUp',
    label: 'Подтягивание из зацепа',
    hint: 'Без него зацеп только держит игрока на месте, залезть наверх нельзя.',
  },
  { id: 'ClingToCliff', label: 'Зацеп за уступ' },
  { id: 'HideInBlock', label: 'Прятаться в блоке' },
  { id: 'Crawl', label: 'Ползком' },
  { id: 'Dive', label: 'Прыжок в воду с высоты' },
  { id: 'Dodge', label: 'Уклонение рывком' },
  { id: 'FastRun', label: 'Быстрый бег' },
  { id: 'FastSwim', label: 'Быстрое плавание' },
  { id: 'Flipping', label: 'Сальто' },
  { id: 'HangDown', label: 'Вис на перекладине' },
  { id: 'HorizontalWallRun', label: 'Забег по стене горизонтально' },
  { id: 'JumpFromBar', label: 'Прыжок с перекладины' },
  { id: 'QuickTurn', label: 'Быстрый разворот' },
  { id: 'RideZipline', label: 'Катание по тросу' },
  { id: 'Roll', label: 'Перекат при приземлении' },
  { id: 'SkyDive', label: 'Затяжное падение' },
  { id: 'Slide', label: 'Подкат' },
  { id: 'Tap', label: 'Страховка касанием при приземлении' },
  { id: 'Vault', label: 'Перепрыгивание через препятствие' },
  { id: 'VerticalWallRun', label: 'Забег по стене вверх' },
  { id: 'WallJump', label: 'Прыжок от стены' },
  { id: 'WallSlide', label: 'Скольжение по стене' },
  { id: 'StartSwimByCrawl', label: 'Начать плавание ползком' },
]
export const PARCOOL_IDS = new Set(PARCOOL_ACTIONS.map((a) => a.id))
/** What the server allows when `settings.json` has no `parcool` section: the mod image's own base file. */
export const PARCOOL_FILE_DEFAULT = ['FastRun', 'ClingToCliff', 'Crawl']
