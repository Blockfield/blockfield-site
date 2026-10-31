/**
 * Nonsecret Workshop AI settings shared by the site API and the admin UI.
 * File I/O and throwing validation live in `workshop-ai-policy.ts`; this module
 * is import-safe for the browser bundle (no node imports).
 */

export const WORKSHOP_AI_DEFAULTS = {
  enabled: false,
  provider: 'openrouter',
  generationModel: 'meta/muse-spark-1.3-contributor',
  guardModel: 'typesafe/jev-1.13',
  transcriptionModel: 'openai/whisper-1',
  maxBlocks: 16384,
  blocksPerTick: 2048,
  minimumBuildTicks: 80,
  applyBudgetMs: 8,
  hourlyRequestLimit: 360,
  hourlyPlayerRequestLimit: 60,
  maxHourlyBuilders: 256,
  generationMaxPricePromptUsdPerM: 0.1,
  generationMaxPriceCompletionUsdPerM: 0.2,
} as const

export const WORKSHOP_AI_PROVIDERS = ['openrouter', 'vercel-gateway'] as const

export type WorkshopAiProvider = (typeof WORKSHOP_AI_PROVIDERS)[number]

export type WorkshopAiSettings = {
  schema: 1
  revision: number
  enabled: boolean
  provider: WorkshopAiProvider
  generationModel: string
  guardModel: string
  transcriptionModel: string
  maxBlocks: number
  blocksPerTick: number
  minimumBuildTicks: number
  applyBudgetMs: number
  hourlyRequestLimit: number
  hourlyPlayerRequestLimit: number
  maxHourlyBuilders: number
  generationMaxPricePromptUsdPerM: number
  generationMaxPriceCompletionUsdPerM: number
}

// Same shape as the server's check: vendor/name with an optional :variant such as :free.
// Owner input is trusted: every model ID uses this one shape check, no allowlist.
export const WORKSHOP_AI_MODEL = /^[a-zA-Z0-9._-]{1,64}\/[a-zA-Z0-9._/:-]{1,126}$/
export const WORKSHOP_AI_KEY = /^[\x21-\x7e]{20,2048}$/

export const isWorkshopAiModel = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && WORKSHOP_AI_MODEL.test(value)

export const isWorkshopAiProvider = (value: unknown): value is WorkshopAiProvider =>
  value === 'openrouter' || value === 'vercel-gateway'

export const isWorkshopAiKey = (value: unknown): value is string =>
  typeof value === 'string' && WORKSHOP_AI_KEY.test(value)

/** Nonsecret key state from `admin/ai-key.json` (controller-maintained; missing means unset). */
export type WorkshopAiKeyStatus = {
  set: boolean
  last4?: string
  sha256Prefix?: string
  appliedAt?: number
}

export function workshopAiKeyLine(
  status: WorkshopAiKeyStatus,
  pending: { waiting: boolean; error?: string | null },
  formatDate: (ms: number) => string,
): string {
  if (pending.error) return `Контроллер не применил ключ: ${pending.error}`
  if (pending.waiting) return 'Ключ применяется…'
  if (!status.set) return 'Ключ не задан'
  const tail = status.last4 ? ` · ••••${status.last4}` : ''
  const when = typeof status.appliedAt === 'number' ? ` · ${formatDate(status.appliedAt)}` : ''
  return `Ключ задан${tail}${when}`
}
