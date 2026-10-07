/** Owner's raw RCON console: shared by the API (validation) and the page (confirmation). No server-only imports. */

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
