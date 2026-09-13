import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentials, drasl, draslError, importMojangSkin, pngError, readJson, route, sameOrigin } from '../src/lib/account.ts';

const png = (width, height, size = 33) => {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

const rejection = (fn) => {
  try { fn(); } catch (error) { return error; }
  assert.fail('ожидалась ошибка');
};

const stubFetch = (impl) => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return impl(url, init);
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
};

test('никнейм и пароль проверяются до похода в Drasl', async () => {
  assert.deepEqual(credentials({ username: 'Steve_42', password: '12345678' }), { username: 'Steve_42', password: '12345678' });
  for (const username of ['ab', 'a'.repeat(17), 'bad name', 'Стив', 42]) {
    const error = rejection(() => credentials({ username, password: '12345678' }));
    assert.equal(error.status, 400, String(username));
    assert.match((await error.json()).error, /3–16 символов/);
  }
  assert.equal(rejection(() => credentials({ username: 'Steve', password: '1234567' })).status, 400);
  assert.equal(rejection(() => credentials(null)).status, 400);
});

test('скин — PNG до 1 МиБ размером 64×64 или 64×32, плащ — любой PNG', () => {
  assert.equal(pngError(png(64, 64), true), null);
  assert.equal(pngError(png(64, 32), true), null);
  assert.match(pngError(png(64, 48), true), /64×64/);
  assert.match(pngError(png(128, 128), true), /64×64/);
  assert.equal(pngError(png(64, 32), false), null);
  assert.match(pngError(new TextEncoder().encode('GIF89a not a png at all!!'), false), /PNG/);
  assert.match(pngError(png(64, 64, 1_048_577), true), /1 МиБ/);
});

test('тело без Content-Length обрывается на лимите, а не читается целиком', async () => {
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(1024)); } });
  const request = new Request('http://site/api/account/login', { method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/json' } });
  const error = await readJson(request).then(() => assert.fail('ожидалась ошибка'), (e) => e);
  assert.equal(error.status, 413);
});

test('изменяющий запрос принимается только с Origin этого же хоста', async () => {
  const request = (headers) => new Request('http://modpack.nether.pp.ua/api/account/login', { method: 'POST', headers });
  assert.equal(sameOrigin(request({ origin: 'https://modpack.nether.pp.ua', host: 'modpack.nether.pp.ua' })), true, 'за nginx протоколы расходятся');
  assert.equal(sameOrigin(request({ origin: 'https://evil.example', host: 'modpack.nether.pp.ua' })), false);
  assert.equal(sameOrigin(request({ origin: 'https://modpack.nether.pp.ua.evil.example' })), false);
  assert.equal(sameOrigin(request({ origin: 'null' })), false);
  assert.equal(sameOrigin(request({})), false, 'без Origin не пускаем');

  let called = false;
  const handler = route(async () => { called = true; return new Response(); });
  const response = await handler({ request: request({ origin: 'https://evil.example' }) });
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test('ошибки Drasl переводятся, неизвестные показываются как есть', () => {
  assert.equal(draslError(400, 'That username is taken.'), 'Этот никнейм уже занят.');
  assert.equal(draslError(401, 'Incorrect password.'), 'Неверный никнейм или пароль.');
  assert.equal(draslError(401, 'User not found.'), 'Неверный никнейм или пароль.');
  assert.match(draslError(400, 'Invalid password: must be longer than 8 characters'), /не короче 8/);
  assert.match(draslError(400, 'Error using that skin: unexpected EOF'), /скина/);
  assert.match(draslError(429, 'rate limit exceeded'), /Слишком много/);
  assert.equal(draslError(400, 'Something new.'), 'Something new.');
  assert.match(draslError(500), /недоступен/);
});

test('запрос к Drasl несёт токен, а ошибка не раскрывает его', async () => {
  process.env.DRASL_URL = 'http://drasl.test/';
  const stub = stubFetch(async () => Response.json({ message: 'Unknown API token' }, { status: 401 }));
  try {
    const error = await drasl('/user', { token: 'secret-token' }).then(() => assert.fail('ожидалась ошибка'), (e) => e);
    assert.equal(stub.seen[0].url, 'http://drasl.test/drasl/api/v3/user');
    assert.equal(stub.seen[0].init.headers.Authorization, 'Bearer secret-token');
    assert.equal(error.status, 401);
    const body = await error.text();
    assert.match(body, /Сессия истекла/);
    assert.doesNotMatch(body, /secret-token/);
  } finally {
    stub.restore();
    delete process.env.DRASL_URL;
  }
  const down = stubFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    const error = await drasl('/login', { method: 'POST', body: {} }).catch((e) => e);
    assert.equal(error.status, 502);
  } finally {
    down.restore();
  }
});

test('скин с Mojang подтягивается только в пустой лицензионный аккаунт', async () => {
  process.env.DRASL_URL = 'http://drasl.test';
  const user = (username, skinUrl = null) => ({ username, players: [{ uuid: `uuid-${username}`, name: username, skinUrl, capeUrl: null }] });
  const textures = Buffer.from(JSON.stringify({ textures: { SKIN: { url: 'http://textures.minecraft.net/texture/abc', metadata: { model: 'slim' } } } })).toString('base64');
  const stub = stubFetch(async (url, init) => {
    if (url === 'https://api.mojang.com/users/profiles/minecraft/Alex') return Response.json({ id: 'a'.repeat(32), name: 'alex' });
    if (url === 'https://api.mojang.com/users/profiles/minecraft/Nobody') return new Response(null, { status: 204 });
    if (url === `https://sessionserver.mojang.com/session/minecraft/profile/${'a'.repeat(32)}`) return Response.json({ properties: [{ name: 'textures', value: textures }] });
    if (url === 'http://textures.minecraft.net/texture/abc') return new Response(png(64, 64));
    if (url === 'http://drasl.test/drasl/api/v3/players/uuid-Alex' && init.method === 'PATCH') return Response.json({});
    if (url === 'http://drasl.test/drasl/api/v3/user') return Response.json(user('Alex', 'http://drasl.test/texture/skin/x.png'));
    assert.fail(`неожиданный запрос ${url}`);
  });
  try {
    const refreshed = await importMojangSkin('token', user('Alex'));
    const patch = JSON.parse(stub.seen.find(({ init }) => init?.method === 'PATCH').init.body);
    assert.equal(patch.skinBase64, Buffer.from(png(64, 64)).toString('base64'));
    assert.equal(patch.skinModel, 'slim');
    assert.equal(patch.capeBase64, undefined);
    assert.equal(refreshed.players[0].skinUrl, 'http://drasl.test/texture/skin/x.png');

    stub.seen.length = 0;
    const custom = user('Alex', 'http://drasl.test/texture/skin/mine.png');
    assert.equal(await importMojangSkin('token', custom), custom);
    assert.equal(stub.seen.length, 0, 'при своём скине Mojang не трогаем');

    const pirate = user('Nobody');
    assert.equal(await importMojangSkin('token', pirate), pirate);
    assert.equal(await importMojangSkin('token', pirate), pirate);
    assert.equal(stub.seen.length, 1, 'без PATCH, а повтор берётся из кэша');
  } finally {
    stub.restore();
    delete process.env.DRASL_URL;
  }
});
