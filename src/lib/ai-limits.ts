import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { fail } from './account.ts'
import { BUDGET_UUID, MAX_AI_BUDGET_MICROS, type AiLimits } from './ai-budget.ts'

const plain = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function validateAiAccounts(value: unknown): Record<string, number> {
  if (
    !plain(value) ||
    Object.keys(value).length > 256 ||
    !Object.entries(value).every(
      ([id, amount]) =>
        BUDGET_UUID.test(id) &&
        typeof amount === 'number' &&
        Number.isSafeInteger(amount) &&
        amount >= 0 &&
        amount <= MAX_AI_BUDGET_MICROS,
    )
  )
    throw fail(
      400,
      'Бюджет AI: ожидается до 256 UUID и целые суммы от 0 до 1 000 000 000 000 микроUSD.',
    )
  return { ...value }
}

export function validateAiLimits(value: unknown): AiLimits {
  if (
    !plain(value) ||
    Object.keys(value).some(
      (key) => !['schema', 'revision', 'currency', 'mode', 'sessions', 'builders'].includes(key),
    ) ||
    value.schema !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    value.currency !== 'USD' ||
    !['session', 'builder'].includes(value.mode)
  )
    throw fail(400, 'Бюджет AI: некорректная политика.')
  return {
    schema: 1,
    revision: value.revision,
    currency: 'USD',
    mode: value.mode,
    sessions: validateAiAccounts(value.sessions),
    builders: validateAiAccounts(value.builders),
  }
}

export function readAiLimits(directory: string): AiLimits {
  let fd: number | undefined
  try {
    fd = openSync(join(directory, 'ai-limits.json'), constants.O_RDONLY | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 65_536) throw new Error('invalid policy file')
    const buffer = Buffer.alloc(stat.size + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size > 65_536) throw new Error('policy too large')
    return validateAiLimits(JSON.parse(buffer.subarray(0, size).toString()))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return {
        schema: 1,
        revision: 0,
        currency: 'USD',
        mode: 'session',
        sessions: {},
        builders: {},
      }
    throw fail(503, 'Политика бюджета AI повреждена или недоступна. Сохранение отключено.')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
