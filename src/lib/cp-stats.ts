/** CP-S8b shadow-read comparison for the stats/test-account transfer.
 * Read-only: compares the site result store against the central export and
 * resolves test eligibility with the control-plane classification as
 * authority. Never writes to either side (no dual writers); cutover keeps
 * this path until S9b retires the old writers. */

export type ResultRef = { serverId: string; eventId: string; digest: string }
export type ShadowDiff = {
  missingInCentral: Array<{ serverId: string; eventId: string }>
  missingLocally: Array<{ serverId: string; eventId: string }>
  digestMismatch: Array<{ serverId: string; eventId: string }>
}
export type Eligibility = { eligible: boolean; needsReview: boolean }

const refKey = (ref: { serverId: string; eventId: string }) => `${ref.serverId}/${ref.eventId}`

/** Reconcile result IDs/digests between the local store and the central
 * export. Returns IDs missing on either side plus digest conflicts; both
 * inputs are left untouched. */
export function shadowCompareResults(local: ResultRef[], central: ResultRef[]): ShadowDiff {
  const localById = new Map(local.map((ref) => [refKey(ref), ref]))
  const centralById = new Map(central.map((ref) => [refKey(ref), ref]))
  const missingInCentral: ShadowDiff['missingInCentral'] = []
  const missingLocally: ShadowDiff['missingLocally'] = []
  const digestMismatch: ShadowDiff['digestMismatch'] = []
  for (const [key, ref] of localById) {
    const other = centralById.get(key)
    if (!other) missingInCentral.push({ serverId: ref.serverId, eventId: ref.eventId })
    else if (other.digest !== ref.digest)
      digestMismatch.push({ serverId: ref.serverId, eventId: ref.eventId })
  }
  for (const [key, ref] of centralById)
    if (!localById.has(key)) missingLocally.push({ serverId: ref.serverId, eventId: ref.eventId })
  const byId = (
    a: { serverId: string; eventId: string },
    b: { serverId: string; eventId: string },
  ) => a.serverId.localeCompare(b.serverId) || a.eventId.localeCompare(b.eventId)
  return {
    missingInCentral: missingInCentral.sort(byId),
    missingLocally: missingLocally.sort(byId),
    digestMismatch: digestMismatch.sort(byId),
  }
}

/** Control-plane test classification is authoritative: a CP-marked test
 * account never rates, and an unknown classification fails closed (excluded
 * with needsReview) instead of guessing. */
export function resolveTestEligibility(
  localWouldRate: boolean,
  cpIsTest: boolean | null | undefined,
): Eligibility {
  if (!localWouldRate) return { eligible: false, needsReview: false }
  if (cpIsTest == null) return { eligible: false, needsReview: true }
  if (cpIsTest) return { eligible: false, needsReview: false }
  return { eligible: true, needsReview: false }
}
