import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NAV_GROUPS, visibleTabs, defaultTab, resolveTab } from '../src/lib/admin-navigation.ts'

const VIEW = ['view']
const MOD = ['view', 'moderate', 'mode', 'message']
const ADMIN = [
  ...MOD,
  'ban',
  'maintenance',
  'recover',
  'settings',
  'stats',
  'audit',
  'roles',
  'workshop',
  'diagnostics',
]
const OWNER = [...ADMIN, 'roles-admin', 'rcon-raw']

test('groups cover every section once, nav order is operations first', () => {
  const ids = NAV_GROUPS.flatMap((g) => g.tabs.map((t) => t.id))
  assert.deepEqual(ids, [
    'overview',
    'players',
    'matches',
    'settings',
    'weapons',
    'kits',
    'workshop',
    'stats',
    'health',
    'team',
    'journal',
    'console',
  ])
  assert.deepEqual(
    NAV_GROUPS.map((g) => g.label),
    ['Операции', 'Игра и карты', 'Управление'],
  )
})

test('builder: overview, matches and readonly workshop; default is workshop', () => {
  assert.deepEqual(visibleTabs(VIEW), ['overview', 'matches', 'workshop'])
  assert.equal(defaultTab('builder', VIEW), 'workshop')
  // A forbidden hash falls back without exposing the hidden section.
  assert.equal(resolveTab('builder', VIEW, 'players'), 'workshop')
  assert.equal(resolveTab('builder', VIEW, 'console'), 'workshop')
  assert.equal(resolveTab('builder', VIEW, ''), 'workshop')
  assert.equal(resolveTab('builder', VIEW, 'workshop'), 'workshop')
  assert.equal(resolveTab('builder', VIEW, 'matches'), 'matches')
})

test('moderator: players default, no settings/weapon/stats/roles/diagnostics', () => {
  assert.deepEqual(visibleTabs(MOD), ['overview', 'players', 'matches', 'workshop'])
  assert.equal(defaultTab('moderator', MOD), 'players')
  assert.equal(resolveTab('moderator', MOD, 'settings'), 'players')
  assert.equal(resolveTab('moderator', MOD, 'players'), 'players')
})

test('admin and owner: overview default; console stays owner-only', () => {
  assert.equal(defaultTab('admin', ADMIN), 'overview')
  assert.equal(defaultTab('owner', OWNER), 'overview')
  assert.equal(visibleTabs(ADMIN).includes('console'), false)
  assert.equal(visibleTabs(OWNER).includes('console'), true)
  assert.equal(resolveTab('owner', OWNER, 'console'), 'console')
  assert.equal(resolveTab('admin', ADMIN, 'console'), 'overview')
  assert.equal(resolveTab('owner', OWNER, 'no-such-tab'), 'overview')
})

test('unknown hash or role never resolves to a hidden tab', () => {
  for (const hash of ['settings', '#settings', 'weapons', 'team']) {
    const tab = resolveTab('moderator', MOD, hash)
    assert.ok(visibleTabs(MOD).includes(tab), `${hash} leaked to ${tab}`)
  }
  assert.equal(resolveTab(null, VIEW, 'players'), 'overview')
})
