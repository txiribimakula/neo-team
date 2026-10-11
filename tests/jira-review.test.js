import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { azureRepository, commentState, commentText, publishCode, publishPending, reviewComments, snapshot } from '../server/jira-review.js';
import { JiraPipeline, TicketStore, newTicket, reviewDuties, stagePrompt } from '../server/jira-agents.js';
import { jiraView } from '../dist/jira.js';

const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'neo-review-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };
const sh = (cwd, ...args) => execFileSync('git', args, { cwd }).toString().trim();
async function repository(root) {
  const repo = join(root, 'repo'), remote = join(root, 'remote.git');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['init', '-q', '--bare', remote]);
  sh(repo, 'config', 'user.email', 't@t'); sh(repo, 'config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'a\n'); sh(repo, 'add', '.'); sh(repo, 'commit', '-qm', 'init');
  sh(repo, 'remote', 'add', 'origin', remote);
  return { repo, remote };
}

test('the Azure DevOps repository of a remote, in its https and ssh forms', () => {
  assert.deepEqual(azureRepository('https://org@dev.azure.com/org/My%20Project/_git/App.git'), { organization: 'org', project: 'My Project', repository: 'App' });
  assert.deepEqual(azureRepository('https://org.visualstudio.com/DefaultCollection/Proj/_git/App'), { organization: 'org', project: 'Proj', repository: 'App' });
  assert.deepEqual(azureRepository('https://dev.azure.com/org/_git/Proj'), { organization: 'org', project: 'Proj', repository: 'Proj' }, 'a repository named like its project');
  assert.deepEqual(azureRepository('git@ssh.dev.azure.com:v3/org/Proj/App'), { organization: 'org', project: 'Proj', repository: 'App' });
  assert.equal(azureRepository('https://github.com/org/app.git'), null);
  assert.equal(azureRepository('/tmp/remote.git'), null);
});

test('review comments are short, with their severity, and each one is answered', () => {
  const comments = reviewComments([
    { severity: 'major', text: '  Null when the list is empty.  ', file: '\\src\\A.cs', line: 12 },
    { severity: 'check', text: 'Check the export.', file: 'src/B.cs', line: 3, manual: true },
    { severity: 'suggestion', text: 'Rename it.', manual: true },
    { severity: 'nitpick', text: 'x' }, { severity: 'minor', text: '   ' },
    { severity: 'minor', text: 'Still wrong.', replyTo: 'c1' },
  ], [{ id: 'c1', thread: 41 }]);
  assert.deepEqual(comments, [
    { severity: 'major', text: 'Null when the list is empty.', file: 'src/A.cs', line: 12, manual: false },
    { severity: 'check', text: 'Check the export.', file: 'src/B.cs', line: 3, manual: true },
    { severity: 'suggestion', text: 'Rename it.', file: null, line: null, manual: false },
    { severity: 'minor', text: 'Still wrong.', file: null, line: null, manual: false, thread: 41, replyTo: 'c1' },
  ], 'unknown severities and empty texts are dropped; only a check is manual');
  assert.equal(commentText(comments[0], ['src/A.cs']), '**Major:** Null when the list is empty.');
  assert.equal(commentText(comments[1], ['src/A.cs']), '**Check (manual test):** `src/B.cs:3` · Check the export.', 'a file outside the pull request is named in the text');
  assert.equal(commentText(comments[2]), '**Suggestion:** Rename it.');
  assert.deepEqual([{}, { answers: [{ action: 'changed' }] }, { answers: [{ action: 'verify' }] }, { answers: [{ action: 'verify' }, { action: 'checked', ok: false }] }, { answers: [{ action: 'person' }] }].map(commentState), ['open', 'answered', 'deferred', 'open', 'answered']);

  const open = [{ id: 'c1', manual: false }, { id: 'c2', manual: true }];
  assert.match(reviewDuties('fix', 'fixed', { answers: [{ id: 'c1', action: 'changed', answer: 'Done.' }] }, { open }), /Missing: c2/, 'every comment has to be answered');
  assert.match(reviewDuties('fix', 'fixed', { answers: [{ id: 'c1', action: 'verify', answer: 'Later.' }, { id: 'c2', action: 'verify', answer: 'Later.' }] }, { open }), /only for the comments marked "Check \(manual test\)": c1/, 'only manual checks are left for the verification');
  assert.equal(reviewDuties('fix', 'fixed', { answers: [{ id: 'c1', action: 'declined', answer: 'It is right.' }, { id: 'c2', action: 'verify', answer: 'Needs the app.' }] }, { open }), null);
  assert.equal(reviewDuties('fix', 'blocked', {}, { open }), null, 'a fix that asks for help answers later');
  assert.match(reviewDuties('verify', 'verified', { checks: [] }, { deferred: [open[1]] }), /Missing: c2/);
  assert.match(reviewDuties('verify', 'verified', { checks: [{ id: 'c2', ok: false, result: 'Lost.' }] }, { deferred: [open[1]] }), /makes the outcome "not_fixed"/);
  assert.match(reviewDuties('review', 'commented', { comments: [] }), /at least one comment/);
  assert.match(reviewDuties('review', 'approved', { comments: [{ severity: 'minor', text: 'x' }] }), /means no new comments/);
});

test('the code reviewed is pushed on top of the ticket branch, without committing in the worktree', async t => {
  const root = await temp(t), { repo, remote } = await repository(root);
  const base = sh(repo, 'rev-parse', 'HEAD');
  await writeFile(join(repo, 'a.txt'), 'b\n'); await writeFile(join(repo, 'nuevo.txt'), 'n\n');
  const first = await snapshot(repo);
  assert.equal(first.base, base);
  assert.equal(sh(repo, 'status', '--porcelain'), 'M a.txt\n?? nuevo.txt'.replace('M a', ' M a').trim(), 'the worktree and its index are left as they were');
  const pushed = await publishCode({ path: repo, remote: 'origin', branch: 'neo/NEO-1', base, tree: first.tree, message: 'NEO-1: Falla' });
  assert.equal(pushed.pushed, true);
  assert.equal(sh(remote, 'rev-parse', 'neo/NEO-1'), pushed.commit);
  assert.equal(sh(remote, 'show', 'neo/NEO-1:nuevo.txt'), 'n', 'new files go too');
  assert.equal(sh(repo, 'rev-parse', 'HEAD'), base, 'nothing is committed locally');
  assert.deepEqual(await publishCode({ path: repo, remote: 'origin', branch: 'neo/NEO-1', base, tree: first.tree, message: 'x' }), { commit: pushed.commit, pushed: false }, 'the same code is not pushed again');
  await writeFile(join(repo, 'a.txt'), 'c\n');
  const second = await publishCode({ path: repo, remote: 'origin', branch: 'neo/NEO-1', base, tree: (await snapshot(repo)).tree, message: 'NEO-1: Falla' });
  assert.equal(sh(remote, 'rev-parse', `${second.commit}^`), pushed.commit, 'it goes on top of what was pushed');
});

test('what is published is recorded at once, so nothing is sent twice', async () => {
  const calls = [];
  let fail = true;
  const hub = {
    comment: async c => { calls.push(['comment', c.content, c.filePath ?? null, c.line ?? null]); return { id: 50 + calls.length }; },
    reply: async r => { if (r.content.includes('boom') && fail) { fail = false; throw new Error('Azure caído'); } calls.push(['reply', r.threadId, r.content, r.status]); return { id: 1 }; },
  };
  const review = { pullRequest: { id: 7, repositoryId: 'r', organization: 'o', project: 'p' }, comments: [
    { id: 'c1', severity: 'major', text: 'Wrong.', file: 'a.txt', line: 2, posted: false, answers: [] },
    { id: 'c2', severity: 'minor', text: 'Old.', thread: 9, posted: true, answers: [{ stage: 'fix', action: 'changed', text: 'Fixed.', posted: false }, { stage: 'fix', action: 'declined', text: 'boom', posted: false }] },
  ] };
  const saved = [];
  const save = async change => { review.comments = review.comments.map(change); saved.push(structuredClone(review.comments)); };
  await assert.rejects(publishPending({ hub, review, changed: ['a.txt'], save }), /Azure caído/);
  assert.deepEqual(calls, [['comment', '**Major:** Wrong.', '/a.txt', 2], ['reply', 9, '**Changed:** Fixed.', 'fixed']]);
  await publishPending({ hub, review, changed: ['a.txt'], save });
  assert.deepEqual(calls.slice(2), [['reply', 9, '**Not changed:** boom', 'wontFix']], 'only what had not reached it');
  assert.deepEqual(review.comments.map(c => [c.posted, c.thread, c.answers.map(a => a.posted)]), [[true, 51, []], [true, 9, [true, true]]]);
});

test('Revisar publishes the fix as a draft pull request, and its comments go back to fix until it has none', async t => {
  const root = await temp(t), { repo, remote } = await repository(root);
  const tickets = new TicketStore(join(root, 'tickets')), folder = tickets.folder('NEO-1');
  await tickets.update('NEO-1', () => ({ ...newTicket({ summary: 'Falla', url: 'https://jira/browse/NEO-1' }), stage: 'fix' }));
  const calls = [], runs = [];
  const hub = {
    create: async target => { calls.push(['create', target]); return { pullRequestId: 7, repositoryId: 'r-1', targetRefName: 'refs/heads/main', created: true }; },
    comment: async c => { calls.push(['comment', c]); return { id: 100 + calls.length }; },
    reply: async r => { calls.push(['reply', r]); return { id: 1 }; },
  };
  const write = text => writeFile(join(folder, 'codigo', 'a.txt'), text);
  const steps = {
    fix: [
      async () => { await write('b\n'); return { outcome: 'fixed', report: 'Corregido A.' }; },
      async () => { await write('c\n'); return { outcome: 'fixed', report: 'Respondido.', answers: [{ id: 'c1', action: 'changed', answer: 'Now it is c.' }, { id: 'c2', action: 'verify', answer: 'Needs the application.' }] }; },
      async () => ({ outcome: 'fixed', report: 'Sin cambios.', answers: [{ id: 'c3', action: 'declined', answer: 'The name follows the convention.' }] }),
    ],
    verify: [
      async () => ({ outcome: 'verified', report: 'Ya no falla.' }),
      async () => ({ outcome: 'verified', report: 'Ya no falla.', checks: [{ id: 'c2', ok: true, result: 'The export still works.' }] }),
    ],
    review: [
      async () => ({ outcome: 'commented', report: 'Dos cosas.', comments: [{ severity: 'major', file: 'a.txt', line: 1, text: 'Wrong value.' }, { severity: 'check', manual: true, file: 'otro.cs', line: 3, text: 'Check the export.' }] }),
      async () => ({ outcome: 'commented', report: 'Una sugerencia.', comments: [{ severity: 'suggestion', text: 'Name it c2.', replyTo: 'c1' }] }),
      async () => ({ outcome: 'approved', report: 'Bien.', comments: [] }),
    ],
  };
  const agent = { run: async options => { runs.push(options); return { model: null, usage: null, ...(await steps[options.stage].shift()(options)) }; }, abort: async () => {} };
  const pipeline = new JiraPipeline({ tickets, agent, reviews: hub, settings: async () => ({ repository: repo, baseBranch: 'main', buildCommand: 'build', maxIterations: 3, models: {} }),
    build: async () => ({ ok: true, code: 0, log: 'ok' }), remote: async () => ({ name: 'origin', organization: 'org', project: 'proj', repository: 'app' }) });
  const stages = async () => (await tickets.get('NEO-1')).history.filter(h => h.stage !== 'build').map(h => `${h.stage}:${h.outcome}`);

  await pipeline.runStage('NEO-1'); await pipeline.runStage('NEO-1'); await pipeline.runStage('NEO-1');
  let ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status, await stages()], ['fix', 'pending', ['fix:fixed', 'verify:verified', 'review:commented']], 'a verified fix is reviewed, and the comments send it back to fix');
  const review = runs[2];
  assert.deepEqual([review.workingDirectory, review.writable, review.customInstructions], [join(folder, 'codigo'), [folder], true], 'the reviewer reads the code and writes only its report');
  assert.match(review.prompt, /The whole change, against its base: .*revision-1\.diff/);
  assert.match(review.prompt, /collateral effects: find every caller/);
  assert.match(review.prompt, /mark it "manual" when only a manual test of the application can confirm it/);
  assert.match(review.prompt, /Short, simple and to the point/);
  assert.match(await readFile(join(folder, 'revision-1.diff'), 'utf8'), /-a\n\+b/);
  assert.deepEqual(calls[0], ['create', { name: 'origin', organization: 'org', project: 'proj', repository: 'app', sourceRefName: 'refs/heads/neo/NEO-1', targetRefName: 'refs/heads/main', title: 'NEO-1: Falla', description: 'Jira: https://jira/browse/NEO-1\n\nCorregido A.' }]);
  assert.deepEqual(calls.slice(1).map(([, c]) => [c.content, c.filePath ?? null, c.line ?? null, c.pullRequestId]), [['**Major:** Wrong value.', '/a.txt', 1, 7], ['**Check (manual test):** `otro.cs:3` · Check the export.', null, null, 7]]);
  assert.equal(sh(remote, 'show', 'neo/NEO-1:a.txt'), 'b', 'the code reviewed is on the branch of the pull request');
  assert.equal(sh(join(folder, 'codigo'), 'rev-parse', 'HEAD'), sh(repo, 'rev-parse', 'main'), 'and nothing was committed in the worktree');
  assert.deepEqual([ticket.review.pullRequest.id, ticket.review.pullRequest.url], [7, 'https://dev.azure.com/org/proj/_git/app/pullrequest/7']);
  assert.match(await readFile(join(folder, 'revision-1.md'), 'utf8'), /Dos cosas\.\n\n## Pull request\n\n\[7\]\(https:\/\/dev\.azure\.com\/org\/proj\/_git\/app\/pullrequest\/7\) · borrador · rama neo\/NEO-1/);

  // The fix answers every comment: a change for one, the manual check left for the verification.
  await pipeline.runStage('NEO-1');
  assert.match(runs[3].prompt, /Address the code review of the fix[\s\S]*- c1 \[Major\] a\.txt:1: Wrong value\.\n- c2 \[Check \(manual test\)\] otro\.cs:3: Check the export\./);
  assert.deepEqual(runs[3].duties.open.map(c => c.id), ['c1', 'c2']);
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.iterations], ['verify', 2], 'it changed code: verified again');
  assert.deepEqual(calls.slice(3).map(([, r]) => [r.threadId, r.content, r.status]), [[102, '**Changed:** Now it is c.', 'fixed'], [103, '**Left for the manual verification:** Needs the application.', 'active']]);
  await pipeline.runStage('NEO-1');
  assert.match(runs[4].prompt, /manual checks and the fix left them for you[\s\S]*- c2 \[Check \(manual test\)\] otro\.cs:3: Check the export\./);
  assert.deepEqual(calls.at(-1)[1].content, '**Verified:** The export still works.');
  assert.equal(calls.at(-1)[1].status, 'fixed');

  await pipeline.runStage('NEO-1');
  assert.match(runs[5].prompt, /What changed since the previous review: .*revision-2-ultimos\.diff/);
  assert.match(runs[5].prompt, /Comments already made, with their answers: do not repeat them[\s\S]*- c1 \[Major\][^\n]*\n  Fix: Changed: Now it is c\./);
  assert.match(await readFile(join(folder, 'revision-2-ultimos.diff'), 'utf8'), /-b\n\+c/);
  assert.equal(sh(remote, 'show', 'neo/NEO-1:a.txt'), 'c');
  assert.deepEqual([calls.filter(([kind]) => kind === 'create').length, calls.at(-1)[0], calls.at(-1)[1].threadId, calls.at(-1)[1].content], [1, 'reply', 102, '**Suggestion:** Name it c2.'], 'one pull request; an answer that does not convince goes in its thread');

  // Answered without changing code: straight back to review, which approves it.
  await pipeline.runStage('NEO-1');
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status], ['review', 'pending'], 'nothing changed in the code: no need to verify again');
  await pipeline.runStage('NEO-1');
  assert.match(runs.at(-1).prompt, /The code has not changed since the previous review/);
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status, await stages()], ['done', 'done', ['fix:fixed', 'verify:verified', 'review:commented', 'fix:fixed', 'verify:verified', 'review:commented', 'fix:fixed', 'review:approved']]);
  assert.ok(ticket.review.comments.every(c => commentState(c) === 'answered' && c.posted && c.answers.every(a => a.posted)), 'every comment answered and published');

  // A fix done by hand (⏩) answers what it owed as the person's, without publishing it.
  await tickets.update('NEO-1', t => ({ ...t, stage: 'fix', status: 'pending', review: { ...t.review, comments: [...t.review.comments, { id: 'c4', severity: 'minor', text: 'Typo.', thread: 300, posted: true, answers: [] }] } }));
  const sent = calls.length;
  await pipeline.markDone('NEO-1', 'Fixed it in the PR myself.');
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.review.comments.at(-1).answers.map(a => [a.action, a.text, a.posted]), commentState(ticket.review.comments.at(-1)), calls.length], ['verify', [['person', 'Fixed it in the PR myself.', true]], 'answered', sent]);
  assert.ok(await stat(join(folder, 'revision-1.diff')));

  // The card links to the pull request.
  const state = { mode: 'azure', jira: { url: 'https://e', filter: '1', hasToken: true } };
  const html = jiraView(state, { view: 'board', board: { settings: state.jira, defaults: {}, tools: { winapp: true, ffmpeg: true, azure: false }, pipeline: {}, tickets: [{ ...ticket, review: { ...ticket.review, comments: [{ id: 'c9', answers: [] }] } }] } }, { isAuthenticated: true, models: [] });
  assert.match(html, /<a class="pill jira-pr" href="https:\/\/dev\.azure\.com\/org\/proj\/_git\/app\/pullrequest\/7"[^>]*title="Pull request borrador · 1 comentario sin responder">PR 7 · 1<\/a>/);
  assert.match(html, /aria-label="Revisar">[\s\S]*?data-action="jira-warn" data-stage="review"/, 'without Azure DevOps the review cannot run');
});

test('the review prompt and the fix prompt without comments stay as before', () => {
  const settings = { repository: '/r', buildCommand: 'dotnet build' };
  const fix = stagePrompt({ stage: 'fix', ticket: { key: 'NEO-1', summary: 'x' }, folder: '/t', files: [], settings });
  assert.match(fix, /^Ticket NEO-1[\s\S]*\nFix the cause of the problem in the code\.\nCode folder:/);
  assert.doesNotMatch(fix, /code review/);
});
