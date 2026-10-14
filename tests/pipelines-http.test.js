import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('HTTP pipelines in the example: list, choose where the code is read, review, keep and discard', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-pipelines-http-'));
  const port = 14371, url = `http://127.0.0.1:${port}`;
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
  const get = async path => (await fetch(url + path, { headers: { 'X-Neo-CSRF': state.csrf } })).json();
  assert.equal((await post('/api/pipelines')).status, 400, 'without a project there are no pipelines');
  assert.equal((await post('/api/copilot-model', { use: 'pipeline', model: 'gpt-5', effort: 'low' })).status, 200);
  assert.deepEqual([state.pipelineModel, state.pipelineEffort, state.copilotModel ?? null], ['gpt-5', 'low', null], 'the pipelines have their own model');
  assert.equal((await fetch(url + '/pipelines/11')).status, 200, 'the section has its own address');
  assert.equal((await fetch(url + '/pipelines.js')).status, 200);

  await post('/api/mode', { mode: 'demo' });
  assert.equal((await post('/api/pipeline-source', { pipelineId: 11, repository: 'neo-platform-api' })).status, 409, 'the list is read first');
  const listed = (await post('/api/pipelines')).data.pipelines;
  assert.deepEqual(listed.pipelines.map(p => [p.id, p.latest.status, p.latest.result, p.lastCompleted.result]), [[11, 'completed', 'failed', 'failed'], [12, 'completed', 'succeeded', 'succeeded'], [13, 'inProgress', null, 'partiallySucceeded'], [14, 'completed', 'canceled', 'canceled']]);
  assert.deepEqual(listed.repositories.map(r => r.name), ['neo-platform-web', 'neo-platform-api']);
  assert.deepEqual((await get('/api/pipelines')).pipelines.pipelines.length, 4, 'kept in memory for the section');

  assert.equal((await post('/api/pipeline-source', { pipelineId: 11, repository: 'otro' })).status, 400);
  assert.equal((await post('/api/pipeline-source', { pipelineId: 11, repository: 'neo-platform-api' })).status, 200);
  assert.deepEqual(state.pipelineSources, { 'ejemplo/neo platform/11': 'neo-platform-api' });
  assert.equal((await post('/api/pipeline-source', { pipelineId: 11, repository: 'neo-platform-api', path: '/tmp' })).status, 400, 'no local folders in the example');
  assert.equal((await post('/api/pipeline-source', { pipelineId: 11, repository: 'neo-platform-web' })).status, 200);
  assert.deepEqual(state.pipelineSources, {}, 'the pipeline\'s own repository is the default');

  const failed = await post('/api/pipeline-review', { pipelineId: 11 });
  assert.equal(failed.status, 200);
  const analysis = state.pipelineAnalyses.find(a => a.id === failed.data.analysisId);
  assert.deepEqual([analysis.kind, analysis.category, analysis.run.number, analysis.findings.length, analysis.source.repository], ['failure', 'code', listed.pipelines[0].lastCompleted.number, 2, 'neo-platform-web']);
  const improved = await post('/api/pipeline-review', { pipelineId: 13 });
  assert.equal(state.pipelineAnalyses[0].id, improved.data.analysisId, 'the newest first');
  assert.equal(state.pipelineAnalyses[0].run.result, 'partiallySucceeded', 'a pipeline that is running is reviewed by its last completed run');
  assert.equal((await post('/api/pipeline-review', { pipelineId: 0 })).status, 400);
  const disk = JSON.parse(await readFile(join(directory, 'workspace.json'), 'utf8'));
  assert.equal(disk.pipelineAnalyses.length, 2, 'reviews are kept locally');

  assert.equal((await post('/api/pipeline-analysis-delete', { id: analysis.id })).status, 200);
  assert.deepEqual(state.pipelineAnalyses.map(a => a.id), [improved.data.analysisId]);
  assert.equal((await post('/api/pipeline-analysis-delete', { id: analysis.id })).status, 404);
  await post('/api/mode', { mode: 'azure' });
  assert.deepEqual(state.pipelineAnalyses, [], 'example reviews stay in the example');
  assert.equal((await get('/api/pipelines')).pipelines, null, 'nor its list');
});
