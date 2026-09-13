import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faces, parts } from '../src/lib/skin3d.ts';

test('грани головы берутся из стандартной развёртки 8×8×8', () => {
  const uv = faces(0, 0, 8, 8, 8).map(f => [f.u, f.v, f.w, f.h]);
  assert.deepEqual(uv, [[8, 8, 8, 8], [24, 8, 8, 8], [0, 8, 8, 8], [16, 8, 8, 8], [8, 0, 8, 8], [16, 0, 8, 8]]);
  assert.deepEqual(faces(0, 0, 10, 16, 1).map(f => [f.u, f.v]), [[1, 1], [12, 1], [0, 1], [11, 1], [1, 0], [11, 0]]);
});

test('тонкая модель сдвигает правую руку, старый скин зеркалит конечности', () => {
  const slim = parts(true, false);
  assert.equal(slim[2].x, 1);
  assert.equal(slim[3].W, 3);
  const legacy = parts(false, true);
  assert.ok(legacy[3].mirror && legacy[5].mirror);
  assert.deepEqual([legacy[3].u, legacy[3].v], [40, 16]);
  assert.ok(legacy.slice(1).every(p => !p.over));
  assert.ok(parts(false, false).every(p => p.over));
});
