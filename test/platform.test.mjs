import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPlatform, launcherDownload } from '../src/lib/platform.ts';

const links = { windows: 'https://example.test/setup.exe', linux: 'https://example.test/game.AppImage', macosArm: 'https://example.test/arm.dmg' };

for (const [name, ua, hint, expected] of [
  ['Windows Firefox', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/142.0', '', 'windows'],
  ['Linux Firefox', 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0', '', 'linux'],
  ['Chromium client hint', '', '"Linux"', 'linux'],
  ['Mac Safari', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', '', 'macos'],
  ['Android must not match Linux', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140.0.0.0 Mobile Safari/537.36', '"Android"', 'mobile'],
  ['iPad desktop UA must not match Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', '', 'mobile'],
  ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', '', 'mobile'],
  ['ChromeOS', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/140.0.0.0', '', 'unknown'],
  ['unknown browser', 'curl/8.0.0', '', 'unknown'],
]) {
  test(name, () => {
    const platform = detectPlatform(ua, hint);
    assert.equal(platform, expected);
    const action = launcherDownload(platform, links);
    if (platform === 'windows') assert.equal(action.href, links.windows);
    else if (platform === 'linux') assert.equal(action.href, links.linux);
    else if (platform === 'macos') assert.equal(action.href, links.macosArm);
    else assert.equal(action.href, '#download', 'unsupported/unknown platforms must not download an exe');
  });
}

test('Mac downloads the Apple Silicon build and says so', () => {
  assert.match(launcherDownload('macos', links).note, /Apple Silicon/);
});
