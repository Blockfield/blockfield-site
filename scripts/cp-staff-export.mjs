import { StatsStore } from '../src/lib/stats.ts'
import { pathToFileURL } from 'node:url'

// Экспорт штата для разового импорта в control-plane: site rows are references
// only. The operator assigns internal account ids, binds Drasl<->CP identities
// out of band (never inferred from nicknames here) and seeds via admin provision.
// Usage: node --experimental-strip-types scripts/cp-staff-export.mjs "$BLOCKFIELD_DATABASE_URL"
export async function exportStaff(store) {
  const rows = await store.staff()
  return {
    generatedAt: new Date().toISOString(),
    scope: { environment: 'prod', backend: 'game', resource: '*' },
    note: 'references only: operator assigns internal ids and identity bindings',
    staff: rows.map((row) => ({
      draslUuid: row.uuid,
      name: row.name,
      role: row.role,
      maps: row.maps ?? null,
    })),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.argv[2] ?? process.env.BLOCKFIELD_DATABASE_URL
  if (!url || !/^postgres(?:ql)?:\/\//.test(url))
    throw new Error(
      'Usage: node --experimental-strip-types scripts/cp-staff-export.mjs "$BLOCKFIELD_DATABASE_URL"',
    )
  const store = await StatsStore.open(url)
  try {
    console.log(JSON.stringify(await exportStaff(store), null, 2))
  } finally {
    await store.close()
  }
}
