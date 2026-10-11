/**
 * Nonsecret Workshop AI settings shared by the site API and the admin UI.
 * File I/O and throwing validation live in `workshop-ai-policy.ts`; this module
 * is import-safe for the browser bundle (no node imports).
 */

export const WORKSHOP_AI_DEFAULTS = {
  enabled: false,
  generationModel: 'meta/muse-spark-1.3-contributor',
  guardModel: 'typesafe/jev-1.13',
  transcriptionModel: 'elevenlabs/scribe-v2',
} as const

export type WorkshopAiSettings = {
  schema: 1
  revision: number
  enabled: boolean
  generationModel: string
  guardModel: string
  transcriptionModel: string
}

// Same shape as the server's check: vendor/name with an optional :variant such as :free.
export const WORKSHOP_AI_MODEL = /^[a-zA-Z0-9._-]{1,64}\/[a-zA-Z0-9._/:-]{1,126}$/
// Voice reserves a per-second tariff; the server bills only these two models that way.
export const WORKSHOP_AI_TRANSCRIPTION_MODELS = [
  'elevenlabs/scribe-v2',
  'openai/whisper-1',
] as const
export const WORKSHOP_AI_GUARD_MODEL = /^typesafe\/jev-[a-zA-Z0-9._-]{1,64}$/
export const WORKSHOP_AI_KEY = /^[\x21-\x7e]{20,2048}$/

export const isWorkshopAiModel = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 128 && WORKSHOP_AI_MODEL.test(value)

export const isWorkshopAiTranscriptionModel = (value: unknown): value is string =>
  typeof value === 'string' &&
  (WORKSHOP_AI_TRANSCRIPTION_MODELS as readonly string[]).includes(value)

export const isWorkshopAiGuardModel = (value: unknown): value is string =>
  typeof value === 'string' && WORKSHOP_AI_GUARD_MODEL.test(value)

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
