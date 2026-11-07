# SITE95-U1 evidence (blockfield-site#95, U1 only)

Postgres is the only store. `node:sqlite` survives solely inside the one-shot
offline backup importer (`StatsStore.openBackup()`, used by
`scripts/migrate-stats.mjs`); the running app never serves from SQLite.
Prod volumes untouched (coordinator step).

- `src/lib/database.ts`: pg-only; non-pg URLs throw unless opened as a backup.
- `src/lib/stats.ts`: `StatsStore.open()` accepts pg URLs only; `openBackup()`
  reads current-schema (v7) SQLite backups, fresh scratch, or refuses older files
  explicitly. Legacy in-place upgrades (v1..v6), `json_extract` branches, and
  `BLOCKFIELD_STATS_DB` fallback removed.
- `scripts/migrate-stats.mjs`: verified export path (empty-target guard, per-table
  digest verification, sequence fixups); `cp-staff-export.mjs` CLI routes sqlite
  paths through `openBackup()`.
- Tests: sqlite-backed paths deleted (schema-upgrade, file-reopen); backup-migration,
  legacy-import apply path, session-secret boot, and crash-orphan tests run on pg
  (`BLOCKFIELD_TEST_DATABASE_URL`, isolated schemas).
- Docs: `docs/statistics.md` (pg-only, migration, tests), `docs/admin.md` env.

Verification (local podman postgres:18, same credentials as CI):
- `pnpm typecheck`: 0 errors.
- `pnpm test`: 547 pass, 0 fail (incl. "SQLite backup migrates exactly...").
- `pnpm lint`, `pnpm stylelint`, `pnpm format:check`: clean.
