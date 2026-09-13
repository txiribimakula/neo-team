import test from 'node:test';
import assert from 'node:assert/strict';
import { createCachedTokenProvider } from '../server/token-cache.js';

test('rejected tokens discard both the cached token and the authenticator', async () => {
  let instances = 0, acquisitions = 0;
  const provider = createCachedTokenProvider(async () => {
    const id = ++instances;
    return async () => { acquisitions++; return `opaque-${id}`; };
  });
  assert.equal(await provider(), 'opaque-1');
  assert.equal(await provider(), 'opaque-1');
  assert.equal(acquisitions, 1);
  assert.equal(await provider({ forceRefresh: true }), 'opaque-2');
  assert.equal(await provider(), 'opaque-2');
  assert.equal(instances, 2); assert.equal(acquisitions, 2);
});
test('failed renewal cannot restore a previously rejected token', async () => {
  let instances = 0;
  const provider = createCachedTokenProvider(async () => {
    const id = ++instances;
    return async () => { if (id === 2) throw new Error('Login failed'); return `token-${id}`; };
  });
  assert.equal(await provider(), 'token-1');
  await assert.rejects(provider({ forceRefresh: true }), /Login failed/);
  await assert.rejects(provider(), /Login failed/);
  assert.equal(await provider({ forceRefresh: true }), 'token-3');
});
test('tokens are reacquired before their declared expiration', async () => {
  let now = 1000000, count = 0;
  const provider = createCachedTokenProvider(async () => async () => {
    count++; return `header.${Buffer.from(JSON.stringify({ exp: (now + 300000) / 1000 })).toString('base64url')}.signature`;
  }, () => now);
  await provider(); await provider(); assert.equal(count, 1);
  now += 181000; await provider(); assert.equal(count, 2);
});
