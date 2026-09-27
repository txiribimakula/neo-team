import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('HTTP pull request review in the example: list, review, edit, publish once and discard', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-pr-http-'));
  const port = 14353, url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, NEO_TEAM_PORT: String(port), NEO_TEAM_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('Neo Team:')) { clearTimeout(timeout); resolve(); } });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}`)); });
  });
  let state = await (await fetch(url + '/api/state')).json();
  const post = async (path, input = {}) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neo-CSRF': state.csrf }, body: JSON.stringify({ ...input, version: state.version }) });
    const data = await response.json(); if (data.state) state = data.state; else if (data.csrf) state = data;
    return { status: response.status, data };
  };
  assert.equal((await post('/api/pr-repositories')).status, 400, 'without a project there is nothing to review');
  await post('/api/mode', { mode: 'demo' });
  const repositories = (await post('/api/pr-repositories')).data.repositories;
  assert.deepEqual(repositories.map(r => r.name), ['neo-platform-web']);
  const pullRequests = (await post('/api/pr-list', { repository: 'neo-platform-web' })).data.pullRequests;
  assert.deepEqual(pullRequests.map(pr => pr.pullRequestId), [318, 321]);
  assert.equal((await post('/api/pr-review', { url: 'https://github.com/o/r/pull/1' })).status, 400);

  const reviewed = await post('/api/pr-review', { repository: 'neo-platform-web', pullRequestId: 318 });
  assert.equal(reviewed.status, 200);
  const id = reviewed.data.reviewId, review = () => state.prReviews.find(r => r.id === id);
  assert.equal(review().findings.length, 4);
  assert.equal((await post('/api/pr-finding', { id, findingId: 'f2', body: 'Texto ajustado «ñ»' })).status, 200);
  assert.equal((await post('/api/pr-finding', { id, findingId: 'f2', body: '   ' })).status, 400);
  assert.equal((await post('/api/pr-finding', { id, findingId: 'f3', selected: false })).status, 200);
  const disk = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'));
  assert.equal(disk.prReviews[0].findings.find(f => f.id === 'f2').body, 'Texto ajustado «ñ»', 'edits are kept locally');

  const published = await post('/api/pr-publish', { id, includeSummary: true });
  assert.deepEqual(published.data.result, { published: ['summary', 'f1', 'f2'], failures: [] });
  assert.ok(review().findings.find(f => f.id === 'f1').published);assert.ok(review().summaryPublished);
  assert.equal((await post('/api/pr-finding', { id, findingId: 'f1', body: 'Cambio' })).status, 400, 'a published comment cannot be edited');
  assert.equal((await post('/api/pr-publish', { id, includeSummary: true })).status, 400, 'nothing pending is published twice');

  assert.equal((await post('/api/pr-review-delete', { id })).status, 200);
  assert.equal(state.prReviews.length, 0);
  await post('/api/mode', { mode: 'azure' });
  assert.deepEqual(state.prReviews, [], 'example reviews stay in the example');
});
