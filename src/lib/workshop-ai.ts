/**
 * Nonsecret Workshop AI settings shared by the site API and the admin UI.
 * File I/O and throwing validation live in `workshop-ai-policy.ts`; this module
 * is import-safe for the browser bundle (no node imports).
 */

export const WORKSHOP_AI_DEFAULTS = {
  enabled: false,
  provider: 'openrouter',
  generationProvider: 'openrouter',
  guardProvider: 'openrouter',
  transcriptionProvider: 'openrouter',
  providers: [],
  generationModel: 'meta/muse-spark-1.3-contributor',
  guardModel: 'typesafe/jev-1.13',
  transcriptionModel: 'openai/whisper-1',
  cleanupModel: '',
  cleanupProvider: 'openrouter',
  maxBlocks: 16384,
  blocksPerTick: 2048,
  minimumBuildTicks: 80,
  applyBudgetMs: 8,
  hourlyRequestLimit: 360,
  hourlyPlayerRequestLimit: 60,
  maxHourlyBuilders: 256,
  generationMaxPricePromptUsdPerM: 0.1,
  generationMaxPriceCompletionUsdPerM: 0.2,
  inputGuardEnabled: false,
} as const

export const WORKSHOP_AI_PROVIDERS = ['openrouter', 'vercel-gateway'] as const

export type WorkshopAiProvider = (typeof WORKSHOP_AI_PROVIDERS)[number]

/** Custom registry entry: an OpenAI-compatible endpoint the owner adds. */
export type WorkshopAiCustomProvider = {
  id: string
  label: string
  baseUrl: string
}

/** Registry id shape, shared with the workshop gate; at most 8 custom entries. */
export const WORKSHOP_AI_PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
export const WORKSHOP_AI_MAX_PROVIDERS = 8

// Custom ids whose `<id>-key.json` status file would collide with a preset's:
// `ai` → ai-key.json (OpenRouter), `ai-gateway` → ai-gateway-key.json.
export const WORKSHOP_AI_RESERVED_IDS: readonly string[] = ['ai', 'ai-gateway']

export const isWorkshopAiProviderId = (value: unknown): value is string =>
  typeof value === 'string' && WORKSHOP_AI_PROVIDER_ID.test(value)

// shortcut: https-only; revisit when cliproxy is connected (it may be local http).
export function isWorkshopAiBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
}

/**
 * Controller key-status file per provider id. Presets keep their current names;
 * custom ids use `<id>-key.json`. Validate the id before joining paths.
 */
export const workshopAiKeyStatusFile = (provider: string): string =>
  provider === 'openrouter'
    ? 'ai-key.json'
    : provider === 'vercel-gateway'
      ? 'ai-gateway-key.json'
      : `${provider}-key.json`

export type WorkshopAiSettings = {
  schema: 1
  revision: number
  enabled: boolean
  provider: WorkshopAiProvider
  generationProvider: string
  guardProvider: string
  transcriptionProvider: string
  providers: WorkshopAiCustomProvider[]
  generationModel: string
  guardModel: string
  transcriptionModel: string
  cleanupModel: string
  cleanupProvider: string
  maxBlocks: number
  blocksPerTick: number
  minimumBuildTicks: number
  applyBudgetMs: number
  hourlyRequestLimit: number
  hourlyPlayerRequestLimit: number
  maxHourlyBuilders: number
  generationMaxPricePromptUsdPerM: number
  generationMaxPriceCompletionUsdPerM: number
  inputGuardEnabled: boolean
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
