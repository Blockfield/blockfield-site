/** Как в лаунчере: Drasl → Mojang по нику → ванильный Steve. */
export type Skin = { url: string; slim: boolean; capeUrl?: string };
export const DEFAULT_SKIN: Skin = { url: '/skins/steve.png', slim: false };

const TTL = 600_000;
const cache = new Map<string, { skin: Skin | null; until: number }>();
const pending = new Map<string, Promise<Skin | null>>();

export const draslBase = () => (process.env.DRASL_URL || 'https://skins.blockfield.pro').replace(/\/+$/, '');

/** Ответ Yggdrasil: properties[textures] — base64 от JSON с URL скина. */
export function skinFromProfile(profile: any): Skin | null {
  const encoded = profile?.properties?.find((p: any) => p?.name === 'textures')?.value;
  if (typeof encoded !== 'string') return null;
  try {
    const textures = JSON.parse(Buffer.from(encoded, 'base64').toString()).textures;
    const skin = textures?.SKIN;
    const url = (value: unknown) => typeof value === 'string' && /^https?:\/\//.test(value) ? value.replace('http://textures.minecraft.net/', 'https://textures.minecraft.net/') : undefined;
    const skinUrl = url(skin?.url);
    return skinUrl ? { url: skinUrl, slim: skin.metadata?.model === 'slim', capeUrl: url(textures?.CAPE?.url) } : null;
  } catch { return null; }
}

export async function resolveProfileSkin(uuid: string, fetcher: typeof fetch = fetch): Promise<Skin> {
  const json = async (url: string) => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(5000) });
    return response.ok ? response.json() : null;
  };
  try {
    const profile = await json(`${draslBase()}/session/minecraft/profile/${uuid.replaceAll('-', '')}`);
    const custom = skinFromProfile(profile);
    if (custom) return custom;
    if (!/^[A-Za-z0-9_]{1,16}$/.test(profile?.name ?? '')) return DEFAULT_SKIN;
    const mojang = await json(`https://api.mojang.com/users/profiles/minecraft/${profile.name}`);
    if (!/^[0-9a-f]{32}$/i.test(mojang?.id ?? '') || mojang?.name?.toLowerCase() !== profile.name.toLowerCase()) return DEFAULT_SKIN;
    return skinFromProfile(await json(`https://sessionserver.mojang.com/session/minecraft/profile/${mojang.id}`)) ?? DEFAULT_SKIN;
  } catch { return DEFAULT_SKIN; }
}

/**
 * Ждём не дольше `budgetMs`: голова — украшение строки, а не её содержание, и не должна задерживать
 * отрисовку страницы. Незавершённые запросы продолжаются и наполняют кэш для следующего рендера.
 * Промахи кэшируются так же, как попадания, чтобы не опрашивать Drasl на каждый рендер.
 */
export async function resolveSkins(uuids: string[], budgetMs = 1200, fetcher: typeof fetch = fetch): Promise<Map<string, Skin>> {
  const now = Date.now(), found = new Map<string, Skin>(), wait: Promise<unknown>[] = [];
  for (const uuid of new Set(uuids)) {
    const hit = cache.get(uuid);
    if (hit && hit.until > now) { if (hit.skin) found.set(uuid, hit.skin); continue; }
    let lookup = pending.get(uuid);
    if (!lookup) {
      lookup = resolveProfileSkin(uuid, fetcher)
        .then(skin => { cache.set(uuid, { skin, until: Date.now() + TTL }); return skin; })
        .catch(() => null).finally(() => pending.delete(uuid));
      pending.set(uuid, lookup);
    }
    wait.push(lookup.then(skin => { if (skin) found.set(uuid, skin); }));
  }
  if (!wait.length) return found;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(wait), new Promise(resolve => { timer = setTimeout(resolve, budgetMs); })]);
  clearTimeout(timer);
  return new Map(uuids.map(uuid => [uuid, found.get(uuid) ?? DEFAULT_SKIN]));
}
