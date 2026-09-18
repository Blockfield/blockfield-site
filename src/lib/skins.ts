/** Текстуры скинов из Drasl по UUID: для голов в списках и 3D-фигуры в профиле. */
export type Skin = { url: string; slim: boolean };

const TTL = 600_000;
const cache = new Map<string, { skin: Skin | null; until: number }>();
const pending = new Map<string, Promise<Skin | null>>();

export const draslBase = () => (process.env.DRASL_URL || 'https://skins.blockfield.pro').replace(/\/+$/, '');

/** Ответ Yggdrasil: properties[textures] — base64 от JSON с URL скина. */
export function skinFromProfile(profile: any): Skin | null {
  const encoded = profile?.properties?.find((p: any) => p?.name === 'textures')?.value;
  if (typeof encoded !== 'string') return null;
  try {
    const skin = JSON.parse(Buffer.from(encoded, 'base64').toString()).textures?.SKIN;
    return typeof skin?.url === 'string' && /^https?:\/\//.test(skin.url) ? { url: skin.url, slim: skin.metadata?.model === 'slim' } : null;
  } catch { return null; }
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
      lookup = fetcher(`${draslBase()}/session/minecraft/profile/${uuid.replaceAll('-', '')}`, { signal: AbortSignal.timeout(10_000) })
        .then(r => (r.ok ? r.json() : null)).then(skinFromProfile, () => null)
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
  return new Map(found);
}
