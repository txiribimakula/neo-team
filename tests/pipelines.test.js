import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanPath, duration, kindOf, localSource, logsToRead, parseAnalysis, runAnalysis, timelineText, PIPELINE_LIMITS } from '../server/pipelines.js';
import { DemoPipelineGateway, DemoPipelineAnalyst } from '../server/demo-pipelines.js';
import { remoteFor } from '../server/local-repo.js';

const config = { organization: 'ejemplo', project: 'Neo Platform' };
// A reviewer that records what it was asked and can use the tools it receives.
const recorder = (answer, use = async () => {}) => ({
  asked: null, async status() { return { isAuthenticated: true }; },
  async ask(request) { this.asked = request; await use(request.tools); return { text: JSON.stringify(answer), login: 'ana', model: 'm', usage: { inputTokens: 10, outputTokens: 5 } }; },
});
const tool = (tools, name) => tools.find(t => t.name === name);

test('the steps of a run show as a tree with results, durations, logs and errors', () => {
  const text = timelineText([
    { id: 't', parentId: 'j', type: 'Task', name: 'npm test', order: 2, result: 'failed', startTime: '2026-10-13T08:00:00Z', finishTime: '2026-10-13T08:03:05Z', logId: 7, issues: [{ type: 'error', message: 'exit\n code 1' }] },
    { id: 'j', parentId: 's', type: 'Job', name: 'Linux', order: 1, result: 'failed' },
    { id: 's', parentId: null, type: 'Stage', name: 'Build', order: 1, result: 'failed' },
    { id: 'x', parentId: 'gone', type: 'Task', name: 'Huérfano', order: 9, state: 'pending' },
  ]);
  assert.equal(text, "- Stage «Build»: failed\n  - Job «Linux»: failed\n    - Task «npm test»: failed · 3 min 5 s · log 7\n        error: exit code 1\n- Task «Huérfano»: pending");
  assert.deepEqual([duration(45000), duration(3725000), duration(null)], ['45 s', '1 h 2 min', '']);
  assert.deepEqual([kindOf('succeeded'), kindOf('failed'), kindOf('partiallySucceeded'), kindOf('canceled')], ['optimization', 'failure', 'failure', 'failure']);
});

test('a failure reads the logs of the failed steps; a success, those of the slowest', () => {
  const records = [
    { id: 'j', type: 'Job', result: 'failed', logId: 2, order: 1 },
    { id: 'a', type: 'Task', result: 'succeeded', logId: 3, order: 2, startTime: '2026-01-01T00:00:00Z', finishTime: '2026-01-01T00:05:00Z' },
    { id: 'b', type: 'Task', result: 'failed', logId: 4, order: 3, startTime: '2026-01-01T00:05:00Z', finishTime: '2026-01-01T00:06:00Z' },
    { id: 'c', type: 'Task', result: 'succeeded', logId: 5, order: 4, startTime: '2026-01-01T00:06:00Z', finishTime: '2026-01-01T00:08:00Z' },
  ];
  assert.deepEqual(logsToRead(records, 'failure').map(l => [l.record.logId, l.tail]), [[4, PIPELINE_LIMITS.failedTail]], 'the failed task, not its job');
  assert.deepEqual(logsToRead(records.filter(r => r.id !== 'b'), 'failure').map(l => l.record.logId), [2], 'without a failed task, the job');
  assert.deepEqual(logsToRead(records, 'optimization').map(l => l.record.logId), [3, 5]);
});

test('the answer of Copilot is checked and what is not expected is left out', () => {
  const output = 'Aquí está:\n```json\n' + JSON.stringify({ summary: 'Resumen', cause: 'Causa', category: 'magic', findings: [
    { title: 'Arreglar', priority: 'urgent', file: '\\src\\a.js', line: 3, body: 'Cuerpo', fix: '\nx = 1;\n\n', saving: '2 min' },
    { title: '', body: '' }, { title: 'Sin archivo', priority: 'low', file: null, line: 5, body: 'B', fix: '  ' },
  ] }) + '\n```';
  const failure = parseAnalysis(output, 'failure');
  assert.deepEqual(failure, { summary: 'Resumen', cause: 'Causa', category: 'unknown', findings: [
    { id: 'f1', title: 'Arreglar', priority: 'medium', file: 'src/a.js', line: 3, body: 'Cuerpo', fix: 'x = 1;', saving: null },
    { id: 'f3', title: 'Sin archivo', priority: 'low', file: null, line: null, body: 'B', fix: null, saving: null },
  ] });
  const optimization = parseAnalysis(output, 'optimization');
  assert.deepEqual([optimization.cause, optimization.category, optimization.findings[0].saving], [null, null, '2 min']);
  assert.throws(() => parseAnalysis('no es JSON', 'failure'), /formato esperado/);
});

test('paths cannot leave the repository and remotes of other hosts are recognised by owner and name', () => {
  assert.equal(cleanPath('/./src\\app//x.yml'), 'src/app/x.yml');
  assert.throws(() => cleanPath('../secretos'), /no válida/);
  const remotes = [{ name: 'gh', url: 'git@github.com:Neo/web.git' }, { name: 'az', url: 'https://dev.azure.com/o/p/_git/api' }];
  assert.equal(remoteFor(remotes, 'neo/web'), null, 'only Azure DevOps by default');
  assert.equal(remoteFor(remotes, 'neo/web', { anyHost: true }), 'gh');
  assert.equal(remoteFor(remotes, 'api', { anyHost: true }), 'az');
});

test('a failed run is reviewed with its steps, its YAML, the log of the failed step and read-only tools', async () => {
  const gateway = new DemoPipelineGateway(), progress = [];
  const reviewer = recorder({ summary: 'Falla una prueba.', cause: 'Trunca.', category: 'code', findings: [{ title: 'Redondear', priority: 'high', file: 'src/reports/csv.js', line: 3, body: 'Usa Math.round.', fix: 'Math.round(x)' }] }, async tools => {
    const file = JSON.parse(await tool(tools, 'neo_read_file').handler({ path: 'src/reports/csv.js', startLine: 3, endLine: 3 }));
    assert.deepEqual([file.totalLines, file.text], [8, '3:     const amount = Math.floor(row.amount * 100) / 100;']);
    assert.match(JSON.parse(await tool(tools, 'neo_read_file').handler({ path: '../../etc/passwd' })).error, /no válida/);
    assert.deepEqual(JSON.parse(await tool(tools, 'neo_list_files').handler({ path: '' })).entries, ['azure-pipelines.yml', 'pipelines/', 'package.json', 'src/', 'tests/']);
    assert.match(JSON.parse(await tool(tools, 'neo_read_log').handler({ logId: 5 })).text, /added 1210 packages/);
    assert.match(JSON.parse(await tool(tools, 'neo_read_log').handler({ logId: 99 })).error, /no es de esta ejecución/);
    assert.equal(tool(tools, 'neo_search_code'), undefined, 'Azure Repos cannot be searched');
  });
  const analysis = await runAnalysis({ gateway, reviewer, config, pipelineId: 11, mode: 'azure', model: 'gpt-5', effort: 'high', onProgress: p => progress.push(p.message) });
  const { system, prompt, model, effort, kind } = reviewer.asked;
  assert.deepEqual([kind, model, effort], ['failure', 'gpt-5', 'high']);
  assert.match(system, /did not succeed/);assert.match(system, /Spanish/);
  assert.match(prompt, /Task «npm test»: failed · 3 min 5 s · log 7/);
  assert.match(prompt, /<pipeline_definition>\n# azure-pipelines\.yml\n1: trigger:/, 'the YAML file at the commit of the run');
  assert.match(prompt, /<log id="7" step="npm test" lines="1-19 of 19">\n1: > neo-platform-web@3\.4\.0 test/);
  assert.match(prompt, /#20261011\.7: failed · 6 min 21 s · main \(this run\)/);
  assert.ok(progress.includes('Copilot lee src/reports/csv.js'));
  assert.equal(analysis.kind, 'failure');
  assert.deepEqual(analysis.source, { repository: 'neo-platform-web', kind: 'azure', path: null, revision: '4521a7c3e91f0b2d4c6e8a0b1c2d3e4f5a6b7c8d', note: null });
  assert.deepEqual([analysis.reads, analysis.cause, analysis.findings[0].fix, analysis.copilot.inputTokens], [5, 'Trunca.', 'Math.round(x)', 10]);
  assert.equal(analysis.run.url, 'https://dev.azure.com/ejemplo/Neo%20Platform/_build/results?buildId=4521');
});

test('a successful run asks how to improve it; another repository is read at its default branch', async () => {
  const gateway = new DemoPipelineGateway(), items = [];
  const item = gateway.item.bind(gateway);
  gateway.item = async (c, args) => { items.push(args); return item(c, args); };
  const reviewer = recorder({ summary: 'Lento.', findings: [{ title: 'Caché', priority: 'high', body: 'B', saving: '~3 min' }] }, async tools => { await tool(tools, 'neo_read_file').handler({ path: 'azure-pipelines.yml' }); });
  const analysis = await runAnalysis({ gateway, reviewer, config, pipelineId: 12, repository: 'neo-platform-web', mode: 'azure' });
  assert.equal(reviewer.asked.kind, 'optimization');assert.match(reviewer.asked.system, /succeeded/);
  assert.match(reviewer.asked.prompt, /<log id="4" step="dotnet restore"/, 'the slowest steps');
  assert.match(reviewer.asked.prompt, /# \.azure\/ci\.yml/, 'the YAML is still read from the pipeline repository');
  assert.deepEqual(items.at(-1), { repositoryId: '00000000-0000-4000-8000-00000000d3e0', version: 'refs/heads/main', versionType: 'branch', path: '/azure-pipelines.yml', folder: false });
  assert.deepEqual([analysis.source.repository, analysis.findings[0].saving], ['neo-platform-web', '~3 min']);
  await assert.rejects(runAnalysis({ gateway, reviewer, config, pipelineId: 12, repository: 'no-existe', mode: 'azure' }), /ya no está en Neo Platform/);
});

test('without a GitHub session nothing is read from Azure DevOps, and the reads have a limit', async () => {
  const gateway = new DemoPipelineGateway();
  let read = false;
  gateway.run = async () => { read = true; };
  await assert.rejects(runAnalysis({ gateway, reviewer: { status: async () => ({ isAuthenticated: false }) }, config, pipelineId: 11, mode: 'azure' }), error => error.reason === 'copilot-auth');
  assert.equal(read, false);
  const reviewer = recorder({ summary: 'S', findings: [] }, async tools => {
    for (let i = 0; i < PIPELINE_LIMITS.toolCalls; i++) await tool(tools, 'neo_read_log').handler({ logId: 3 });
    assert.match(JSON.parse(await tool(tools, 'neo_read_log').handler({ logId: 3 })).error, /límite/);
  });
  const analysis = await runAnalysis({ gateway: new DemoPipelineGateway(), reviewer, config, pipelineId: 14, mode: 'azure' });
  assert.match(reviewer.asked.prompt, /classic designer pipeline/);assert.match(reviewer.asked.prompt, /# Exported from the classic definition/);
  assert.equal(analysis.reads, PIPELINE_LIMITS.toolCalls + 1);
});

test('the example reviews each pipeline with its own simulated answer', async () => {
  const results = [];
  for (const id of [11, 12, 13, 14]) results.push(await runAnalysis({ gateway: new DemoPipelineGateway(), reviewer: new DemoPipelineAnalyst(), config, pipelineId: id, mode: 'demo' }));
  assert.deepEqual(results.map(r => [r.kind, r.category]), [['failure', 'code'], ['optimization', null], ['failure', 'intermittent'], ['failure', 'infrastructure']]);
});

const hasGit = await new Promise(done => execFile('git', ['--version'], error => done(!error)));
const run = (cwd, ...args) => new Promise((resolve, reject) => execFile('git', args, { cwd }, (error, stdout) => error ? reject(error) : resolve(stdout.trim())));
test('a local clone is read with git at the commit of the run, not from its working files', { skip: !hasGit && 'git no está disponible' }, async t => {
  const folder = await mkdtemp(join(tmpdir(), 'neo-pipeline-git-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await run(folder, 'init', '-q', '-b', 'main');
  await mkdir(join(folder, 'src'));
  await writeFile(join(folder, 'azure-pipelines.yml'), 'steps:\n  - script: npm test\n');
  await writeFile(join(folder, 'src', 'a.js'), 'export const valor = 1;\n');
  await run(folder, 'add', '.');
  await run(folder, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'uno');
  const commit = await run(folder, 'rev-parse', 'HEAD');
  await writeFile(join(folder, 'src', 'a.js'), 'export const valor = 2;\n');
  const source = await localSource({ path: folder, remote: 'origin', commit, branch: 'refs/heads/main' });
  assert.deepEqual([source.revision, source.note], [commit, null]);
  assert.equal((await source.read('src/a.js')).text, 'export const valor = 1;\n');
  assert.deepEqual((await source.list('')).entries, ['azure-pipelines.yml', 'src/']);
  assert.deepEqual(await source.search('VALOR'), [{ file: 'src/a.js', line: 1, text: 'export const valor = 1;' }]);
  assert.match((await source.read('no-existe.js')).error, /No existe/);
  const missing = await localSource({ path: folder, remote: 'origin', commit: 'f'.repeat(40), branch: 'refs/heads/main' });
  assert.deepEqual([missing.revision, /ffffffff/.test(missing.note)], ['HEAD', true]);
});
