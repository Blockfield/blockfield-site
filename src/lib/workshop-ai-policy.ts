import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './account.ts'
import {
  WORKSHOP_AI_DEFAULTS,
  WORKSHOP_AI_MAX_PROVIDERS,
  WORKSHOP_AI_RESERVED_IDS,
  isWorkshopAiBaseUrl,
  isWorkshopAiKey,
  isWorkshopAiModel,
  isWorkshopAiProvider,
  isWorkshopAiProviderId,
  type WorkshopAiCustomProvider,
  type WorkshopAiKeyStatus,
  type WorkshopAiSettings,
} from './workshop-ai.ts'

const plain = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

// Closed schema for writes; the reader ignores anything outside it (forward tolerance)
// and fills the rest from mod defaults (backward tolerance for pre-provider files).
const KNOWN_KEYS = [
  'schema',
  'revision',
  'enabled',
  'provider',
  'generationProvider',
  'guardProvider',
  'transcriptionProvider',
  'providers',
  'inputGuardEnabled',
  'generationModel',
  'guardModel',
  'transcriptionModel',
  'cleanupModel',
  'cleanupProvider',
  'maxBlocks',
  'blocksPerTick',
  'minimumBuildTicks',
  'applyBudgetMs',
  'hourlyRequestLimit',
  'hourlyPlayerRequestLimit',
  'maxHourlyBuilders',
  'generationMaxPricePromptUsdPerM',
  'generationMaxPriceCompletionUsdPerM',
]

function int(value: unknown, min: number, max: number, message: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw fail(400, message)
  return value
}

function decimal(value: unknown, min: number, max: number, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max)
    throw fail(400, message)
  return value
}

function model(value: unknown, message: string): string {
  if (!isWorkshopAiModel(value)) throw fail(400, message)
  return value
}

function providers(value: unknown): WorkshopAiCustomProvider[] {
  if (!Array.isArray(value) || value.length > WORKSHOP_AI_MAX_PROVIDERS)
    throw fail(400, 'Провайдеры: список до 8 записей.')
  const seen = new Set<string>()
  return value.map((entry) => {
    if (!plain(entry)) throw fail(400, 'Провайдер: id, название и https-адрес.')
    if (
      !isWorkshopAiProviderId(entry.id) ||
      isWorkshopAiProvider(entry.id) ||
      WORKSHOP_AI_RESERVED_IDS.includes(entry.id) ||
      seen.has(entry.id)
    )
      throw fail(400, 'ID провайдера: a-z, 0-9 и дефис; уникален и не встроенный.')
    seen.add(entry.id)
    if (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80)
      throw fail(400, 'Название провайдера: 1…80 символов.')
    if (!isWorkshopAiBaseUrl(entry.baseUrl))
      throw fail(400, 'Адрес провайдера: https:// без параметров, до 200 символов.')
    return { id: entry.id, label: entry.label.trim(), baseUrl: entry.baseUrl }
  })
}

export function validateWorkshopAiSettings(value: unknown): WorkshopAiSettings {
  if (
    !plain(value) ||
    Object.keys(value).some((key) => !KNOWN_KEYS.includes(key)) ||
    value.schema !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.enabled !== 'boolean' ||
    !isWorkshopAiProvider(value.provider) ||
    typeof value.inputGuardEnabled !== 'boolean'
  )
    throw fail(400, 'AI мастерской: некорректные настройки.')
  const custom = providers(value.providers ?? [])
  const customIds = custom.map((entry) => entry.id)
  // A referenced provider must exist: a preset or a registry entry, else fail closed.
  // Missing per-model fields follow the legacy `provider`; cleanup follows transcription.
  const ref = (id: unknown, fallback: string, message: string): string => {
    const resolved = id === undefined ? fallback : id
    if (
      !isWorkshopAiProviderId(resolved) ||
      (!isWorkshopAiProvider(resolved) && !customIds.includes(resolved))
    )
      throw fail(400, message)
    return resolved
  }
  const transcriptionProvider = ref(
    value.transcriptionProvider,
    value.provider,
    'Провайдер расшифровки: выберите из списка.',
  )
  return {
    schema: 1,
    revision: value.revision,
    enabled: value.enabled,
    provider: value.provider,
    generationProvider: ref(
      value.generationProvider,
      value.provider,
      'Провайдер генерации: выберите из списка.',
    ),
    guardProvider: ref(
      value.guardProvider,
      value.provider,
      'Провайдер сторожа: выберите из списка.',
    ),
    transcriptionProvider,
    providers: custom,
    inputGuardEnabled: value.inputGuardEnabled,
    generationModel: model(value.generationModel, 'Модель генерации: vendor/model.'),
    guardModel: model(value.guardModel, 'Сторожевая модель: vendor/model.'),
    transcriptionModel: model(value.transcriptionModel, 'Модель расшифровки: vendor/model.'),
    cleanupModel:
      value.cleanupModel === undefined || value.cleanupModel === ''
        ? ''
        : model(value.cleanupModel, 'Модель чистки: vendor/model или пусто.'),
    cleanupProvider: ref(
      value.cleanupProvider,
      transcriptionProvider,
      'Провайдер чистки: выберите из списка.',
    ),
    maxBlocks: int(value.maxBlocks, 1, 32768, 'Максимум блоков: 1…32768.'),
    blocksPerTick: int(value.blocksPerTick, 1, 16384, 'Блоков в тик: 1…16384.'),
    minimumBuildTicks: int(value.minimumBuildTicks, 40, 1200, 'Минимум тиков стройки: 40…1200.'),
    applyBudgetMs: int(value.applyBudgetMs, 1, 20, 'Бюджет тика: 1…20 мс.'),
    hourlyRequestLimit: int(value.hourlyRequestLimit, 1, 1_000_000, 'Запросов в час: 1…1000000.'),
    hourlyPlayerRequestLimit: int(
      value.hourlyPlayerRequestLimit,
      1,
      1_000_000,
      'Запросов игрока в час: 1…1000000.',
    ),
    maxHourlyBuilders: int(value.maxHourlyBuilders, 1, 4096, 'Строителей в час: 1…4096.'),
    generationMaxPricePromptUsdPerM: decimal(
      value.generationMaxPricePromptUsdPerM,
      0,
      1000,
      'Потолок входа: 0…1000 USD за млн токенов.',
    ),
    generationMaxPriceCompletionUsdPerM: decimal(
      value.generationMaxPriceCompletionUsdPerM,
      0,
      1000,
      'Потолок выхода: 0…1000 USD за млн токенов.',
    ),
  }
}

/** `null` removes the key. Error messages never echo the value. */
export function validateWorkshopAiKey(value: unknown): string | null {
  if (value === null) return null
  if (!isWorkshopAiKey(value))
    throw fail(400, 'Ключ: 20–2048 печатных символов ASCII без пробелов.')
  return value
}

export function readWorkshopAiSettings(directory: string): WorkshopAiSettings {
  let fd: number | undefined
  try {
    fd = openSync(
      join(directory, 'workshop-ai-settings.json'),
      constants.O_RDONLY | constants.O_NONBLOCK,
    )
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 8192) throw new Error('invalid settings file')
    const buffer = Buffer.alloc(stat.size + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size > 8192) throw new Error('settings too large')
    const stored = JSON.parse(buffer.subarray(0, size).toString())
    if (!plain(stored)) throw new Error('settings not an object')
    // Tolerant reader: files written before the provider/limits/caps/input-guard existed
    // (or by a newer site) load with mod defaults filled in and extras ignored; only broken
    // JSON or mistyped known fields fail closed. The revision always comes from the file,
    // so the next save still wins the CAS.
    const overlay: Record<string, unknown> = {}
    for (const key of KNOWN_KEYS)
      if (key !== 'schema' && key !== 'revision' && key in stored) overlay[key] = stored[key]
    // Pre-registry files carry only the legacy `provider`: per-model fields follow it
    // unless the file sets them; cleanup follows the resolved transcription provider.
    const legacy = overlay.provider ?? WORKSHOP_AI_DEFAULTS.provider
    for (const key of ['generationProvider', 'guardProvider', 'transcriptionProvider'])
      if (!(key in overlay)) overlay[key] = legacy
    if (!('cleanupProvider' in overlay) && typeof overlay.transcriptionProvider === 'string')
      overlay.cleanupProvider = overlay.transcriptionProvider
    return validateWorkshopAiSettings({
      ...WORKSHOP_AI_DEFAULTS,
      ...overlay,
      schema: 1,
      revision: stored.revision,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schema: 1, revision: 0, ...WORKSHOP_AI_DEFAULTS, providers: [] }
    throw fail(503, 'Настройки AI мастерской повреждены или недоступны. Сохранение отключено.')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// The key's last characters are printable ASCII; an empty tail means no key.
const LAST4 = /^[\x21-\x7e]{0,4}$/
const HEX8 = /^[0-9a-f]{8}$/

/**
 * The controller owns `admin/ai-key.json` (OpenRouter) and `admin/ai-gateway-key.json`
 * (gateway); read tolerantly (unknown keys ignored) so a newer controller status never
 * breaks the site. Anything missing or malformed means "unset".
 */
export function readWorkshopAiKeyStatus(
  directory: string,
  file = 'ai-key.json',
): WorkshopAiKeyStatus {
  let fd: number | undefined
  try {
    fd = openSync(join(directory, file), constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096) return { set: false }
    const buffer = Buffer.alloc(stat.size + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size > 4096) return { set: false }
    const value = JSON.parse(buffer.subarray(0, size).toString())
    if (!plain(value) || typeof value.set !== 'boolean' || !value.set) return { set: false }
    const status: WorkshopAiKeyStatus = { set: true }
    if (value.last4 !== undefined) {
      if (typeof value.last4 !== 'string' || !LAST4.test(value.last4)) return { set: false }
      if (value.last4) status.last4 = value.last4
    }
    if (value.sha256Prefix !== undefined) {
      if (typeof value.sha256Prefix !== 'string' || !HEX8.test(value.sha256Prefix))
        return { set: false }
      status.sha256Prefix = value.sha256Prefix
    }
    if (value.appliedAt !== undefined) {
      if (!Number.isSafeInteger(value.appliedAt) || value.appliedAt < 0) return { set: false }
      status.appliedAt = value.appliedAt
    }
    return status
  } catch {
    return { set: false }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
