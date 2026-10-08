/**
 * Admin console navigation: three task groups, a role-aware default tab and a
 * permitted-hash fallback. Pure (no DOM), so it is unit-testable without a
 * browser. Tab labels stay in admin.astro's own `data-tab`; this module only
 * orders tabs and decides which one opens.
 */
export type NavTab = { id: string; perm: string }
export type NavGroup = { label: string; tabs: NavTab[] }

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Операции',
    tabs: [
      { id: 'overview', perm: 'view' },
      { id: 'players', perm: 'moderate' },
      { id: 'matches', perm: 'view' },
    ],
  },
  {
    label: 'Игра и карты',
    tabs: [
      { id: 'settings', perm: 'settings' },
      { id: 'weapons', perm: 'settings' },
      { id: 'kits', perm: 'settings' },
      { id: 'workshop', perm: 'view' },
      { id: 'stats', perm: 'stats' },
    ],
  },
  {
    label: 'Управление',
    tabs: [
      { id: 'health', perm: 'diagnostics' },
      { id: 'team', perm: 'roles' },
      { id: 'journal', perm: 'audit' },
      { id: 'console', perm: 'rcon-raw' },
    ],
  },
]

/** Tab ids the permission list may open, in navigation order. */
export function visibleTabs(permissions: string[]): string[] {
  const perms = new Set(permissions)
  return NAV_GROUPS.flatMap((group) => group.tabs)
    .filter((tab) => perms.has(tab.perm))
    .map((tab) => tab.id)
}

/** Where a role lands with an empty or forbidden hash. Never a hidden tab. */
export function defaultTab(role: string | null, permissions: string[]): string {
  const visible = visibleTabs(permissions)
  const first = role === 'builder' ? 'workshop' : role === 'moderator' ? 'players' : 'overview'
  return visible.find((id) => id === first) ?? visible[0] ?? 'overview'
}

/** A hash nobody may open falls back to the role default instead of leaking the section. */
export function resolveTab(role: string | null, permissions: string[], hash: string): string {
  const visible = visibleTabs(permissions)
  return visible.includes(hash) ? hash : defaultTab(role, permissions)
}
