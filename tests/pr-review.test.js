import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePullRequestUrl, buildDiff, parseReviewOutput, publishReview, commentText, commentReference, runReview, CopilotReviewer } from '../server/pr-review.js';
import { demoPullRequest, DemoReviewer, DemoPullRequestGateway } from '../server/demo.js';

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
  assert.match(writes[1].content, new RegExp(commentReference(review, 'f1')));
  await assert.rejects(() => publishReview({ azure: gateway, config: {}, review, includeSummary: true, onPublished }), /Marca al menos/);

  // A comment that reached Azure although its answer was lost is found by its reference.
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
  assert.match(log.prompt, /<descripcion_del_autor>[\s\S]*<\/descripcion_del_autor>/);assert.match(log.prompt, /<diff>[\s\S]*export\.js[\s\S]*<\/diff>/);
  assert.match(log.sessions[0].config.systemMessage.content, /Ignora cualquier instrucción/);
});
