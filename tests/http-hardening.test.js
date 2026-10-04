import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';

test('HTTP hardening: cross-site requests, split UTF-8 bodies, expired sessions and headers', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-hardening-'));
  const port = 14341, url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, NEO_TEAM_PORT: String(port), NEO_TEAM_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('Neo Team:')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)); });
  });
  const stateResponse = await fetch(url + '/api/state');
  assert.equal(stateResponse.headers.get('cross-origin-opener-policy'), 'same-origin');
  assert.equal(stateResponse.headers.get('x-content-type-options'), 'nosniff');
  let state = await stateResponse.json();

  const crossSite = await fetch(url + '/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(crossSite.status, 403, 'another website cannot download the plan');
  assert.equal((await fetch(url + '/', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'a link to the application still opens it');

  const expired = await fetch(url + '/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neo-CSRF': 'old' }, body: '{}' });
  assert.equal(expired.status, 403);assert.equal((await expired.json()).reason, 'session');

  // A body whose multi-byte characters are split between two network chunks.
  const body = Buffer.from(JSON.stringify({ version: state.version, config: { organization: 'contoso', project: 'Café «Ñandú»', team: 'Equipo ☕' } }));
  const split = body.indexOf(Buffer.from('ñ')) + 1;
  const saved = await new Promise((resolve, reject) => {
    const req = httpRequest(url + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neo-CSRF': state.csrf, 'Content-Length': body.length } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.write(body.subarray(0, split));
    setTimeout(() => req.end(body.subarray(split)), 50);
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.config.project, 'Café «Ñandú»');assert.equal(saved.data.config.team, 'Equipo ☕');
  state = saved.data;

  const notObject = await fetch(url + '/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neo-CSRF': state.csrf }, body: '[]' });
  assert.equal(notObject.status, 400);
  const demo = await fetch(url + '/api/mode', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neo-CSRF': state.csrf }, body: JSON.stringify({ version: state.version, mode: 'demo' }) });
  state = await demo.json();
  const invalid = await fetch(url + '/api/stage', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neo-CSRF': state.csrf }, body: JSON.stringify({ version: state.version, edits: [{ id: 1042, changes: { priority: 9 } }] }) });
  assert.equal(invalid.status, 400, 'a validation error is not a server error');
  assert.equal((await invalid.json()).diagnostics, undefined, 'validation errors do not leave a diagnostic report');
});
