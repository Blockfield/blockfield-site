const RELEASES = 'https://github.com/Blockfield/Blockfield-Launcher/releases';
const API = 'https://api.github.com/repos/Blockfield/Blockfield-Launcher/releases/latest';

export type Launcher = { version: string; windows: string; linux: string; macosArm: string; macosIntel: string };

const fallback: Launcher = { version: '', windows: `${RELEASES}/latest`, linux: `${RELEASES}/latest`, macosArm: `${RELEASES}/latest`, macosIntel: `${RELEASES}/latest` };

// У анонима к GitHub API 60 запросов в час на IP, но ответ 304 на условный запрос
// в лимит не идёт — а релиз меняется редко, так что почти каждая проверка бесплатна.
const TTL = 60_000;
// Сбой (в том числе исчерпанный лимит) отодвигает следующую попытку надолго.
const ERROR_TTL = 10 * 60_000;

let cache = { until: 0, value: fallback, etag: null as string | null, ok: false };
let inflight: Promise<Launcher> | null = null;

function parse(release: any): Launcher {
  // Имена ассетов содержат версию, поэтому /releases/latest/download/<имя> не работает.
  const asset = (suffix: string) =>
    release.assets?.find((a: { name: string }) => a.name.endsWith(suffix))?.browser_download_url;
  return {
    version: String(release.tag_name || '').replace('launcher-', ''),
    windows: asset('-setup.exe') || fallback.windows,
    linux: asset('.AppImage') || fallback.linux,
    macosArm: asset('_aarch64.dmg') || fallback.macosArm,
    macosIntel: asset('_x64.dmg') || fallback.macosIntel,
  };
}

async function refresh(): Promise<Launcher> {
  const headers: Record<string, string> = {
    'User-Agent': 'blockfield-site',
    Accept: 'application/vnd.github+json',
  };
  if (cache.etag) headers['If-None-Match'] = cache.etag;

  const response = await fetch(API, { headers, signal: AbortSignal.timeout(4000) });
  if (response.status === 304) {
    cache = { ...cache, until: Date.now() + TTL };
    return cache.value;
  }
  if (!response.ok) throw new Error(`GitHub API ${response.status}`);

  cache = {
    until: Date.now() + TTL,
    value: parse(await response.json()),
    etag: response.headers.get('etag'),
    ok: true,
  };
  return cache.value;
}

export async function latestLauncher(): Promise<Launcher> {
  if (Date.now() < cache.until) return cache.value;
  inflight ??= refresh()
    .catch(() => {
      cache = { ...cache, until: Date.now() + ERROR_TTL };
      return cache.value;
    })
    .finally(() => {
      inflight = null;
    });
  // Ждёт ответа только первый рендер после старта: дальше страница отдаётся
  // из кэша, а он обновляется фоном — короткий TTL ничего не стоит по времени.
  return cache.ok ? cache.value : inflight;
}

export { RELEASES };
