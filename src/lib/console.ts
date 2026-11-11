/** Owner's raw RCON console: shared by the API (validation) and the page (confirmation). No server-only imports. */

export type RconTarget = 'game' | 'workshop'

/** Validates the console target enum: defaults to 'game', rejects unknown values. */
export function rconTarget(value: unknown): RconTarget {
  if (value === undefined || value === null || value === '') return 'game'
  if (value === 'game' || value === 'workshop') return value
  throw new Error('Неизвестная цель консоли.')
}

/** One command line as typed: trimmed, leading `/` removed. Throws a Russian message the API turns into a 400. */
export function rawCommand(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Введите команду.')
  // Control characters (newlines included) would let one call smuggle a second command or forge log lines.
  if (/\p{Cc}/u.test(value)) throw new Error('Команда — одна строка без управляющих символов.')
  const command = value.trim().replace(/^\/+/, '').trim()
  if (!command) throw new Error('Введите команду.')
  if (command.length > 1000) throw new Error('Команда длиннее 1000 символов.')
  return command
}

/**
 * Commands that stop the server, change operators/access, destroy world state or players' progress.
 * ponytail: a prefix list, not a parser — `execute … run stop` is caught by `execute`; extend when a new risky command appears.
 */
const DANGEROUS =
  /^(stop|restart|op|deop|ban|ban-ip|pardon|pardon-ip|kick|kill|clear|reload|save-off|whitelist\s+(off|remove)|execute|fill|clone|setblock|forceload|gamerule|difficulty|tick\s+(freeze|rate|sprint|step)|bf\s+(maintenance|stop))\b/i
export const dangerousCommand = (command: string) => DANGEROUS.test(command)

/** Minecraft formatting codes (`§a`, `§l`, …) are dropped: the console shows plain text. */
export const stripColors = (output: string) => output.replace(/§./g, '')

/** Live log cursor: a non-negative integer, defaults to 0. Throws a Russian message the API turns into a 400. */
export function consoleSince(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Некорректный курсор журнала.')
  return n
}

/** Partial command line for completion: may be empty, otherwise one trimmed line, max 1000 chars. */
export function suggestInput(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Введите начало команды.')
  if (/\p{Cc}/u.test(value)) throw new Error('Ввод — одна строка без управляющих символов.')
  const input = value.replace(/^\/+/, '')
  if (input.length > 1000) throw new Error('Ввод длиннее 1000 символов.')
  return input
}

export type ConsoleEntry = {
  seq: number
  at: number
  level: string
  logger: string
  message: string
}

/** Validates one page of the console log link: entries oldest-first plus the next cursor. */
export function consoleLogPage(value: unknown): { entries: ConsoleEntry[]; next: number } {
  if (typeof value !== 'object' || value === null) throw new Error('Журнал недоступен.')
  const { entries, next } = value as { entries?: unknown; next?: unknown }
  if (!Array.isArray(entries) || !Number.isSafeInteger(next) || (next as number) < 0)
    throw new Error('Журнал недоступен.')
  return {
    entries: entries.slice(0, 500).map((row) => {
      const e = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>
      return {
        seq: Number.isSafeInteger(e.seq) ? (e.seq as number) : 0,
        at: Number.isSafeInteger(e.at) ? (e.at as number) : 0,
        level: typeof e.level === 'string' ? e.level.slice(0, 16).toUpperCase() : '',
        logger: typeof e.logger === 'string' ? e.logger.slice(0, 200) : '',
        message: typeof e.message === 'string' ? e.message.slice(0, 2000) : '',
      }
    }),
    next: next as number,
  }
}

export type ConsoleSuggestion = { text: string; hint: string }

/** Validates one completion answer: the replace offset plus at most 50 suggestions. */
export function consoleSuggestPage(value: unknown): {
  from: number
  suggestions: ConsoleSuggestion[]
} {
  if (typeof value !== 'object' || value === null) throw new Error('Подсказки недоступны.')
  const { from, suggestions } = value as { from?: unknown; suggestions?: unknown }
  if (!Number.isSafeInteger(from) || (from as number) < 0 || !Array.isArray(suggestions))
    throw new Error('Подсказки недоступны.')
  return {
    from: from as number,
    suggestions: suggestions.slice(0, 50).flatMap((row) => {
      const s = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>
      return typeof s.text === 'string' && s.text
        ? [
            {
              text: s.text.slice(0, 200),
              hint: typeof s.hint === 'string' ? s.hint.slice(0, 200) : '',
            },
          ]
        : []
    }),
  }
}
