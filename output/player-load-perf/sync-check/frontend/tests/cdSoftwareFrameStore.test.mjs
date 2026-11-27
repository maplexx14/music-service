import assert from 'node:assert/strict';
import test from 'node:test';
import { cdSoftwareFrameStore } from '../src/utils/cdSoftwareFrameStore.js';

test('compressed caches survive scene disposal but retain only two layouts', async () => {
  const blobs = [new Blob(['original pixels'])];
  await cdSoftwareFrameStore.put('first', blobs);
  await cdSoftwareFrameStore.put('second', blobs);
  assert.equal((await cdSoftwareFrameStore.get('first')).blobs[0], blobs[0]);
  await cdSoftwareFrameStore.put('third', blobs);
  assert.equal(await cdSoftwareFrameStore.get('second'), null);
  assert.ok(await cdSoftwareFrameStore.get('first'));
  assert.ok(await cdSoftwareFrameStore.get('third'));
});

test('an oversized compressed cache cannot evict the usable small caches', async () => {
  await cdSoftwareFrameStore.put('oversized', [new Blob([new Uint8Array(12 * 1024 * 1024 + 1)])]);
  assert.equal(await cdSoftwareFrameStore.get('oversized'), null);
  assert.ok(await cdSoftwareFrameStore.get('first'));
});
