export type AiLimits = {
  schema: 1
  revision: number
  currency: 'USD'
  mode: 'session' | 'builder'
  sessions: Record<string, number>
  builders: Record<string, number>
}
export const MAX_AI_BUDGET_MICROS = 1_000_000_000_000
export const BUDGET_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function canonicalBudgetUuid(value: string): string | null {
  const id = value.replaceAll('-', '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(id)
    ? `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
    : null
}

export function usdMicros(value: string): number {
  const input = value.trim()
  if (input.length > 32 || !/^\d+(?:[.,]\d{1,6})?$/.test(input))
    throw new Error('Введите сумму в USD: до шести знаков после запятой, без округления.')
  const [whole, fraction = ''] = input.split(/[.,]/)
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
  if (micros > BigInt(MAX_AI_BUDGET_MICROS))
    throw new Error('Бюджет не может превышать 1 000 000 USD.')
  return Number(micros)
}

export function usdAmount(micros: number): string {
  const fraction = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '')
  return `${Math.floor(micros / 1_000_000)}${fraction ? `.${fraction}` : ''}`
}
