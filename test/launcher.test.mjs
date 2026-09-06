import { test } from 'node:test';
import assert from 'node:assert/strict';

// Кэш живёт в модуле, поэтому каждому сценарию нужен свой экземпляр.
const fresh = (tag) => import(`../src/lib/launcher.ts?${tag}`);

const release = {
  tag_name: 'launcher-v9.9.9',
  assets: [
    { name: 'blockfield-launcher_9.9.9_x64-setup.exe', browser_download_url: 'https://example/setup.exe' },
    { name: 'blockfield-launcher_9.9.9_amd64.AppImage', browser_download_url: 'https://example/app.AppImage' },
  ],
};

const stubFetch = (impl) => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (...args) => {
    calls += 1;
    return impl(...args);
  };
  return {
    calls: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

test('релиз разбирается и второй запрос идёт из кэша', async () => {
  const stub = stubFetch(async () => new Response(JSON.stringify(release), { status: 200 }));
  try {
    const { latestLauncher } = await fresh('ok');
    const first = await latestLauncher();
    assert.equal(first.version, 'v9.9.9');
    assert.equal(first.windows, 'https://example/setup.exe');
    assert.equal(first.linux, 'https://example/app.AppImage');

    await latestLauncher();
    assert.equal(stub.calls(), 1, 'кэш не должен ходить в GitHub повторно');
  } finally {
    stub.restore();
  }
});

test('сбой API не роняет страницу и не долбит GitHub на каждый запрос', async () => {
  const stub = stubFetch(async () => new Response('rate limited', { status: 403 }));
  try {
    const { latestLauncher } = await fresh('fail');
    const result = await latestLauncher();
    assert.equal(result.version, '');
    assert.match(result.windows, /\/releases\/latest$/);

    await latestLauncher();
    assert.equal(stub.calls(), 1, 'после сбоя тоже держим паузу до конца TTL');
  } finally {
    stub.restore();
  }
});

test('параллельные запросы схлопываются в один поход к API', async () => {
  let resolveBody;
  const gate = new Promise((resolve) => (resolveBody = resolve));
  const stub = stubFetch(async () => {
    await gate;
    return new Response(JSON.stringify(release), { status: 200 });
  });
  try {
    const { latestLauncher } = await fresh('inflight');
    const both = Promise.all([latestLauncher(), latestLauncher()]);
    resolveBody();
    const [a, b] = await both;
    assert.equal(a.version, 'v9.9.9');
    assert.deepEqual(a, b);
    assert.equal(stub.calls(), 1);
  } finally {
    stub.restore();
  }
});
