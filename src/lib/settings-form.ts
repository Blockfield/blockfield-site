export type SettingsForm = {
  pvpEnabled: string
  lobby: Record<string, string>
  rooms: Record<string, string>
  deathmatch: Record<string, string>
  /** Validated flat table (streak-table.ts); undefined = unchanged, [] = rewards off. */
  streakRewards?: {
    kills: number
    id: string
    count: number
    scale: boolean
    throwable_id?: string
    message?: string
  }[]
  classCosts?: Record<string, string>
  lockedClasses: string[]
  hadLocks: boolean
  balance: Record<string, Record<string, number | boolean>>
  /** `active: false` (the site default: "use the server's base file") omits the section entirely, even if it was set before. */
  parcool?: { active: boolean; actions: string[] }
}
export function settingsReceipt(
  revision: number,
  applied: { revision?: number; attemptedRevision?: number; errors?: string[] } | null | undefined,
) {
  if (
    applied?.errors?.length &&
    applied.attemptedRevision === revision &&
    (applied.revision ?? -1) < revision
  )
    return 'rejected'
  if ((applied?.revision ?? -1) >= revision) return applied?.errors?.length ? 'partial' : 'applied'
  return 'pending'
}
/**
 * PUT /api/admin/settings body from form values. Fields are prefilled with the server default, so a value equal to
 * its default is the same as leaving the field untouched: both mean "server default" and are left out of the body.
 */
export function settingsBody(
  expectedRevision: number,
  form: SettingsForm,
  defaults: Record<string, string> = {},
  cpRevisions: Record<string, number> = {},
) {
  const numbers = (values: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(values)
        .filter(([k, v]) => v !== '' && v !== defaults[k])
        .map(([k, v]) => [k, Number(v)]),
    )
  const lobby = {
    ...(form.pvpEnabled === '' || form.pvpEnabled === defaults.pvpEnabled
      ? {}
      : { pvpEnabled: form.pvpEnabled === 'true' }),
    ...numbers(form.lobby),
  }
  const rooms = numbers(form.rooms)
  const deathmatch = {
    ...numbers(form.deathmatch ?? {}),
    ...(form.streakRewards === undefined ? {} : { streakRewards: form.streakRewards }),
  }
  const balance = Object.fromEntries(
    Object.entries(form.balance).filter(([, v]) => Object.keys(v).length),
  )
  return {
    expectedRevision,
    ...(Object.keys(cpRevisions).length ? { cpRevisions } : {}),
    ...(form.classCosts
      ? {
          classCosts: Object.fromEntries(
            Object.entries(form.classCosts).map(([id, value]) => [id, Number(value)]),
          ),
        }
      : {}),
    ...(Object.keys(lobby).length ? { lobby } : {}),
    ...(Object.keys(rooms).length ? { rooms } : {}),
    ...(Object.keys(deathmatch).length ? { deathmatch } : {}),
    ...(form.lockedClasses.length || form.hadLocks ? { classLocks: form.lockedClasses } : {}),
    ...(Object.keys(balance).length ? { campaignBalance: balance } : {}),
    ...(form.parcool?.active ? { parcool: { allowedActions: form.parcool.actions } } : {}),
  }
}
