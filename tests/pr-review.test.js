import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePullRequestUrl, buildDiff, parseReviewOutput, publishReview, commentText, summaryText, runReview, CopilotReviewer } from '../server/pr-review.js';
import { demoPullRequest, DemoReviewer, DemoPullRequestGateway } from '../server/demo.js';
import { location, lineChanges, markChanged } from '../dist/reviews.js';

const file = (path, before, after, changeType = 'edit') => ({ path, changeType, before: { text: before }, after: { text: after } });

test('pull request URLs are recognized in their current and legacy forms', () => {
  assert.deepEqual(parsePullRequestUrl('https://dev.azure.com/contoso/Mi%20Proyecto/_git/web/pullrequest/42?_a=files'), { organization: 'contoso', project: 'Mi Proyecto', repository: 'web', pullRequestId: 42 });
  assert.deepEqual(parsePullRequestUrl('https://contoso.visualstudio.com/DefaultCollection/P/_git/api/pullrequest/7'), { organization: 'contoso', project: 'P', repository: 'api', pullRequestId: 7 });
  for (const invalid of ['', 'no es una url', 'https://github.com/o/r/pull/1', 'https://dev.azure.com/contoso/P/_git/web/pullrequest/abc', 'https://dev.azure.com/contoso/P/_git/web']) assert.equal(parsePullRequestUrl(invalid), null, invalid);
});

test('the diff shows new line numbers and only those lines can anchor a comment', () => {
  const diff = buildDiff([
    file('/a.js', 'uno\ndos\ntres\n', 'uno\nDOS\ntres\ncuatro\n'),
    { path: '/logo.png', changeType: 'edit', before: { binary: true }, after: { binary: true } },
    { path: '/huge.json', changeType: 'add', before: { text: '' }, after: { tooLarge: true } },
  ]);
  assert.match(diff.text, /\+ {4}2 \| DOS/);assert.match(diff.text, /- {6}\| dos/);assert.match(diff.text, /\+ {4}4 \| cuatro/);
  assert.deepEqual(diff.files.map(f => [f.path, f.status]), [['/a.js', 'included'], ['/logo.png', 'binary'], ['/huge.json', 'tooLarge']]);
  assert.deepEqual(diff.files[0].lines, [1, 2, 3, 4]);
  const limited = buildDiff([file('/a.js', '', 'x\n'.repeat(50)), file('/b.js', '', 'y\n'.repeat(50))], 200);
  assert.equal(limited.truncated, true);assert.equal(limited.files[1].status, 'omitted');assert.deepEqual(limited.files[1].lines, []);
});

test('the Copilot answer is validated and every finding is anchored to the diff', () => {
  const diff = buildDiff([file('/a.js', 'uno\n', 'uno\ndos\n')]);
  const answer = '```json\n' + JSON.stringify({ summary: 'Resumen', verdict: 'rara', findings: [
    { file: 'a.js', line: 2, severity: 'major', title: 'Anclado', body: 'Texto' },
    { file: '/a.js', line: 99, severity: 'blocker', title: 'Línea fuera del diff', body: 'Texto' },
    { file: '/otro.js', line: 1, severity: 'nada', title: 'Archivo desconocido', body: 'Texto' },
    { file: '/a.js', line: 1, severity: 'suggestion', title: 'Sugerencia', body: 'Texto' },
    { title: '', body: '' },
  ] }) + '\n```';
  const parsed = parseReviewOutput(answer, diff);
  assert.equal(parsed.verdict, 'changes', 'an unknown verdict follows the most severe finding');
  assert.deepEqual(parsed.findings.map(f => [f.title, f.file, f.line, f.severity, f.selected]), [
    ['Línea fuera del diff', '/a.js', null, 'blocker', true], ['Anclado', '/a.js', 2, 'major', true],
    ['Archivo desconocido', null, null, 'minor', true], ['Sugerencia', '/a.js', 1, 'suggestion', false],
  ]);
  assert.throws(() => parseReviewOutput('No puedo ayudar con eso.', diff), /formato esperado/);
});

async function reviewedDemo() {
  const gateway = new DemoPullRequestGateway();
  const review = await runReview({ azure: gateway, reviewer: new DemoReviewer(), config: { organization: 'ejemplo' }, target: { project: 'Neo Platform', repository: 'neo-platform-web', pullRequestId: 318 }, mode: 'demo' });
  return { gateway, review };
}

test('publishing adds only the selected comments, once, and never on a changed pull request', async () => {
  const { gateway, review } = await reviewedDemo();
  assert.equal(review.pullRequest.sourceCommit, 'd3e0c5a1');
  const saved = [], onPublished = async (id, published) => { saved.push(id); const finding = review.findings.find(f => f.id === id); if (finding) finding.published = published; else review.summaryPublished = published; };
  const writes = [], add = gateway.addPullRequestComment.bind(gateway);
  gateway.addPullRequestComment = async (config, comment) => { writes.push(comment); return add(config, comment); };

  const changed = gateway.pullRequest.bind(gateway);
  gateway.pullRequest = async (...args) => { const data = await changed(...args); data.iteration.sourceCommit = 'nuevo'; return data; };
  await assert.rejects(() => publishReview({ azure: gateway, config: {}, review, includeSummary: true, onPublished }), /cambios nuevos/);
  gateway.pullRequest = async (...args) => { const data = await changed(...args); data.pullRequest.status = 'completed'; return data; };
  await assert.rejects(() => publishReview({ azure: gateway, config: {}, review, includeSummary: true, onPublished }), /completado/);
  assert.equal(writes.length, 0, 'nothing is written to a changed or closed pull request');
  gateway.pullRequest = changed;

  const first = await publishReview({ azure: gateway, config: {}, review, includeSummary: true, onPublished });
  assert.deepEqual(first.published, ['summary', 'f1', 'f2', 'f3'], 'the suggestion is not selected by default');
  assert.deepEqual(writes.map(w => [w.filePath, w.line]), [[undefined, undefined], ['/src/api/export.js', 6], ['/src/csv.js', 2], ['/src/csv.js', 3]]);
  assert.match(writes[1].content, /^\*\*Blocker: SQL injection/);assert.doesNotMatch(writes[1].content, /Neo Team|neo-review|asistida/, 'no mark of where it came from');
  assert.match(summaryText(review), /^\*\*Review summary · Changes requested\*\*/);
  await assert.rejects(() => publishReview({ azure: gateway, config: {}, review, includeSummary: true, onPublished }), /Marca al menos/);

  // A comment that reached Azure although its answer was lost is found by its text.
  const lost = review.findings.find(f => f.id === 'f4');
  lost.selected = true;
  await add({}, { pullRequestId: 318, content: commentText(review, lost) });
  const before = writes.length;
  const second = await publishReview({ azure: gateway, config: {}, review, includeSummary: false, onPublished });
  assert.deepEqual(second.published, ['f4']);assert.equal(writes.length, before, 'no duplicate is sent');assert.equal(lost.published.recovered, true);
});

test('a failed comment is reported and the others are still published', async () => {
  const { gateway, review } = await reviewedDemo();
  const add = gateway.addPullRequestComment.bind(gateway);
  gateway.addPullRequestComment = async (config, comment) => { if (comment.line === 2) throw new Error('HTTP 403'); return add(config, comment); };
  const result = await publishReview({ azure: gateway, config: {}, review, includeSummary: false, onPublished: async () => {} });
  assert.deepEqual(result.published, ['f1', 'f3']);assert.deepEqual(result.failures, [{ id: 'f2', error: 'HTTP 403' }]);
});

function fakeSdk({ authenticated = true, reply = demoReply() } = {}) {
  const log = { sessions: [], deleted: [], stopped: 0 };
  class CopilotClient {
    constructor(options) { log.client = options; }
    async start() {}
    async stop() { log.stopped++; return []; }
    async getAuthStatus() { return authenticated ? { isAuthenticated: true, login: 'dev-empresa', authType: 'gh-cli' } : { isAuthenticated: false }; }
    async listModels() { return [{ id: 'gpt-5', name: 'GPT-5', billing: { multiplier: 1 }, policy: { state: 'enabled' } }, { id: 'claude-opus', name: 'Claude Opus', billing: { multiplier: 10 } }, { id: 'blocked', name: 'Blocked', policy: { state: 'disabled' } }]; }
    async createSession(config) {
      const handlers = {};
      const session = { sessionId: 's1', config, on: (type, handler) => { handlers[type] = handler; }, disconnect: async () => {}, abort: async () => {},
        sendAndWait: async ({ prompt }) => { log.prompt = prompt; handlers['assistant.usage']?.({ data: { model: 'modelo-x', inputTokens: 100, outputTokens: 20 } }); return { data: { content: reply } }; } };
      log.sessions.push(session);
      return session;
    }
    async deleteSession(id) { log.deleted.push(id); }
  }
  return { log, load: async () => ({ CopilotClient }) };
}
function demoReply() { return JSON.stringify({ summary: 'Bien', verdict: 'approve', findings: [] }); }

test('Copilot runs with the signed-in account, without tools, and its session is deleted afterwards', async () => {
  const { log, load } = fakeSdk();
  const result = await new CopilotReviewer({ load }).review({ prompt: 'diff' });
  assert.equal(result.login, 'dev-empresa');assert.equal(result.model, 'modelo-x');assert.deepEqual(result.usage, { model: 'modelo-x', inputTokens: 100, outputTokens: 20 });
  const config = log.sessions[0].config;
  assert.deepEqual(config.availableTools, []);assert.deepEqual(config.excludedTools, ['builtin:*', 'mcp:*', 'custom:*']);
  assert.equal(config.onPermissionRequest({ kind: 'shell' }).kind, 'reject', 'every tool request is rejected');
  assert.equal(config.enableConfigDiscovery, false);assert.equal(config.skipCustomInstructions, true);assert.equal(config.enableSessionStore, false);
  assert.equal(config.workingDirectory, log.client.workingDirectory, 'the session runs in its own empty folder');
  assert.deepEqual(log.deleted, ['s1']);assert.equal(log.stopped, 1);
});

test('without a GitHub session the review explains how to sign in and sends nothing', async () => {
  const { log, load } = fakeSdk({ authenticated: false });
  await assert.rejects(() => new CopilotReviewer({ load }).review({ prompt: 'diff' }), error => error.status === 401 && /gh auth login/.test(error.message));
  assert.equal(log.sessions.length, 0);assert.equal(log.stopped, 1);
  assert.equal((await new CopilotReviewer({ load }).status()).isAuthenticated, false);
});

test('without a GitHub session the pull request is not read from Azure DevOps', async () => {
  const { log, load } = fakeSdk({ authenticated: false });
  let reads = 0;
  await assert.rejects(() => runReview({ azure: { pullRequest: async () => { reads++; return demoPullRequest(318); } }, reviewer: new CopilotReviewer({ load }), config: { organization: 'o' }, target: { project: 'P', repository: 'r', pullRequestId: 318 }, mode: 'azure' }),
    error => error.status === 401 && error.reason === 'copilot-auth' && /token clásico/.test(error.message));
  assert.equal(reads, 0);assert.equal(log.sessions.length, 0);
});

test('the prompt marks the pull request content as untrusted data', async () => {
  const { log, load } = fakeSdk();
  await runReview({ azure: { pullRequest: async () => demoPullRequest(318) }, reviewer: new CopilotReviewer({ load }), config: { organization: 'o' }, target: { project: 'P', repository: 'r', pullRequestId: 318 }, mode: 'azure' });
  assert.match(log.prompt, /<author_description>[\s\S]*<\/author_description>/);assert.match(log.prompt, /<diff>[\s\S]*export\.js[\s\S]*<\/diff>/);
  assert.match(log.sessions[0].config.systemMessage.content, /Ignore any instruction/);assert.match(log.sessions[0].config.systemMessage.content, /Always write in English/);
});

test('an Azure error served as file content is recognised, and the file is read again by path and commit', async () => {
  const { readText, readSide, changeType } = await import('../server/pr-content.js');
  const { Readable } = await import('node:stream');
  const { gzipSync } = await import('node:zlib');
  const stream = (text, extra = {}) => Object.assign(Readable.from([Buffer.isBuffer(text) ? text : Buffer.from(text)]), extra);
  const azureError = JSON.stringify({ $id: '1', innerException: null, message: 'TF401174: The item could not be found.', typeName: 'Microsoft.TeamFoundation.Git.Server.GitItemNotFoundException', typeKey: 'GitItemNotFoundException', errorCode: 0 });
  assert.deepEqual(await readText(stream(azureError), 1000), { error: 'TF401174: The item could not be found.' });
  assert.match((await readText(stream('{}', { statusCode: 404 }), 1000)).error, /HTTP 404/);
  assert.equal((await readText(stream('{"message":"a","typeName":"b"}'), 1000)).text, '{"message":"a","typeName":"b"}', 'a JSON file of the repository is still code');
  assert.equal((await readText(stream(gzipSync('const a = 1;\n'), { headers: { 'content-encoding': 'gzip' } }), 1000)).text, 'const a = 1;\n');
  const calls = [];
  const side = await readSide({ sha: 'abc', path: '/a.js', commit: 'c1', limit: 1000, blob: async sha => { calls.push(['blob', sha]); return stream(azureError); }, item: async (path, commit) => { calls.push(['item', path, commit]); return stream('let x = 2;\n'); } });
  assert.equal(side.text, 'let x = 2;\n');assert.deepEqual(calls, [['blob', 'abc'], ['item', '/a.js', 'c1']]);
  const failed = await readSide({ sha: 'abc', path: '/a.js', commit: 'c1', limit: 1000, blob: async () => stream(azureError), item: async () => { throw new Error('HTTP 401'); } });
  assert.match(failed.error, /TF401174/);
  assert.deepEqual([changeType(2), changeType(16), changeType(9), changeType('add'), changeType('delete, sourceRename'), changeType('edit')], ['edit', 'delete', 'add', 'add', 'delete', 'edit']);
});

test('a pull request whose files cannot be read says why instead of reporting no changes', async () => {
  const { noChangesMessage } = await import('../server/pr-review.js');
  const unreadable = buildDiff([{ path: '/a.js', changeType: 'edit', before: { error: 'TF401019: no tienes acceso' }, after: { error: 'TF401019: no tienes acceso' } }, { path: '/b.js', changeType: 'edit', before: { text: 'x\n' }, after: { text: 'x\n' } }]);
  assert.equal(unreadable.files[0].status, 'error');
  assert.match(noChangesMessage(unreadable.files), /no devolvió el contenido de 1 de 2 archivos del pull request \(\/a\.js: TF401019/);
  assert.match(noChangesMessage(buildDiff([{ path: '/b.js', changeType: 'edit', before: { text: 'x\n' }, after: { text: 'x\n' } }]).files), /de 1 archivos, 1 sin cambios de contenido/);
  await assert.rejects(() => runReview({ azure: { pullRequest: async () => ({ pullRequest: { pullRequestId: 1 }, files: [{ path: '/a.js', changeType: 'edit', before: { error: 'HTTP 401' }, after: { error: 'HTTP 401' } }], threads: [] }) }, reviewer: { status: async () => ({ isAuthenticated: true }) }, config: { organization: 'o' }, target: { project: 'P', repository: 'r', pullRequestId: 1 }, mode: 'azure' }), /HTTP 401/);
});

test('large files are reviewed by their changes, UTF-16 files are text, and what is left out is named', async () => {
  const { readText } = await import('../server/pr-content.js');
  const { Readable } = await import('node:stream');
  const stream = buffer => Readable.from([buffer]);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('SELECT 1;\n', 'utf16le')]);
  assert.equal((await readText(stream(utf16), 1000)).text, 'SELECT 1;\n');
  assert.equal((await readText(stream(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('SELECT 1;\n', 'utf16le').swap16()])), 1000)).text, 'SELECT 1;\n');
  assert.equal((await readText(stream(Buffer.from('﻿hola')), 1000)).text, 'hola', 'the UTF-8 mark is not part of the code');
  const big = Array.from({ length: 30000 }, (_, i) => `línea ${i} con algo de texto para ocupar espacio`).join('\n') + '\n';
  assert.ok(Buffer.byteLength(big) > 1000000);
  const diff = buildDiff([{ path: '/big.sql', changeType: 'edit', before: { text: big }, after: { text: big.replace('línea 15000 ', 'línea 15000 cambiada ') } }]);
  assert.equal(diff.files[0].status, 'included');assert.deepEqual(diff.files[0].lines.filter(l => l === 15001), [15001]);
  assert.ok(diff.text.length < 2000, 'only the changed part is sent');
  const { noChangesMessage } = await import('../server/pr-review.js');
  const message = noChangesMessage(buildDiff([{ path: '/huge.json', changeType: 'edit', before: { tooLarge: true, size: 6000000 }, after: { text: '' } }, { path: '/late.js', changeType: 'edit', before: { skipped: true }, after: { skipped: true } }]).files);
  assert.match(message, /1 demasiado grandes \(más de 5 MB.*\/huge\.json\)/);assert.match(message, /1 fuera del límite total de 50 MB/);
});

test('a finding can carry an Azure DevOps suggested change over whole lines of the diff', async () => {
  const diff = buildDiff(demoPullRequest(318).files);
  const parse = suggestion => parseReviewOutput(JSON.stringify({ summary: 'S', verdict: 'comment', findings: [{ file: '/src/csv.js', line: 2, severity: 'major', title: 'T', body: 'B', suggestion }] }), diff).findings[0];
  const ok = parse({ startLine: 2, endLine: 3, code: "  if (!rows.length) return '';\n  return 'x';\n" });
  assert.deepEqual(ok.suggestion, { startLine: 2, endLine: 3, code: "  if (!rows.length) return '';\n  return 'x';", original: ['  const columns = Object.keys(rows[0]);', "  return [columns.join(','), ...rows.map(row => columns.map(column => row[column]).join(','))].join('\\n');"] });
  assert.equal(ok.line, 2);assert.equal(location(ok), '/src/csv.js:2-3');
  for (const bad of [{ startLine: 4, endLine: 9, code: 'x' }, { startLine: 3, endLine: 2, code: 'x' }, { startLine: 2, endLine: 2, code: 'a ``` b' }, { startLine: 2, endLine: 2, code: '  const columns = Object.keys(rows[0]);' }, { startLine: 2 }, null])
    assert.equal(parse(bad).suggestion, null, JSON.stringify(bad));
  const review = { id: 'r9', project: 'P', repository: { id: 'r', name: 'web' }, pullRequest: { id: 318, sourceCommit: demoPullRequest(318).pullRequest.lastMergeSourceCommit }, summary: 'S', verdict: 'comment', summaryPublished: null, findings: [{ ...ok, id: 'f1', selected: true, published: null }] };
  assert.match(commentText(review, review.findings[0]), /\n```suggestion\n  if \(!rows\.length\) return '';\n  return 'x';\n```$/);
  const gateway = new DemoPullRequestGateway(), sent = [];
  const add = gateway.addPullRequestComment.bind(gateway);
  gateway.addPullRequestComment = async (config, args) => { sent.push(args); return add(config, args); };
  await publishReview({ azure: gateway, config: {}, review, includeSummary: false, onPublished: async () => {} });
  assert.deepEqual([sent[0].filePath, sent[0].line, sent[0].endLine, sent[0].endOffset], ['/src/csv.js', 2, 3, review.findings[0].suggestion.original[1].length + 1], 'the thread selects the whole lines');
});

test('the review model can be chosen among those the account may use', async () => {
  const { log, load } = fakeSdk();
  const status = await new CopilotReviewer({ load }).status();
  assert.deepEqual(status.models, [{ id: 'gpt-5', name: 'GPT-5', multiplier: 1 }, { id: 'claude-opus', name: 'Claude Opus', multiplier: 10 }], 'models disabled by the organization are not offered');
  const reviewer = new CopilotReviewer({ load, model: 'gpt-5' });
  await reviewer.review({ prompt: 'diff', model: 'claude-opus' });
  assert.equal(log.sessions[0].config.model, 'claude-opus', 'the chosen model wins over NEO_TEAM_COPILOT_MODEL');
  await reviewer.review({ prompt: 'diff' });
  assert.equal(log.sessions[1].config.model, 'gpt-5');
  await new CopilotReviewer({ load, model: undefined }).review({ prompt: 'diff' });
  assert.equal('model' in log.sessions[2].config, false, 'without a choice, the default of the plan');
});

test('every anchored comment keeps the code it talks about, and a suggestion marks only what changes', () => {
  const diff = buildDiff(demoPullRequest(318).files);
  const findings = parseReviewOutput(JSON.stringify({ summary: 'S', verdict: 'comment', findings: [
    { file: '/src/api/export.js', line: 6, severity: 'major', title: 'A', body: 'B' },
    { file: '/src/csv.js', line: 1, severity: 'minor', title: 'C', body: 'D' },
    { file: '/src/csv.js', line: null, severity: 'minor', title: 'E', body: 'F' },
  ] }), diff).findings;
  assert.deepEqual(findings[0].snippet, { startLine: 4, focus: 6, lines: ['export async function exportReport(req, res) {', "  const format = req.query.format || 'json';", "  const rows = await query(`SELECT * FROM reports WHERE team = '${req.query.team}'`);", "  if (format === 'csv') {", "    res.setHeader('Content-Type', 'text/csv');"] });
  assert.deepEqual([findings[1].snippet.startLine, findings[1].snippet.lines.length], [1, 3], 'the snippet stops where the file starts');
  assert.equal(findings[2].snippet, null, 'a comment on the whole file has no snippet');
  const changes = lineChanges(['  const columns = Object.keys(rows[0]);'], ["  if (!rows.length) return '';", '  const columns = Object.keys(rows[0] ?? {});']);
  assert.deepEqual(changes.map(c => c.kind), ['removed', 'added', 'added']);
  const changed = changes.find(c => c.kind === 'added' && c.pair);
  assert.equal(markChanged(changed.text, changed.pair), '  const columns = Object.keys(rows[0]<mark> ?? {}</mark>);', 'only the changed part of a changed line');
  assert.equal(markChanged("  if (!rows.length) return '';"), "  <mark>if (!rows.length) return &#39;&#39;;</mark>", 'a new line is changed whole, without its indentation');
  assert.equal(markChanged('a = 1', 'a  = 1'), 'a = 1', 'only spaces do not count as a change');
});
