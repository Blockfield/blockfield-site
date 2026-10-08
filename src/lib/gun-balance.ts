import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './account.ts'
import { BODY_PARTS, weaponFields } from './gun-fields.ts'

export type GunValue = null | boolean | number | string | GunValue[] | { [key: string]: GunValue }
export type GunField = {
  type:
    | 'object'
    | 'array'
    | 'map'
    | 'json'
    | 'boolean'
    | 'integer'
    | 'number'
    | 'string'
    | 'resource'
  nullable: boolean
  fields?: Record<string, GunField>
  items?: GunField
  keys?: GunField
  min?: number
  max?: number
  values?: string[]
  acceptsBoolean?: boolean
  acceptsInfinite?: boolean
}
export type GunDefinition = {
  id: string
  data: string
  name: string
  type: string
  defaults: Record<string, GunValue>
  effective: Record<string, GunValue>
  warnings: string[]
  weaponKind?: 'tacz' | 'item'
  sourceId?: string
}
export type GunBalanceCatalog = {
  schema: 1
  revision: number
  fields: GunField
  guns: GunDefinition[]
  bodyPartsEnabled?: boolean
}
export type GunBalanceAvailability =
  | { available: true; catalog: GunBalanceCatalog }
  | { available: false; error: string }
export type GunOverrides = Record<string, Record<string, GunValue>>

const plain = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const resource = /^(?:[a-z0-9_.-]+:)?[a-z0-9/._-]+$/
const canonicalId = /^[a-z0-9_.-]+:[a-z0-9/._-]+$/
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 256 && canonicalId.test(value)

function requireValue(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw fail(400, `Баланс оружия: ${path}: ${message}.`)
}
const string = (value: unknown, max = 256) =>
  typeof value === 'string' && !!value.trim() && value.length <= max
const fields = new Set([
  'type',
  'nullable',
  'fields',
  'items',
  'keys',
  'min',
  'max',
  'values',
  'acceptsBoolean',
  'acceptsInfinite',
])

function checkField(value: any, depth = 0): asserts value is GunField {
  requireValue(plain(value) && depth <= 16, 'catalog.fields', 'неверная схема поля')
  requireValue(
    Object.keys(value).every((key) => fields.has(key)),
    'catalog.fields',
    'неизвестное описание поля',
  )
  requireValue(typeof value.nullable === 'boolean', 'catalog.fields', 'не задана допустимость null')
  requireValue(
    [
      'object',
      'array',
      'map',
      'json',
      'boolean',
      'integer',
      'number',
      'string',
      'resource',
    ].includes(value.type),
    'catalog.fields',
    'неизвестный тип',
  )
  for (const flag of ['acceptsBoolean', 'acceptsInfinite'])
    requireValue(
      value[flag] === undefined || typeof value[flag] === 'boolean',
      'catalog.fields',
      'неверный флаг',
    )
  requireValue(
    !value.acceptsBoolean || value.type === 'object',
    'catalog.fields',
    'неверный boolean union',
  )
  requireValue(
    !value.acceptsInfinite || value.type === 'number',
    'catalog.fields',
    'неверный infinite union',
  )
  if (value.type === 'integer' || value.type === 'number')
    requireValue(
      Number.isFinite(value.min) && Number.isFinite(value.max) && value.min <= value.max,
      'catalog.fields',
      'неверные границы',
    )
  requireValue(
    (value.min === undefined && value.max === undefined) ||
      value.type === 'integer' ||
      value.type === 'number',
    'catalog.fields',
    'границы ненумерического поля',
  )
  requireValue(
    value.fields === undefined || value.type === 'object',
    'catalog.fields',
    'неверные вложенные поля',
  )
  requireValue(
    value.items === undefined || value.type === 'array' || value.type === 'map',
    'catalog.fields',
    'неверный тип элементов',
  )
  requireValue(
    value.keys === undefined || value.type === 'map',
    'catalog.fields',
    'неверный тип ключей',
  )
  if (value.values !== undefined)
    requireValue(
      value.type === 'string' &&
        Array.isArray(value.values) &&
        value.values.length > 0 &&
        value.values.length <= 256 &&
        value.values.every((v: unknown) => string(v)) &&
        new Set(value.values).size === value.values.length,
      'catalog.fields',
      'неверный список значений',
    )
  if (value.type === 'object') {
    requireValue(
      plain(value.fields) && Object.keys(value.fields).length <= 256,
      'catalog.fields',
      'нет вложенных полей',
    )
    for (const [key, child] of Object.entries(value.fields)) {
      requireValue(string(key), 'catalog.fields', 'неверное имя поля')
      checkField(child, depth + 1)
    }
  }
  if (value.type === 'array' || value.type === 'map') checkField(value.items, depth + 1)
  if (value.type === 'map') {
    checkField(value.keys, depth + 1)
    requireValue(
      ['string', 'resource'].includes(value.keys.type),
      'catalog.fields',
      'неверный тип ключей карты',
    )
  }
}

function checkJson(value: any, path: string, strict: boolean, depth = 0) {
  requireValue(depth <= 8, path, 'вложенность JSON больше 8')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    requireValue(
      Number.isFinite(value) && Math.abs(value) <= (strict ? 1_000_000 : 1_000_000_000),
      path,
      'неверное число JSON',
    )
    return
  }
  if (typeof value === 'string') {
    requireValue(value.length <= (strict ? 4096 : 65_536), path, 'слишком длинная строка JSON')
    return
  }
  requireValue(plain(value) || Array.isArray(value), path, 'неверный JSON')
  requireValue(Object.keys(value).length <= 256, path, 'больше 256 элементов')
  for (const [key, child] of Object.entries(value)) {
    requireValue(string(key), path, 'неверный ключ JSON')
    checkJson(child, `${path}.${key}`, strict, depth + 1)
  }
}

function checkValue(
  value: any,
  field: GunField,
  path: string,
  full: boolean,
  strict = true,
  jsonDepth = 0,
) {
  if (value === null) {
    requireValue(field.nullable || (!strict && !!field.values), path, 'null запрещён')
    return
  }
  if (field.acceptsInfinite && value === 'infinite') return
  if (field.acceptsBoolean && typeof value === 'boolean') return
  switch (field.type) {
    case 'json':
      checkJson(value, path, strict, jsonDepth)
      return
    case 'boolean':
      requireValue(typeof value === 'boolean', path, 'ожидается boolean')
      return
    case 'integer':
    case 'number':
      requireValue(
        typeof value === 'number' &&
          Number.isFinite(value) &&
          (field.type !== 'integer' || Number.isSafeInteger(value)) &&
          (strict ? value >= field.min! && value <= field.max! : Math.abs(value) <= 1_000_000_000),
        path,
        `ожидается ${field.type} ${field.min}…${field.max}`,
      )
      return
    case 'string':
    case 'resource':
      requireValue(
        typeof value === 'string' && value.length <= 256 && (!strict || !!value.trim()),
        path,
        'ожидается строка до 256 символов',
      )
      if (field.type === 'resource' && strict)
        requireValue(resource.test(value), path, 'неверный resource ID')
      if (field.values && strict)
        requireValue(
          field.values.some((v) => v === value || v.toUpperCase() === value),
          path,
          'неизвестное значение',
        )
      return
    case 'array':
      requireValue(
        Array.isArray(value) && value.length <= 256,
        path,
        'ожидается массив до 256 элементов',
      )
      value.forEach((item: unknown, index: number) =>
        checkValue(item, field.items!, `${path}[${index}]`, full, strict),
      )
      return
    case 'map':
    case 'object':
      requireValue(
        plain(value) && Object.keys(value).length <= 256,
        path,
        'ожидается объект до 256 полей',
      )
      for (const [key, child] of Object.entries(value)) {
        if (field.type === 'map') checkValue(key, field.keys!, `${path}.key`, false, strict)
        else if (!Object.hasOwn(field.fields!, key)) {
          requireValue(!strict, `${path}.${key}`, 'неизвестное поле TaCZ')
          checkJson(child, `${path}.${key}`, false)
          continue
        }
        checkValue(
          child,
          field.type === 'map' ? field.items! : field.fields![key],
          `${path}.${key}`,
          full,
          strict,
        )
      }
      if (full && field.type === 'object')
        for (const [key, child] of Object.entries(field.fields!))
          requireValue(
            child.nullable || Object.hasOwn(value, key),
            `${path}.${key}`,
            'нет обязательного поля',
          )
  }
}

/** Native defaults may contain legacy bounds, unknown raw fields and null enum entries; edits stay strict. */
export function validateGunCatalog(value: unknown): GunBalanceCatalog {
  requireValue(
    plain(value) &&
      value.schema === 1 &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0,
    'catalog',
    'неверная schema/revision',
  )
  requireValue(
    value.bodyPartsEnabled === undefined || typeof value.bodyPartsEnabled === 'boolean',
    'catalog.bodyPartsEnabled',
    'неверное состояние системы попаданий',
  )
  checkField(value.fields)
  requireValue(
    value.fields.type === 'object' && Object.keys(value.fields.fields!).length > 0,
    'catalog',
    'нет полей оружия',
  )
  requireValue(
    Array.isArray(value.guns) && value.guns.length <= 2048,
    'catalog',
    'неверный список оружия',
  )
  const parts = value.fields.fields!.body_part_multipliers
  if (parts) {
    requireValue(
      parts.type === 'object' &&
        !parts.nullable &&
        !parts.acceptsBoolean &&
        Object.keys(parts.fields ?? {}).length === BODY_PARTS.length &&
        BODY_PARTS.every((part) => {
          const field = parts.fields?.[part]
          return (
            field?.type === 'number' &&
            !field.nullable &&
            !field.acceptsInfinite &&
            field.min === 0 &&
            field.max === 10
          )
        }),
      'catalog.fields.body_part_multipliers',
      'неверная схема множителей частей тела',
    )
  }
  const ids = new Set()
  for (const gun of value.guns) {
    requireValue(
      plain(gun) &&
        validId(gun.id) &&
        validId(gun.data) &&
        !ids.has(gun.id) &&
        string(gun.name) &&
        string(gun.type),
      'catalog.guns',
      'неверные ID/название/тип',
    )
    if (gun.weaponKind !== undefined || gun.sourceId !== undefined)
      requireValue(
        parts &&
          validId(gun.sourceId) &&
          (gun.weaponKind === 'tacz'
            ? gun.sourceId === gun.id
            : gun.weaponKind === 'item' &&
              gun.id === `item:${gun.sourceId.replace(':', '/')}` &&
              gun.data === gun.id &&
              gun.type === 'item'),
        gun.id,
        'неверный вид оружия или исходный ID',
      )
    ids.add(gun.id)
    requireValue(plain(gun.defaults) && plain(gun.effective), gun.id, 'нет defaults/effective')
    const fields = weaponFields(value as GunBalanceCatalog, gun as GunDefinition)
    if (gun.weaponKind === 'item')
      requireValue(
        [gun.defaults, gun.effective].every((entry) =>
          Object.keys(entry).every((key) => key === 'body_part_multipliers'),
        ),
        gun.id,
        'предмет допускает только множители частей тела',
      )
    checkValue(gun.defaults, fields, `${gun.id}.defaults`, true, false)
    checkValue(gun.effective, fields, `${gun.id}.effective`, true, false)
    if (parts) {
      checkValue(
        gun.defaults.body_part_multipliers,
        parts,
        `${gun.id}.defaults.body_part_multipliers`,
        true,
      )
      checkValue(
        gun.effective.body_part_multipliers,
        parts,
        `${gun.id}.effective.body_part_multipliers`,
        true,
      )
      requireValue(
        BODY_PARTS.every((part) => gun.defaults.body_part_multipliers[part] === 1),
        gun.id,
        'исходные относительные множители должны равняться 1',
      )
    }
    requireValue(
      Array.isArray(gun.warnings) &&
        gun.warnings.length <= 64 &&
        gun.warnings.every((warning: unknown) => string(warning, 4096)),
      gun.id,
      'неверные предупреждения',
    )
  }
  return value as GunBalanceCatalog
}

export function readGunBalance(directory: string): GunBalanceAvailability {
  let fd: number | undefined
  try {
    fd = openSync(join(directory, 'gun-balance.json'), constants.O_RDONLY | constants.O_NONBLOCK)
    const limit = 8 * 1024 * 1024,
      stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > limit) throw new Error('catalog too large or not a file')
    const buffer = Buffer.alloc(stat.size + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size > limit) throw new Error('catalog too large')
    return {
      available: true,
      catalog: validateGunCatalog(JSON.parse(buffer.subarray(0, size).toString())),
    }
  } catch {
    return {
      available: false,
      error: 'Каталог баланса недоступен: сервер не передал корректные данные.',
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

const equal = (a: any, b: any): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  if (plain(a) && plain(b))
    return (
      Object.keys(a).length === Object.keys(b).length &&
      Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && equal(value, b[key]))
    )
  return false
}

/** Objects merge recursively as in the mod; arrays and null replace the complete value. */
export function mergeGunValues(base: any, overrides: any): any {
  if (!plain(base) || !plain(overrides)) return structuredClone(overrides)
  return Object.fromEntries([
    ...Object.entries(base),
    ...Object.entries(overrides).map(([key, value]) => [
      key,
      mergeGunValues(Object.hasOwn(base, key) ? base[key] : undefined, value),
    ]),
  ])
}

function changedValues(
  value: any,
  field: GunField,
  baseline: any,
  path: string,
  jsonDepth = 0,
): any {
  if (equal(value, baseline)) return undefined
  if (field.type === 'json') requireValue(jsonDepth <= 8, path, 'вложенность JSON больше 8')
  if (plain(value) && ['object', 'map', 'json'].includes(field.type)) {
    requireValue(Object.keys(value).length <= 256, path, 'больше 256 полей')
    const changed = [],
      seen = new Map<string, any>()
    for (const [inputKey, child] of Object.entries(value)) {
      const key =
        field.type === 'map'
          ? (field.keys!.values?.find((v) => v === inputKey || v.toUpperCase() === inputKey) ??
            inputKey)
          : inputKey
      requireValue(
        !seen.has(key) || equal(seen.get(key), child),
        `${path}.${key}`,
        'противоречивые ключи enum',
      )
      seen.set(key, child)
      if (plain(baseline) && Object.hasOwn(baseline, key) && equal(child, baseline[key])) continue
      if (field.type === 'map') checkValue(key, field.keys!, `${path}.key`, false)
      else if (field.type === 'json') requireValue(string(key), path, 'неверный ключ JSON')
      else
        requireValue(Object.hasOwn(field.fields!, key), `${path}.${key}`, 'неизвестное поле TaCZ')
      const next = changedValues(
        child,
        field.type === 'json' ? field : field.type === 'map' ? field.items! : field.fields![key],
        plain(baseline) && Object.hasOwn(baseline, key) ? baseline[key] : undefined,
        `${path}.${key}`,
        field.type === 'json' ? jsonDepth + 1 : 0,
      )
      if (next !== undefined) changed.push([key, next])
    }
    return changed.length ? Object.fromEntries(changed) : undefined
  }
  checkValue(value, field, path, false, true, jsonDepth)
  return structuredClone(value)
}

/** Return only actual overrides. An omitted gun/field resets it; null is a nullable value, not reset. */
export function validateGunOverrides(value: unknown, catalog: GunBalanceCatalog): GunOverrides {
  requireValue(
    plain(value) && Object.keys(value).length <= 256,
    'gunBalance',
    'ожидается до 256 оружий',
  )
  const guns = new Map(catalog.guns.map((gun) => [gun.id, gun]))
  const aliases = new Map<string, any>(),
    result = []
  for (const [id, override] of Object.entries(value)) {
    const gun = guns.get(id)
    requireValue(gun && plain(override), id, 'неизвестный индекс оружия или неверные поля')
    if (Object.hasOwn(override, 'body_part_multipliers')) {
      const parts = catalog.fields.fields!.body_part_multipliers
      requireValue(parts, id, 'сервер не поддерживает множители частей тела')
      checkValue(override.body_part_multipliers, parts, `${id}.body_part_multipliers`, false)
    }
    const changed = changedValues(override, weaponFields(catalog, gun!), gun!.defaults, id) ?? {}
    const effective = mergeGunValues(gun!.defaults, changed)
    // Body coefficients belong to an index; only native TaCZ data is shared by aliases.
    const native = Object.fromEntries(
      Object.entries(effective).filter(([key]) => key !== 'body_part_multipliers'),
    )
    if (Object.keys(override).some((key) => key !== 'body_part_multipliers')) {
      requireValue(
        !aliases.has(gun!.data) || equal(aliases.get(gun!.data), native),
        id,
        'два индекса задают разный баланс общих данных',
      )
      aliases.set(gun!.data, native)
    }
    if (Object.keys(changed).length) result.push([id, changed])
  }
  const overrides = Object.fromEntries(result)
  requireValue(
    Buffer.byteLength(JSON.stringify(overrides)) <= 240_000,
    'gunBalance',
    'слишком большая ревизия',
  )
  return overrides
}
