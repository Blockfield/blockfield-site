export type KitItem = {
  id: string
  count: number
  slot?: string
  index?: number
  data?: Record<string, any>
}
export type KitVariant = { id: string; name: string; items: KitItem[]; curios?: KitItem[] }
export type KitDefinition = {
  id: string
  name: string
  allowedModeIds: string[]
  deploymentCost: number
  playerLimit: number
  knifeSlot: number
  variants: KitVariant[]
  team_armor?: Record<string, KitItem[]>
  team_accessories?: Record<string, KitItem[]>
  curios?: KitItem[]
  drone_settings?: Record<string, number>
}
export type KitCatalog = {
  schema: 1
  revision: number
  modes: {
    id: string
    fixedKitId: string | null
    defaultFixedKitId: string | null
    supportsFixedKit: boolean
  }[]
  kits: {
    id: string
    name: string
    defaults: KitDefinition | null
    effective: KitDefinition
    editable: boolean
  }[]
  fields: Record<string, any>
  items: { id: string; name: string; kind: string }[]
  guns: { id: string; name: string }[]
  ammos: { id: string; name: string }[]
  attachments: { id: string; name: string }[]
  throwables: { id: string; name: string }[]
  accessorySlots: string[]
}
const plain = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9_]{1,32}$/.test(value)
const resource = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 256 && /^[a-z0-9_.-]+:[a-z0-9/._-]+$/.test(value)
const MODES = new Set(['campaign', 'room', 'tdm', 'snipers', 'awp', 'deathmatch', 'training'])
const registryIds = new WeakMap<object, Set<string>>()
function registered(entries: { id: string }[], value: unknown) {
  let ids = registryIds.get(entries)
  if (!ids) {
    ids = new Set(entries.map((entry) => entry.id))
    registryIds.set(entries, ids)
  }
  return typeof value === 'string' && ids.has(value)
}

function requireKit(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw new Error(`Наборы: ${path}: ${message}.`)
}
function keys(
  value: unknown,
  allowed: string[],
  path: string,
): asserts value is Record<string, any> {
  requireKit(
    plain(value) && Object.keys(value).every((key) => allowed.includes(key)),
    path,
    'неизвестные поля',
  )
}
function label(value: unknown, path: string) {
  requireKit(
    typeof value === 'string' && !!value.trim() && value.length <= 80 && !/[\p{Cc}§]/u.test(value),
    path,
    'название до 80 символов без управляющих знаков',
  )
}
function bounded(value: unknown, field: string, catalog: KitCatalog, path: string, integer = true) {
  const rule = catalog.fields[field]
  requireKit(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      (!integer || Number.isSafeInteger(value)) &&
      value >= rule.min &&
      value <= rule.max,
    path,
    `значение ${rule.min}…${rule.max}`,
  )
}
function list(
  value: unknown,
  field: string,
  catalog: KitCatalog,
  path: string,
): asserts value is any[] {
  const rule = catalog.fields[field]
  requireKit(
    Array.isArray(value) && value.length >= rule.min && value.length <= rule.max,
    path,
    `список ${rule.min}…${rule.max}`,
  )
}
function item(value: unknown, accessory: boolean, catalog: KitCatalog, path: string) {
  keys(value, ['id', 'count', 'slot', 'index', 'data'], path)
  requireKit(registered(catalog.items, value.id), path, 'предмет отсутствует в серверном реестре')
  bounded(value.count, 'count', catalog, path + '.count')
  const sbwGun = catalog.items.find((entry) => entry.id === value.id)?.kind === 'sbwGun'
  requireKit(
    (value.id !== 'tacz:modern_kinetic_gun' && !sbwGun) || value.count === 1,
    path,
    'оружие выдаётся по одному',
  )
  if (accessory) {
    requireKit(catalog.accessorySlots.includes(value.slot), path, 'выберите слот аксессуара')
    if (value.index !== undefined) bounded(value.index, 'index', catalog, path + '.index')
  } else
    requireKit(
      value.slot === undefined && value.index === undefined,
      path,
      'слот аксессуара вне аксессуаров',
    )
  const typed = (
    {
      'tacz:modern_kinetic_gun': ['gunId', 'guns'],
      'tacz:ammo': ['ammoId', 'ammos'],
      'tacz:ammo_box': ['ammoId', 'ammos'],
      'tacz:attachment': ['attachmentId', 'attachments'],
      'lrtactical:throwable': ['throwableId', 'throwables'],
    } as Record<string, [string, keyof KitCatalog]>
  )[value.id]
  if (value.data === undefined) {
    requireKit(
      !typed || value.id === 'tacz:ammo_box',
      path,
      'выберите тип оружия, боеприпаса или снаряжения',
    )
    return
  }
  keys(value.data, sbwGun ? ['gunAmmo'] : catalog.fields.itemData, path + '.data')
  const data = value.data
  if (typed && value.id !== 'tacz:ammo_box')
    requireKit(typeof data[typed[0]] === 'string', path, 'не задан обязательный тип предмета')
  for (const [field, entries, bases] of [
    ['gunId', catalog.guns, ['tacz:modern_kinetic_gun']],
    ['ammoId', catalog.ammos, ['tacz:ammo', 'tacz:ammo_box']],
    ['attachmentId', catalog.attachments, ['tacz:attachment']],
    ['throwableId', catalog.throwables, ['lrtactical:throwable']],
  ] as [string, { id: string }[], string[]][]) {
    if (data[field] !== undefined)
      requireKit(
        bases.includes(value.id) && registered(entries, data[field]),
        path + '.' + field,
        'тип отсутствует в реестре или не подходит предмету',
      )
  }
  for (const field of ['gunAmmo', 'fireMode', 'bulletInBarrel', 'attachments'])
    requireKit(
      data[field] === undefined ||
        (field === 'gunAmmo' && sbwGun) ||
        (value.id === 'tacz:modern_kinetic_gun' && typeof data.gunId === 'string'),
      path,
      'настройки оружия требуют gunId',
    )
  for (const field of ['gunAmmo', 'damage', 'color'])
    if (data[field] !== undefined) bounded(data[field], field, catalog, path + '.' + field)
  if (data.armorPlate !== undefined)
    bounded(data.armorPlate, 'armorPlate', catalog, path + '.armorPlate', false)
  if (data.fireMode !== undefined)
    requireKit(catalog.fields.fireModes.includes(data.fireMode), path, 'неверный режим огня')
  for (const field of ['bulletInBarrel', 'creativeAmmo'])
    if (data[field] !== undefined)
      requireKit(typeof data[field] === 'boolean', path, 'ожидается переключатель')
  requireKit(
    data.creativeAmmo === undefined || value.id === 'tacz:ammo_box',
    path,
    'бесконечные патроны доступны только ящику',
  )
  if (data.attachments !== undefined) {
    keys(data.attachments, catalog.fields.attachmentSlots, path + '.attachments')
    for (const [slot, attachment] of Object.entries(data.attachments)) {
      keys(attachment, ['id', 'zoom'], path + '.' + slot)
      requireKit(
        registered(catalog.attachments, attachment.id),
        path,
        'обвес отсутствует в реестре',
      )
      if (attachment.zoom !== undefined) bounded(attachment.zoom, 'zoom', catalog, path + '.zoom')
    }
  }
}
function items(
  value: unknown,
  field: string,
  accessory: boolean,
  catalog: KitCatalog,
  path: string,
) {
  list(value, field, catalog, path)
  value.forEach((entry, index) => item(entry, accessory, catalog, `${path}.${index}`))
}
export function validateKit(
  value: unknown,
  kitId: string,
  catalog: KitCatalog,
): asserts value is KitDefinition {
  const path = kitId
  keys(
    value,
    [
      'id',
      'name',
      'allowedModeIds',
      'deploymentCost',
      'playerLimit',
      'knifeSlot',
      'variants',
      'team_armor',
      'team_accessories',
      'curios',
      'drone_settings',
    ],
    path,
  )
  requireKit(id(kitId) && value.id === kitId, path, 'ID должен совпадать с ключом набора')
  label(value.name, path + '.name')
  requireKit(
    Array.isArray(value.allowedModeIds) &&
      value.allowedModeIds.length <= catalog.modes.length &&
      new Set(value.allowedModeIds).size === value.allowedModeIds.length &&
      value.allowedModeIds.every((mode: string) =>
        catalog.modes.some((entry) => entry.id === mode),
      ),
    path,
    'выберите уникальные боевые режимы',
  )
  for (const field of ['deploymentCost', 'playerLimit', 'knifeSlot'])
    bounded(value[field], field, catalog, path + '.' + field)
  list(value.variants, 'variants', catalog, path + '.variants')
  const variants = new Set()
  value.variants.forEach((variant, index) => {
    keys(variant, ['id', 'name', 'items', 'curios'], `${path}.variants.${index}`)
    requireKit(id(variant.id) && !variants.has(variant.id), path, 'варианты требуют уникальные ID')
    variants.add(variant.id)
    label(variant.name, path + '.variant.name')
    items(variant.items, 'items', false, catalog, path + '.variant.items')
    if (variant.curios !== undefined)
      items(variant.curios, 'curios', true, catalog, path + '.variant.curios')
  })
  if (value.curios !== undefined) items(value.curios, 'curios', true, catalog, path + '.curios')
  for (const field of ['team_armor', 'team_accessories'])
    if (value[field] !== undefined) {
      keys(value[field], ['RedTeam', 'BlueTeam', 'NONE'], path + '.' + field)
      for (const [team, entries] of Object.entries(value[field]))
        items(
          entries,
          field === 'team_armor' ? 'team_armor' : 'curios',
          field === 'team_accessories',
          catalog,
          `${path}.${field}.${team}`,
        )
    }
  if (value.drone_settings !== undefined) {
    keys(
      value.drone_settings,
      ['initial_scout', 'initial_combat', 'initial_fpv', 'initial_fibre_fpv', 'max_active_fpv'],
      path + '.drone_settings',
    )
    for (const [key, stock] of Object.entries(value.drone_settings))
      requireKit(
        Number.isSafeInteger(stock) && stock >= (key === 'max_active_fpv' ? 1 : 0) && stock <= 16,
        path + '.' + key,
        'значение до 16',
      )
  }
}
export function baseKits(catalog: KitCatalog, classCosts: unknown = {}) {
  requireKit(plain(classCosts), 'classCosts', 'неверные прежние стоимости')
  return Object.fromEntries(
    catalog.kits
      .filter((kit) => kit.defaults !== null)
      .map((kit) => {
        const definition = structuredClone(kit.defaults!)
        if (Object.hasOwn(classCosts, kit.id)) {
          bounded(classCosts[kit.id], 'deploymentCost', catalog, 'classCosts.' + kit.id)
          definition.deploymentCost = classCosts[kit.id]
        }
        return [kit.id, definition]
      }),
  ) as Record<string, KitDefinition>
}
export function validateKitChanges(
  kits: unknown,
  bindings: unknown,
  catalog: KitCatalog,
  classCosts: unknown = {},
) {
  requireKit(
    plain(kits) && Object.keys(kits).length <= catalog.fields.kits.max,
    'kits',
    'неверный список наборов',
  )
  for (const [kitId, kit] of Object.entries(kits)) validateKit(kit, kitId, catalog)
  const effective = new Map(Object.entries(baseKits(catalog, classCosts)))
  for (const [kitId, kit] of Object.entries(kits)) effective.set(kitId, kit as KitDefinition)
  requireKit(
    effective.size <= catalog.fields.kits.max,
    'kits',
    'слишком много наборов с учётом стандартных',
  )
  requireKit(
    plain(bindings) &&
      Object.keys(bindings).every((mode) =>
        catalog.modes.some((entry) => entry.id === mode && entry.supportsFixedKit),
      ),
    'fixedModeKits',
    'неверный режим',
  )
  for (const [mode, target] of Object.entries(bindings)) {
    if (target === null) continue
    const kit = typeof target === 'string' ? effective.get(target) : undefined
    requireKit(
      kit && kit.allowedModeIds.includes(mode),
      mode,
      'фиксированный набор должен существовать и допускать этот режим',
    )
  }
  // Absent bindings retain runtime defaults; removing an override must not silently break a fixed mode.
  for (const mode of catalog.modes)
    if (!Object.hasOwn(bindings, mode.id) && mode.defaultFixedKitId !== null) {
      const kit = effective.get(mode.defaultFixedKitId)
      requireKit(
        kit && kit.allowedModeIds.includes(mode.id),
        mode.id,
        'сначала измените фиксированный набор режима',
      )
    }
  return {
    kits: kits as Record<string, KitDefinition>,
    fixedModeKits: bindings as Record<string, string | null>,
  }
}
export function parseKitCatalog(value: unknown): KitCatalog {
  requireKit(
    plain(value) &&
      value.schema === 1 &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0,
    'catalog',
    'неверная ревизия',
  )
  requireKit(
    plain(value.fields) && value.fields.idPattern === '[a-z0-9_]{1,32}',
    'catalog',
    'неверная схема ID',
  )
  for (const field of [
    'kits',
    'variants',
    'items',
    'curios',
    'team_armor',
    'count',
    'deploymentCost',
    'playerLimit',
    'knifeSlot',
    'index',
    'gunAmmo',
    'zoom',
    'damage',
    'color',
    'armorPlate',
  ]) {
    const bound = value.fields[field]
    requireKit(
      plain(bound) &&
        Number.isSafeInteger(bound.min) &&
        Number.isSafeInteger(bound.max) &&
        bound.min >= 0 &&
        bound.max >= bound.min &&
        bound.max <= 16777215,
      'catalog.' + field,
      'неверные границы',
    )
  }
  const caps: Record<string, number> = {
    kits: 64,
    variants: 16,
    items: 36,
    curios: 16,
    team_armor: 4,
    count: 1024,
    deploymentCost: 10000,
    playerLimit: 999,
    knifeSlot: 7,
    index: 15,
    gunAmmo: 1000,
    zoom: 32,
    damage: 10000,
    color: 16777215,
    armorPlate: 100,
  }
  for (const [key, cap] of Object.entries(caps))
    requireKit(value.fields[key].max <= cap, 'catalog.' + key, 'границы превышают контракт')
  const enums: Record<string, string[]> = {
    attachmentSlots: ['SCOPE', 'MUZZLE', 'STOCK', 'GRIP', 'LASER', 'EXTENDED_MAG'],
    fireModes: ['SEMI', 'AUTO', 'BURST'],
    itemData: [
      'gunId',
      'ammoId',
      'attachmentId',
      'throwableId',
      'gunAmmo',
      'fireMode',
      'bulletInBarrel',
      'creativeAmmo',
      'armorPlate',
      'color',
      'damage',
      'attachments',
    ],
  }
  for (const field of ['attachmentSlots', 'fireModes', 'itemData'])
    requireKit(
      Array.isArray(value.fields[field]) &&
        value.fields[field].length <= 32 &&
        new Set(value.fields[field]).size === value.fields[field].length &&
        value.fields[field].every(
          (entry: unknown) => typeof entry === 'string' && enums[field].includes(entry),
        ),
      'catalog.' + field,
      'неверный список полей',
    )
  requireKit(
    Array.isArray(value.modes) &&
      value.modes.length > 0 &&
      value.modes.length <= 7 &&
      new Set(value.modes.map((mode: any) => mode.id)).size === value.modes.length &&
      value.modes.every(
        (mode: any) =>
          plain(mode) &&
          MODES.has(mode.id) &&
          (mode.fixedKitId === null || id(mode.fixedKitId)) &&
          (mode.defaultFixedKitId === null || id(mode.defaultFixedKitId)) &&
          mode.supportsFixedKit === (mode.id !== 'training'),
      ),
    'catalog.modes',
    'неверные режимы',
  )
  for (const field of ['items', 'guns', 'ammos', 'attachments', 'throwables']) {
    const entries = value[field]
    requireKit(
      Array.isArray(entries) &&
        entries.length <= 32768 &&
        new Set(entries.map((entry) => entry.id)).size === entries.length &&
        entries.every(
          (entry) =>
            plain(entry) &&
            resource(entry.id) &&
            typeof entry.name === 'string' &&
            entry.name.length <= 512 &&
            (field !== 'items' || typeof entry.kind === 'string'),
        ),
      'catalog.' + field,
      'неверный реестр',
    )
  }
  requireKit(
    Array.isArray(value.accessorySlots) &&
      value.accessorySlots.length <= 256 &&
      new Set(value.accessorySlots).size === value.accessorySlots.length &&
      value.accessorySlots.every(
        (slot: unknown) =>
          typeof slot === 'string' &&
          slot.length > 0 &&
          slot.length <= 128 &&
          !/[\p{Cc}]/u.test(slot),
      ),
    'catalog',
    'неверные слоты аксессуаров',
  )
  requireKit(
    Array.isArray(value.kits) &&
      value.kits.length <= 64 &&
      new Set(value.kits.map((kit: any) => kit.id)).size === value.kits.length,
    'catalog',
    'неверные наборы',
  )
  const catalog = value as KitCatalog
  for (const kit of catalog.kits) {
    requireKit(
      plain(kit) && id(kit.id) && typeof kit.name === 'string' && typeof kit.editable === 'boolean',
      'catalog',
      'неверный набор',
    )
    validateKit(kit.effective, kit.id, catalog)
    if (kit.defaults !== null) validateKit(kit.defaults, kit.id, catalog)
  }
  return catalog
}
