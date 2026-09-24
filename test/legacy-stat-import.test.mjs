import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertLegacy, importManifest } from '../scripts/import-legacy-stats.mjs';
import { StatsStore, filters } from '../src/lib/stats.ts';
const serverId = '00000000-0000-4000-8000-000000000001';
const uuid = '00000000-0000-4000-8000-000000000002';
const context = { serverId, sessionPurpose: 'gameplay', modeId: 'room', mapId: 'fields' };
function fixture() { return {
  GameMode: 'Campaign', CampaignId: 'room_1', MatchNumber: 1, MapName: 'Степи',
  StartDate: 'Mon Jun 01 2026 12:00:00 GMT+0300 (EEST)', EndDate: 'Mon Jun 01 2026 12:01:00 GMT+0300 (EEST)',
  MatchEndStatus: 'Normal', Winner: 'RedTeam', Players: [{ Uuid: uuid, Name: 'Player', Team: 'RedTeam', Score: 10,
    Kills: 1, Deaths: 0, PointTime: 10, MaxKillstreak: 1, Captures: 1, Neutralizations: 0, Suicides: 0, TeamKills: 0,
    Classes: { 'Штурмовик (AK)': { Time: 60, Kills: 1, Deaths: 0, PointTime: 10 } } }], ArchivedPlayers: []
}; }
const classMap = { 'Штурмовик (AK)': { classId: 'assault', variantId: '0' } };
test('legacy import validates then replays safely, without MMR, and rejects unsafe sources', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bf-legacy-import-'));
  try {
    const raw = fixture();
    const result = convertLegacy(raw, context, classMap);
    assert.equal(result.startedAt, '2026-06-01T09:00:00.000Z');
    assert.equal(result.participants[0].playSeconds, 60);
    assert.equal(convertLegacy(Object.fromEntries(Object.entries(raw).reverse()), context, classMap).eventId, result.eventId);
    for (const purpose of ['test', 'playtest', 'training', 'lobby', 'workshop']) {
      assert.throws(() => convertLegacy({ ...raw, SessionPurpose: purpose }, context, classMap), /Non-gameplay/);
      assert.throws(() => convertLegacy(raw, { ...context, sessionPurpose: purpose }, classMap), /provenance/);
    }
    assert.throws(() => convertLegacy(raw, context), /Unknown legacy class/);
    assert.throws(() => convertLegacy({ ...raw, ArchivedPlayers: raw.Players }, context, classMap), /Ambiguous/);
    assert.throws(() => convertLegacy({ ...raw, StartDate: '2026-06-01 12:00' }, context, classMap), /offset/);
    assert.throws(() => convertLegacy({ ...raw, StartDate: 'Mon Feb 30 2026 12:00:00 GMT+0300 (EEST)' }, context, classMap), /Invalid legacy timestamp/);
    assert.throws(() => convertLegacy({ ...raw, MatchEndStatus: 'Unexpected' }, context, classMap), /finalization/);
    const bytes = JSON.stringify(raw), file = join(root, 'match.json'); writeFileSync(file, bytes);
    const manifest = join(root, 'manifest.json'), database = join(root, 'stats.sqlite');
    const doc = { serverId, classMap, files: [{ ...context, path: 'match.json', sha256: createHash('sha256').update(bytes).digest('hex') }] };
    writeFileSync(manifest, JSON.stringify(doc));
    assert.equal((await importManifest(manifest, database))[0].status, 'validated');
    assert.equal((await importManifest(manifest, database, true))[0].status, 'inserted');
    assert.equal((await importManifest(manifest, database, true))[0].status, 'duplicate');
    const store = await StatsStore.open(database);
    try {
      const board = await store.leaderboard(filters(new URLSearchParams()));
      assert.equal(board.total, 1); assert.equal(board.players[0].matches, 1); assert.equal(board.players[0].kills, 1);
      assert.equal(board.players[0].mmr, null);
    } finally { await store.close(); }
    writeFileSync(file, JSON.stringify({ ...raw, Winner: 'BlueTeam' }));
    assert.match((await importManifest(manifest, database, true))[0].error, /checksum/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
