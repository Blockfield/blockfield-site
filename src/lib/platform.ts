export type Platform = 'windows' | 'linux' | 'macos' | 'mobile' | 'unknown';

export function detectPlatform(userAgent = '', clientPlatform = ''): Platform {
  if (/Android|iPhone|iPad|iPod|Windows Phone|Mobile|IEMobile/i.test(userAgent)
    || /Android|iOS/i.test(clientPlatform)) return 'mobile';
  if (/CrOS/i.test(userAgent)) return 'unknown';

  for (const value of [clientPlatform, userAgent]) {
    if (/Windows|Win32|Win64/i.test(value)) return 'windows';
    if (/Macintosh|Mac OS|macOS|MacIntel/i.test(value)) return 'macos';
    if (/Linux|Ubuntu/i.test(value)) return 'linux';
  }
  return 'unknown';
}

export function launcherDownload(platform: Platform, links: { windows: string; linux: string }) {
  switch (platform) {
    case 'windows':
      return { href: links.windows, label: 'СКАЧАТЬ ДЛЯ WINDOWS', note: 'Лаунчер для Windows x64 · установщик .exe' };
    case 'linux':
      return { href: links.linux, label: 'СКАЧАТЬ ДЛЯ LINUX', note: 'Лаунчер для Linux x86_64 · AppImage' };
    case 'macos':
      return { href: '#macos-download', label: 'ВЫБРАТЬ ВЕРСИЮ ДЛЯ MAC', note: 'Лаунчер для macOS · выберите Apple Silicon или Intel.' };
    case 'mobile':
      return { href: '#download', label: 'ВЫБРАТЬ ВЕРСИЮ ДЛЯ ПК', note: 'Лаунчер работает на компьютерах с Windows, Linux и macOS. Выберите файл для компьютера.' };
    default:
      return { href: '#download', label: 'ВЫБРАТЬ ВЕРСИЮ', note: 'Выберите Windows, Linux или macOS.' };
  }
}
