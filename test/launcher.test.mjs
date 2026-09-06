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

const ok = (body, etag) =>
  new Response(JSON.stringify(body), { status: 200, headers: etag ? { etag } : {} });

const stubFetch = (impl) => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init?.headers ?? {});
    return impl(url, init);
  };
  return {
    seen,
    calls: () => seen.length,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

test('релиз разбирается и второй запрос идёт из кэша', async () => {
  const stub = stubFetch(async () => ok(release));
  try {
    const { latestLauncher } = await fresh('ok');
    const first = await latestLauncher();
    assert.equal(first.version, 'v9.9.9');
    assert.equal(first.windows, 'https://example/setup.exe');
    assert.equal(first.linux, 'https://example/app.AppImage');

    await latestLauncher();
    assert.equal(stub.calls(), 1, 'внутри TTL в GitHub не ходим');
  } finally {
    stub.restore();
  }
});

test('после TTL проверка идёт условной, а 304 не теряет прошлый ответ', async () => {
  let stage = 0;
  const stub = stubFetch(async () => (stage++ === 0 ? ok(release, 'W/"abc"') : new Response(null, { status: 304 })));
  try {
    const { latestLauncher } = await fresh('etag');
    await latestLauncher();

    // Второй заход — уже за пределами TTL.
    const now = Date.now;
    Date.now = () => now() + 61_000;
    try {
      const stale = await latestLauncher();
      assert.equal(stale.version, 'v9.9.9', 'фоновое обновление отдаёт прошлый ответ сразу');
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      Date.now = now;
    }

    assert.equal(stub.calls(), 2);
    assert.equal(stub.seen[0]['If-None-Match'], undefined);
    assert.equal(stub.seen[1]['If-None-Match'], 'W/"abc"', '304 не расходует лимит только с этим заголовком');
    assert.equal((await latestLauncher()).version, 'v9.9.9');
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
    assert.equal(stub.calls(), 1, 'после сбоя выдерживаем длинную паузу');
  } finally {
    stub.restore();
  }
});

test('параллельные запросы схлопываются в один поход к API', async () => {
  let resolveBody;
  const gate = new Promise((resolve) => (resolveBody = resolve));
  const stub = stubFetch(async () => {
    await gate;
    return ok(release);
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
