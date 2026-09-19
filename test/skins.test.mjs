import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfileSkin, resolveSkins, DEFAULT_SKIN } from '../src/lib/skins.ts';

const uuid = 'acdec301-ecbd-3e60-8cfb-529c368a71bc';
const profile = textures => ({ name: 'Shihiradze', properties: [{ name: 'textures', value: Buffer.from(JSON.stringify({ textures })).toString('base64') }] });
const skin = { SKIN: { url: 'http://textures.minecraft.net/texture/test', metadata: { model: 'slim' } }, CAPE: { url: 'https://textures.minecraft.net/texture/cape' } };

test('как в лаунчере: Drasl → Mojang по нику → ванильный Steve', async () => {
  for (const [responses, expected, calls] of [
    [[profile(skin)], 'https://textures.minecraft.net/texture/test', 1],
    [[profile({}), { id: 'a'.repeat(32), name: 'Shihiradze' }, profile(skin)], 'https://textures.minecraft.net/texture/test', 3],
    [[profile({}), null], DEFAULT_SKIN.url, 2],
    [[profile({}), { id: 'a'.repeat(32), name: 'SomeoneElse' }], DEFAULT_SKIN.url, 2],
  ]) {
    const urls = [];
    const result = await resolveProfileSkin(uuid, async url => { urls.push(url); return Response.json(responses[urls.length - 1]); });
    assert.equal(result.url, expected);
    assert.equal(urls.length, calls);
    if (calls > 1) assert.equal(urls[1], 'https://api.mojang.com/users/profiles/minecraft/Shihiradze');
    if (expected !== DEFAULT_SKIN.url) {
      assert.equal(result.slim, true);
      assert.equal(result.capeUrl, skin.CAPE.url);
    } else assert.equal(result.slim, false);
  }
  assert.deepEqual(await resolveProfileSkin(uuid, async () => { throw new Error('offline'); }), DEFAULT_SKIN);
  const found = await resolveSkins([uuid], 100, async () => Response.json(profile({})));
  assert.deepEqual(found.get(uuid), DEFAULT_SKIN);
});
