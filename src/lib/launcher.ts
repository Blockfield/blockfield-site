const RELEASES = 'https://github.com/netherg-io/blockfield-launcher-releases/releases';
const API = 'https://api.github.com/repos/netherg-io/blockfield-launcher-releases/releases/latest';

export type Launcher = { version: string; windows: string; linux: string };

const fallback: Launcher = { version: '', windows: `${RELEASES}/latest`, linux: `${RELEASES}/latest` };

// Аноним у GitHub API — 60 запросов в час на IP, поэтому SSR обязан кэшировать,
// иначе лендинг под нагрузкой скатится на fallback-ссылки.
const TTL = 10 * 60_000;
let cache: { at: number; value: Launcher } = { at: 0, value: fallback };
let inflight: Promise<Launcher> | null = null;

async function load(): Promise<Launcher> {
  const response = await fetch(API, {
    headers: { 'User-Agent': 'blockfield-site', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);
  const release = await response.json();
  // Имена ассетов содержат версию, поэтому /releases/latest/download/<имя> не работает.
  const asset = (suffix: string) =>
    release.assets?.find((a: { name: string }) => a.name.endsWith(suffix))?.browser_download_url;
  return {
    version: String(release.tag_name || '').replace('launcher-', ''),
    windows: asset('-setup.exe') || fallback.windows,
    linux: asset('.AppImage') || fallback.linux,
  };
}

export async function latestLauncher(): Promise<Launcher> {
  if (Date.now() - cache.at < TTL) return cache.value;
  inflight ??= load()
    .then((value) => {
      cache = { at: Date.now(), value };
      return value;
    })
    .catch(() => {
      // Держим прошлый успешный ответ и не долбим API на каждый запрос при сбое.
      cache = { at: Date.now(), value: cache.value };
      return cache.value;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export { RELEASES };
