import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAuthenticator } from '../server/browser-auth.js';
import { createCachedTokenProvider } from '../server/token-cache.js';

test('explicit login bypasses broker and opens browser account selection for the organization tenant', async () => {
  let config, request, opened;
  class Client {
    constructor(value) { config = value; }
    async acquireTokenInteractive(value) { request = value; await value.openBrowser('https://login.microsoftonline.com/test'); return { accessToken: 'private-token' }; }
  }
  const authenticate = createBrowserAuthenticator('tenant-id', Client, async url => { opened = url; });
  assert.equal(await authenticate(), 'private-token');
  assert.equal(config.broker, undefined);
  assert.equal(config.auth.authority, 'https://login.microsoftonline.com/tenant-id');
  assert.equal(request.prompt, 'select_account');
  assert.deepEqual(request.scopes, ['499b84ac-1321-427f-aa17-267ca6975798/.default']);
  assert.equal(opened, 'https://login.microsoftonline.com/test');
});
test('explicit interactive intent reaches authenticator factory even with an existing token', async () => {
  const options = [];
  const provider = createCachedTokenProvider(async input => { options.push(input); return async () => input.interactive ? 'browser-token' : 'old-token'; });
  await provider();
  assert.equal(await provider({ forceRefresh: true, interactive: true }), 'browser-token');
  assert.equal(await provider(), 'browser-token');
  assert.equal(options.length, 2);
  assert.equal(options[1].interactive, true);
});
