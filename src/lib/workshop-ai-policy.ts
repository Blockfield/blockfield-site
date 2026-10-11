import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './account.ts'
import {
  WORKSHOP_AI_DEFAULTS,
  isWorkshopAiGuardModel,
  isWorkshopAiKey,
  isWorkshopAiModel,
  type WorkshopAiKeyStatus,
  type WorkshopAiSettings,
} from './workshop-ai.ts'

const plain = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function validateWorkshopAiSettings(value: unknown): WorkshopAiSettings {
  if (
    !plain(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'schema',
          'revision',
          'enabled',
          'generationModel',
          'guardModel',
          'transcriptionModel',
        ].includes(key),
    ) ||
    value.schema !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.enabled !== 'boolean'
  )
    throw fail(400, 'AI мастерской: некорректные настройки.')
  if (!isWorkshopAiModel(value.generationModel))
    throw fail(400, 'Модель генерации: 1–128 знаков (латиница, цифры, . _ / : -) и «/» в имени.')
  if (!isWorkshopAiGuardModel(value.guardModel))
    throw fail(400, 'Сторожевая модель: только typesafe/jev-…')
  if (!isWorkshopAiModel(value.transcriptionModel))
    throw fail(400, 'Модель расшифровки: 1–128 знаков (латиница, цифры, . _ / : -) и «/» в имени.')
  return {
    schema: 1,
    revision: value.revision,
    enabled: value.enabled,
    generationModel: value.generationModel,
    guardModel: value.guardModel,
    transcriptionModel: value.transcriptionModel,
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
    if (!stat.isFile() || stat.size > 4096) throw new Error('invalid settings file')
    const buffer = Buffer.alloc(stat.size + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size > 4096) throw new Error('settings too large')
    return validateWorkshopAiSettings(JSON.parse(buffer.subarray(0, size).toString()))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { schema: 1, revision: 0, ...WORKSHOP_AI_DEFAULTS }
    throw fail(503, 'Настройки AI мастерской повреждены или недоступны. Сохранение отключено.')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// The key's last characters are printable ASCII; an empty tail means no key.
const LAST4 = /^[\x21-\x7e]{0,4}$/
const HEX8 = /^[0-9a-f]{8}$/

/**
 * The controller owns `admin/ai-key.json`; read tolerantly (unknown keys ignored)
 * so a newer controller status never breaks the site. Anything missing or
 * malformed means "no key".
 */
export function readWorkshopAiKeyStatus(directory: string): WorkshopAiKeyStatus {
  let fd: number | undefined
  try {
    fd = openSync(join(directory, 'ai-key.json'), constants.O_RDONLY | constants.O_NONBLOCK)
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
