import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jqlFrom, jiraSettingsFrom, wikiToMarkdown, attachmentNames, safeName, JiraClient, collectTicket } from '../server/jira.js';
import { autoLocked, collectSummary, logComment, nextAfter, defaultModel, modelFor, permissionFor, stagePrompt, systemMessage, TicketStore, JiraPipeline, ensureWorktree, newTicket, checkKey } from '../server/jira-agents.js';
import { jiraView, ticketDetail, typeIcon, priorityIcon, markdown, assigneeView } from '../dist/jira.js';

const temp = async t => { const dir = await mkdtemp(join(tmpdir(), 'neo-jira-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('the filter is a number, a Jira URL or JQL', () => {
  assert.equal(jqlFrom('12345'), 'filter = 12345');
  assert.equal(jqlFrom('https://empresa.atlassian.net/issues/?filter=777'), 'filter = 777');
  assert.equal(jqlFrom('https://jira.empresa.com/issues/?jql=project%20%3D%20NEO'), 'project = NEO');
  assert.equal(jqlFrom('project = NEO AND status = Open'), 'project = NEO AND status = Open');
  assert.equal(jqlFrom('https://empresa.atlassian.net/issues/?filter=-1'), 'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC', 'a system filter is its query');
  assert.equal(jqlFrom('-2'), 'reporter = currentUser() ORDER BY created DESC');
  assert.equal(jqlFrom('https://e.atlassian.net/issues/?filter=-1&jql=project%20%3D%20NEO'), 'project = NEO', 'a filter changed by hand is its JQL');
  assert.equal(jqlFrom('https://e.atlassian.net/jira/software/projects/NEO/issues?filter=10020'), 'filter = 10020');
  assert.throws(() => jqlFrom('-42'), /filtro del sistema -42/);
  assert.throws(() => jqlFrom(''), /filtro/);
  assert.throws(() => jqlFrom('https://empresa.atlassian.net/browse/NEO-1'), /no contiene un filtro/);
});

test('settings require a URL, the account email in Cloud and a filter', () => {
  const ok = jiraSettingsFrom({ url: 'empresa.atlassian.net/', deployment: 'cloud', email: 'yo@empresa.com', filter: '1', maxIterations: 4 });
  assert.equal(ok.url, 'https://empresa.atlassian.net');
  assert.equal(ok.maxIterations, 4);
  assert.throws(() => jiraSettingsFrom({ url: 'https://e.atlassian.net', deployment: 'cloud', filter: '1' }), error => /correo/.test(error.message) && error.field === 'email');
  assert.throws(() => jiraSettingsFrom({ url: 'https://e.atlassian.net', deployment: 'datacenter', filter: 'https://e.atlassian.net/browse/X-1' }), error => error.field === 'filter');
  assert.equal(jiraSettingsFrom({ url: 'https://jira.empresa.com/jira', deployment: 'datacenter', filter: '1' }).url, 'https://jira.empresa.com/jira');
  assert.throws(() => jiraSettingsFrom({ url: 'https://e.atlassian.net', deployment: 'datacenter', filter: '1', maxIterations: 0 }), /iteraciones/);
});

test('attachments keep their Jira names; older duplicates get their id', () => {
  const names = attachmentNames([
    { id: 1, filename: 'log.txt', created: '2026-01-01' },
    { id: 2, filename: 'log.txt', created: '2026-02-01' },
    { id: 3, filename: '..\\..\\evil:name?.png', created: '2026-01-01' },
  ]);
  assert.equal(names.get('2'), 'log.txt', 'the newest keeps the name, as Jira shows it');
  assert.equal(names.get('1'), 'log-1.txt');
  assert.equal(names.get('3'), 'evil_name_.png');
  assert.equal(safeName('   '), 'adjunto');
});

test('wiki markup becomes Markdown with links to the local attachments', () => {
  const names = new Map([['1', 'captura 1.png'], ['2', 'video.mp4']]);
  const md = wikiToMarkdown(`h2. Pasos
# Abrir *Facturas*
## Pulsar {{Exportar}}
* punto con *negrita*
Ver !captura 1.png|thumbnail! y [^video.mp4], pregunta a [~accountid:abc123] o mira [la guía|https://wiki/x]
{code:java}
int a = *b*;
{code}
||Campo||Valor||
|A|1|
!otro.png!`, names);
  assert.match(md, /^## Pasos$/m);
  assert.match(md, /^1\. Abrir \*\*Facturas\*\*$/m);
  assert.match(md, /^ {2}1\. Pulsar `Exportar`$/m);
  assert.match(md, /^- punto con \*\*negrita\*\*$/m);
  assert.match(md, /!\[captura 1\.png\]\(adjuntos\/captura%201\.png\)/);
  assert.match(md, /\[video\.mp4\]\(adjuntos\/video\.mp4\)/);
  assert.match(md, /@abc123/);
  assert.match(md, /\[la guía\]\(https:\/\/wiki\/x\)/);
  assert.match(md, /```java\nint a = \*b\*;\n```/, 'code is kept as written');
  assert.match(md, /\| Campo \| Valor \|\n\| --- \| --- \|\n\|A\|1\|/);
  assert.match(md, /!otro\.png!/, 'an attachment that is not in the ticket is left as written');
});

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('Jira Cloud pages with nextPageToken and Data Center with startAt', async () => {
  const calls = [];
  const cloud = new JiraClient({ url: 'https://e.atlassian.net', deployment: 'cloud', email: 'yo@e.com' }, 'tok', { fetch: async (url, options) => {
    calls.push([url.pathname, url.searchParams.get('nextPageToken'), options.headers.Authorization]);
    return jsonResponse(url.searchParams.get('nextPageToken') ? { issues: [{ key: 'A-2' }], isLast: true } : { issues: [{ key: 'A-1' }], nextPageToken: 'p2', isLast: false });
  } });
  assert.deepEqual((await cloud.search('filter = 1', ['summary'])).issues.map(i => i.key), ['A-1', 'A-2']);
  assert.deepEqual(calls.map(c => c.slice(0, 2)), [['/rest/api/2/search/jql', null], ['/rest/api/2/search/jql', 'p2']]);
  assert.equal(calls[0][2], `Basic ${Buffer.from('yo@e.com:tok').toString('base64')}`);
  const server = new JiraClient({ url: 'https://jira.e.com', deployment: 'datacenter' }, 'pat', { fetch: async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer pat');
    const start = Number(url.searchParams.get('startAt'));
    return jsonResponse({ total: 3, issues: start === 0 ? [{ key: 'B-1' }, { key: 'B-2' }] : [{ key: 'B-3' }] });
  } });
  assert.deepEqual((await server.search('x', ['summary'])).issues.map(i => i.key), ['B-1', 'B-2', 'B-3']);
  const denied = new JiraClient({ url: 'https://e.atlassian.net', deployment: 'cloud', email: 'a@b.c' }, 'bad', { fetch: async () => jsonResponse({ errorMessages: ['nope'] }, 401) });
  await assert.rejects(denied.search('x', []), error => error.reason === 'jira-token');
  await assert.rejects(cloud.download('https://otro.com/file'), /fuera del servidor/);
  assert.throws(() => new JiraClient({ url: 'https://e.atlassian.net' }, ''), error => error.reason === 'jira-token');
});

test('a collected ticket has its description, comments and attachments on disk', async t => {
  const folder = join(await temp(t), 'NEO-1');
  const client = {
    issue: async () => ({ key: 'NEO-1', fields: { summary: 'Falla', description: 'Ver !a.png!', status: { name: 'Open' }, attachment: [{ id: 9, filename: 'a.png', size: 3, created: '2026-01-01', content: 'https://e/9' }] } }),
    comments: async () => [{ author: { displayName: 'Ana' }, created: '2026-01-02T10:00:00Z', body: 'Adjunto [^a.png]' }],
    download: async () => new Response(Buffer.from('png')),
  };
  const meta = await collectTicket({ client, settings: { url: 'https://e.atlassian.net' }, key: 'NEO-1', folder });
  assert.deepEqual([meta.key, meta.attachments, meta.comments, meta.url], ['NEO-1', 1, 1, 'https://e.atlassian.net/browse/NEO-1']);
  assert.equal(await readFile(join(folder, 'adjuntos', 'a.png'), 'utf8'), 'png');
  assert.match(await readFile(join(folder, 'descripcion.md'), 'utf8'), /!\[a\.png\]\(adjuntos\/a\.png\)/);
  assert.match(await readFile(join(folder, 'comentarios.md'), 'utf8'), /## Ana · 2026-01-02 10:00\n\nAdjunto \[a\.png\]\(adjuntos\/a\.png\)/);
  let downloads = 0;
  await collectTicket({ client: { ...client, download: async () => { downloads++; return new Response('png'); } }, settings: { url: 'https://e.atlassian.net' }, key: 'NEO-1', folder });
  assert.equal(downloads, 0, 'an attachment already downloaded is kept');
});

test('tickets move between columns and back to fix while verification fails', () => {
  const t = { iterations: 1, reproduceAttempts: 1 };
  assert.deepEqual(nextAfter(t, 'collect', 'ok'), { stage: 'reproduce', status: 'pending' });
  assert.deepEqual(nextAfter(t, 'reproduce', 'reproduced'), { stage: 'fix', status: 'pending' });
  assert.deepEqual(nextAfter(t, 'reproduce', 'not_reproduced'), { stage: 'reproduce', status: 'pending' });
  assert.equal(nextAfter({ reproduceAttempts: 2 }, 'reproduce', 'not_reproduced').status, 'blocked');
  assert.deepEqual(nextAfter(t, 'fix', 'fixed'), { stage: 'verify', status: 'pending' });
  assert.deepEqual(nextAfter(t, 'verify', 'not_fixed', 3), { stage: 'fix', status: 'pending' });
  assert.deepEqual(nextAfter({ iterations: 3 }, 'verify', 'not_fixed', 3).status, 'blocked');
  assert.deepEqual(nextAfter({ iterations: 3 }, 'fix', 'failed', 3).status, 'blocked');
  assert.deepEqual(nextAfter(t, 'verify', 'verified'), { stage: 'done', status: 'done' });
  assert.deepEqual(nextAfter(t, 'fix', 'blocked'), { stage: 'fix', status: 'blocked' });
  assert.throws(() => checkKey('../NEO-1'), /no válida/);
});

test('each column gets a model fit for its difficulty unless one is chosen', () => {
  const models = ['claude-haiku-4.5', 'claude-sonnet-4', 'claude-sonnet-4.5', 'claude-opus-4.1', 'claude-opus-4.5', 'gpt-5-mini', 'gpt-5'].map(id => ({ id }));
  assert.equal(defaultModel('light', models), 'claude-haiku-4.5');
  assert.equal(defaultModel('medium', models), 'claude-sonnet-4.5');
  assert.equal(defaultModel('high', models), 'claude-opus-4.5');
  assert.equal(modelFor('fix', { fix: 'gpt-5' }, models), 'gpt-5');
  assert.equal(modelFor('collect', {}, models), null, 'collecting uses no model');
  assert.equal(modelFor('collect', {}, []), null, 'without a list, the plan default');
});

test('agents write only in their folders and never commit or push', () => {
  const options = { writable: ['/t/NEO-1', '/t/NEO-1/codigo'], cwd: '/t/NEO-1/codigo' };
  assert.equal(permissionFor({ kind: 'read', path: '/etc/hosts' }, options).kind, 'approve-once');
  assert.equal(permissionFor({ kind: 'write', fileName: 'src/a.cs' }, options).kind, 'approve-once');
  assert.equal(permissionFor({ kind: 'write', fileName: '/t/NEO-1/evidencias/1.png' }, options).kind, 'approve-once');
  assert.equal(permissionFor({ kind: 'write', fileName: '../../NEO-2/x' }, options).kind, 'reject');
  assert.equal(permissionFor({ kind: 'write', fileName: '/t/NEO-10/x' }, options).kind, 'reject', 'a sibling folder with the same prefix is outside');
  assert.equal(permissionFor({ kind: 'shell', fullCommandText: 'dotnet build App.sln' }, options).kind, 'approve-once');
  assert.equal(permissionFor({ kind: 'shell', fullCommandText: 'winapp ui invoke Guardar -a App --json' }, options).kind, 'approve-once');
  assert.equal(permissionFor({ kind: 'shell', fullCommandText: 'git add . && git commit -m x' }, options).kind, 'reject');
  assert.equal(permissionFor({ kind: 'shell', fullCommandText: 'git push origin HEAD' }, options).kind, 'reject');
  assert.equal(permissionFor({ kind: 'url', url: 'https://x' }, options).kind, 'reject');
  assert.equal(permissionFor({ kind: 'mcp', toolName: 'x' }, options).kind, 'reject');
});

test('prompts carry the lessons, the reports so far and how to drive the app', () => {
  const ticket = { key: 'NEO-1', summary: 'Falla', lastOutcome: 'not_fixed' };
  const settings = { repository: '/r', buildCommand: 'dotnet build', launchCommand: '' };
  const reproduce = stagePrompt({ stage: 'reproduce', ticket, folder: '/t/NEO-1', files: ['descripcion.md', 'resumen.md'], settings, lessons: { general: '- Abrir con X', reproduce: '- Esperar al splash' }, previous: { resumen: '/t/NEO-1/resumen.md' } });
  assert.match(reproduce, /<lessons_general>\n- Abrir con X\n<\/lessons_general>/);
  assert.match(reproduce, /<lessons_reproduce>\n- Esperar al splash/);
  assert.match(reproduce, /winapp ui inspect/);
  assert.match(reproduce, /reproducir\.ps1/);
  assert.match(reproduce, /not configured: find it/, 'without a launch command the agent finds it and learns it');
  const fix = stagePrompt({ stage: 'fix', ticket, folder: '/t/NEO-1', files: [], settings, worktree: { path: '/t/NEO-1/codigo', branch: 'neo/NEO-1' }, previous: { verify: '/t/NEO-1/verificacion-1.md' } });
  assert.match(fix, /\/t\/NEO-1\/codigo — a separate git worktree of \/r on branch neo\/NEO-1/);
  assert.match(fix, /previous fix did not pass verification/);
  assert.match(fix, /Build command \(run it in the code folder\): dotnet build/);
  assert.doesNotMatch(fix, /winapp ui/);
  assert.match(systemMessage('verify'), /neo_learn/);
});

test('the pipeline checks the build, learns once and stops on request', async t => {
  const root = await temp(t), tickets = new TicketStore(root);
  await tickets.update('NEO-1', () => ({ ...newTicket({ summary: 'Falla' }), stage: 'fix' }));
  const runs = [];
  const agent = { run: async options => {
    runs.push(options);
    await options.onLearn('general', 'Compilar con dotnet build');
    await options.onLearn('general', 'Compilar con dotnet build');
    return { outcome: 'fixed', report: 'Cambio en A.cs', model: options.model, usage: { inputTokens: 10, outputTokens: 5 } };
  }, abort: async () => {} };
  const builds = [{ ok: false, code: 1, log: 'error CS1002' }, { ok: true, code: 0, log: 'ok' }];
  const pipeline = new JiraPipeline({ tickets, agent, settings: async () => ({ repository: '/r', buildCommand: 'dotnet build', maxIterations: 3, models: {} }),
    worktree: async () => ({ path: join(root, 'NEO-1', 'codigo'), branch: 'neo/NEO-1' }), build: async () => builds.shift(), models: async () => [{ id: 'claude-opus-4.5' }] });
  await pipeline.runStage('NEO-1');
  let ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status, ticket.iterations, ticket.lastOutcome], ['fix', 'pending', 1, 'failed'], 'a fix that does not build goes back to fix');
  assert.match(await readFile(join(root, 'NEO-1', 'solucion-1.md'), 'utf8'), /Compilación comprobada por Neo Team[\s\S]*error CS1002/);
  assert.equal(await readFile(join(root, 'NEO-1', 'compilacion-1.log'), 'utf8'), 'error CS1002');
  assert.equal(runs[0].model, 'claude-opus-4.5');
  assert.equal(runs[0].workingDirectory, join(root, 'NEO-1', 'codigo'));
  assert.deepEqual(runs[0].writable, [join(root, 'NEO-1'), join(root, 'NEO-1', 'codigo')]);
  assert.equal(runs[0].customInstructions, true, 'the fix agent follows the repository instructions');
  await pipeline.runStage('NEO-1');
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.iterations, ticket.history.map(h => h.outcome)], ['verify', 2, ['failed', 'fixed']]);
  assert.match(runs[1].prompt, /Latest fix report: .*solucion-1\.md/);
  const lessons = await tickets.learnings('general');
  assert.equal(lessons.match(/Compilar con dotnet build/g).length, 1);

  // Stopping leaves the step pending, without counting it as a failure.
  let release;
  pipeline.agent = { run: () => new Promise((_, reject) => { release = () => reject(Object.assign(new Error('Detenido.'), { stopped: true })); }), abort: async () => release() };
  const running = pipeline.runStage('NEO-1');
  await new Promise(done => setTimeout(done, 20));
  assert.equal(pipeline.snapshot().running.key, 'NEO-1');
  await pipeline.stop(); await running;
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status, ticket.history.at(-1).outcome], ['verify', 'pending', 'stopped']);
});

test('each ticket is fixed in its own worktree and branch', async t => {
  const root = await temp(t), repo = join(root, 'repo');
  const run = (...args) => execFileSync('git', args, { cwd: repo });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  run('config', 'user.email', 't@t'); run('config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'a'); run('add', '.'); run('commit', '-qm', 'init');
  const folder = join(root, 'tickets', 'NEO-7');
  const worktree = await ensureWorktree({ repository: repo }, { key: 'NEO-7' }, folder);
  assert.deepEqual(worktree, { path: join(folder, 'codigo'), branch: 'neo/NEO-7' });
  assert.equal(await readFile(join(folder, 'codigo', 'a.txt'), 'utf8'), 'a');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: join(folder, 'codigo') }).toString().trim(), 'neo/NEO-7');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: repo }).toString().trim(), 'main', 'the repository stays on its branch');
  assert.deepEqual(await ensureWorktree({ repository: repo }, { key: 'NEO-7' }, folder), worktree, 'it is reused');
  await assert.rejects(ensureWorktree({ repository: '' }, { key: 'NEO-8' }, folder), /carpeta del repositorio/);
  assert.ok((await stat(join(folder, 'codigo', '.git'))).isFile());
});

test('the board shows a column per agent with its model and the live step', () => {
  const state = { mode: 'azure', jira: { url: 'https://e', filter: '1', models: { fix: 'claude-opus-4.5' }, hasToken: true } };
  const board = { settings: state.jira, defaults: { collect: 'claude-haiku-4.5' }, tools: { winapp: false, ffmpeg: true },
    pipeline: { auto: true, running: { key: 'NEO-1', stage: 'reproduce', model: 'claude-sonnet-4.5', startedAt: Date.now(), activity: [{ at: Date.now(), kind: 'tool', message: 'winapp ui inspect -a App' }] } },
    tickets: [{ key: 'NEO-1', summary: 'Uno', stage: 'reproduce', status: 'running' }, { key: 'NEO-2', summary: 'Dos', stage: 'fix', status: 'blocked', note: 'Necesita datos', iterations: 2 }, { key: 'NEO-3', summary: 'Tres', stage: 'done', status: 'done', archived: true }] };
  const html = jiraView(state, { view: 'board', board }, { isAuthenticated: true, models: [{ id: 'claude-opus-4.5', name: 'Claude Opus 4.5', multiplier: 3 }] });
  for (const name of ['Recolectar', 'Reproducir', 'Solucionar', 'Verificar', 'Resueltos']) assert.match(html, new RegExp(`<h2>${name} `));
  assert.match(html, /<section class="jira-column mode-auto" aria-label="Recolectar">[\s\S]*?Sin IA[\s\S]*?<\/header>/, 'collecting has no model: it is done by code');
  assert.doesNotMatch(html, /data-jira-model="collect"/);
  assert.match(html, /<option value="claude-opus-4\.5" selected>Claude Opus 4\.5 · ×3/);
  assert.match(html, /data-action="jira-auto" data-on="false"[^>]*>.*Pausar/, 'started: the button pauses');
  assert.match(html, /data-action="jira-learnings" data-stage="fix"/, 'each column opens its own lessons');
  assert.match(html, /data-stage="fix" data-mode="auto" class="light-auto" aria-pressed="true"/, 'every column starts on autopilot');
  assert.match(html, /winapp ✗/);
  assert.match(html, /winapp ui inspect -a App/, 'the card in progress shows what its agent is doing');
  assert.match(html, /<section class="jira-column is-active mode-auto" aria-label="Reproducir">/, 'and its column is highlighted');
  assert.match(html, /status-running[\s\S]*data-action="jira-stop"/, 'it is stopped from the card');
  assert.doesNotMatch(html, /jira-running/, 'there is no separate progress panel');
  assert.match(html, /Necesita datos/);
  assert.doesNotMatch(html, /NEO-3 · Tres/, 'tickets taken off the board are hidden');
  assert.match(html, /Mostrar 1 quitados/);
  assert.match(jiraView({ mode: 'azure', jira: null }, {}), /id="jira-settings-form"/, 'without settings the section is the form');
  const signedOut = jiraView(state, { view: 'board', board: { ...board, pipeline: { auto: false, running: null, needsCopilot: true, error: 'Sin sesión' } } }, { isAuthenticated: true });
  assert.match(signedOut, /Iniciar sesión en GitHub Copilot[\s\S]*copilot<\/code> → <code>\/login/, 'without a Copilot session it shows how to sign in, as in pull request reviews');
  assert.doesNotMatch(html, /Iniciar sesión en GitHub Copilot/);
});

test('the ticket popup has a tab per completed step and the answer field while stuck', () => {
  const ticket = { key: 'NEO-3', summary: 'Tres', stage: 'reproduce', status: 'blocked', question: '¿Qué impresora?', url: 'https://e/browse/NEO-3' };
  const board = { settings: { modes: {} }, pipeline: {}, tickets: [ticket] };
  const detail = { key: 'NEO-3', folder: '/t/NEO-3', files: ['resumen.md', 'reproduccion-1.md', 'evidencias/1.png', 'descripcion.md'], description: '# NEO-3', comments: '', answers: [],
    history: [{ stage: 'collect', number: 1, outcome: 'ok', report: 'resumen.md', finishedAt: '2026-10-06T10:00:00Z', model: 'claude-haiku-4.5', posted: true },
      { stage: 'reproduce', number: 1, outcome: 'blocked', report: 'reproduccion-1.md', question: '¿Qué impresora?', finishedAt: '2026-10-06T10:05:00Z' }],
    reports: [{ stage: 'collect', number: 1, report: 'resumen.md', text: 'Resumen del ticket' }, { stage: 'reproduce', number: 1, report: 'reproduccion-1.md', text: 'No falla con mis impresoras' }] };
  const html = ticketDetail(board, detail, false, { 'NEO-3': 'Borrador' });
  assert.deepEqual([...html.matchAll(/data-action="jira-tab" data-tab="([^"]+)" aria-selected="(true|false)">([^<]+)</g)].map(m => [m[1], m[2], m[3]]), [['step-0', 'false', 'Recolectar'], ['step-1', 'true', 'Reproducir 1'], ['ticket', 'false', 'Ticket']], 'the latest step is open');
  assert.match(html, /No falla con mis impresoras/);
  assert.match(html, /evidencias\/1\.png/, 'with the files of that step');
  assert.match(html, /<textarea data-jira-answer="NEO-3"[^>]*>Borrador<\/textarea>/, 'the answer field keeps the draft');
  assert.match(html, /Abrir en Jira ↗/);
  const first = ticketDetail(board, detail, false, {}, 'step-0');
  assert.match(first, /Resumen del ticket/);
  assert.match(first, /En Jira/, 'and whether it was published in Jira');
  assert.match(ticketDetail(board, detail, false, {}, 'ticket'), /data-part="description" open/);
});

test('with logs on, each step is published as a Jira comment', async () => {
  const text = logComment({ stage: 'reproduce', outcome: 'blocked', report: '# Informe\n{noformat}x', question: '¿Qué impresora?' });
  assert.match(text, /^\*Neo Team · agente Reproducir:\* Bloqueado/);
  assert.match(text, /\*Pregunta:\* ¿Qué impresora\?/);
  assert.equal(text.match(/\{noformat\}/g).length, 2, 'the report cannot close the block early');
  let sent;
  const client = new JiraClient({ url: 'https://e.atlassian.net', deployment: 'cloud', email: 'a@b.c' }, 't', { fetch: async (url, options) => { sent = [url.pathname, options.method, JSON.parse(options.body)]; return jsonResponse({ id: '9' }, 201); } });
  await client.addComment('NEO-1', 'hola');
  assert.deepEqual(sent, ['/rest/api/2/issue/NEO-1/comment', 'POST', { body: 'hola' }]);
});

test('tickets show their type and priority with icons like Jira', () => {
  const color = html => html.match(/<rect width="16" height="16" rx="3" fill="([^"]+)"/)?.[1];
  assert.equal(color(typeIcon('Bug')), '#e5493a');
  assert.equal(color(typeIcon('Error')), '#e5493a');
  assert.equal(color(typeIcon('Tarea')), '#4bade8');
  assert.equal(color(typeIcon('Historia')), '#63ba3c');
  assert.equal(color(typeIcon('Épica')), '#904ee2');
  assert.match(typeIcon('Subtarea'), /<rect x="4" y="4"/, 'a subtask is not a task');
  assert.equal(color(typeIcon('Tipo propio')), '#8993a4');
  assert.match(priorityIcon('Highest'), /#cd1317[\s\S]*#cd1317/);
  assert.match(priorityIcon('Más alta'), /#cd1317/);
  assert.match(priorityIcon('Alta'), /#e9494a/);
  assert.match(priorityIcon('Media'), /#e97f33/);
  assert.match(priorityIcon('Low'), /#0065ff/);
  assert.match(priorityIcon('Lowest'), /#0065ff[\s\S]*#0065ff/);
  assert.match(priorityIcon('Medium'), /<title>Prioridad: Medium<\/title>/);
  assert.equal(typeIcon(''), '');
  const board = { settings: {}, pipeline: {}, tickets: [{ key: 'NEO-9', summary: 'x', stage: 'collect', status: 'pending', type: 'Bug', priority: 'High' }] };
  assert.match(jiraView({ mode: 'azure', jira: {} }, { view: 'board', board }), /<header><svg class="jira-type"[^>]*aria-label="Bug"[\s\S]*<svg class="jira-priority"[^>]*aria-label="Prioridad: High"/);
});

test('ticket texts, comments and reports are shown formatted and safe', () => {
  const html = markdown(`## Pasos
1. Abrir **Facturas**
  - con *filtro* y \`Exportar\`
2. Ver ![captura 1.png](adjuntos/captura%201.png) y [el vídeo](adjuntos/video.mp4)

> cita de @ana

| Campo | Valor |
| --- | --- |
| A | 1 |

\`\`\`
<b>código</b>
\`\`\`
<script>alert(1)</script> [malo](javascript:alert(1)) <https://jira/x>`, { fileUrl: path => `/f?path=${encodeURIComponent(path)}` });
  assert.match(html, /<h4>Pasos<\/h4>/);
  assert.match(html, /<ol><li>Abrir <strong>Facturas<\/strong><ul><li>con <em>filtro<\/em> y <code>Exportar<\/code><\/li><\/ul><\/li><li>/);
  assert.match(html, /<img class="md-image" src="\/f\?path=adjuntos%2Fcaptura%201\.png" alt="captura 1\.png"/, 'images of the ticket are shown');
  assert.match(html, /<code title="adjuntos\/video\.mp4">el vídeo<\/code>/, 'other local files are named, not linked');
  assert.match(html, /<blockquote><p>cita de <span class="md-mention">@ana<\/span><\/p><\/blockquote>/);
  assert.match(html, /<thead><tr><th>Campo<\/th><th>Valor<\/th><\/tr><\/thead><tbody><tr><td>A<\/td><td>1<\/td><\/tr>/);
  assert.match(html, /<pre class="md-code"><code>&lt;b&gt;código&lt;\/b&gt;<\/code><\/pre>/);
  assert.doesNotMatch(html, /<script|href="javascript/i, 'nothing in a ticket becomes HTML or a script');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<a href="https:\/\/jira\/x" target="_blank"/);
  assert.match(markdown('![x](adjuntos/a.png)'), /<code title="adjuntos\/a\.png">x<\/code>/, 'without fileUrl images are named');
  assert.match(markdown('![x](../../secreto.png)', { fileUrl: p => p }), /<code/, 'paths out of the ticket are not requested');
});

test('collecting is done by code, without AI: an index of the ticket', async t => {
  const root = await temp(t), folder = join(root, 'NEO-5');
  await mkdir(join(folder, 'adjuntos', 'grabacion.mp4.fotogramas'), { recursive: true });
  await writeFile(join(folder, 'descripcion.md'), '# NEO-5 · Falla\n\n## Descripción\n\n1. Abrir **Facturas**\n2. Pulsar `Exportar`\n\nSale mal.\n\n## Adjuntos\n\n- x\n');
  await writeFile(join(folder, 'comentarios.json'), JSON.stringify([{ author: 'Ana', body: 'También:\n1. Repetir con importes negativos' }]));
  await writeFile(join(folder, 'adjuntos', 'captura.png'), 'png');
  await writeFile(join(folder, 'adjuntos', 'grabacion.mp4'), 'mp4');
  for (const n of ['001', '002']) await writeFile(join(folder, 'adjuntos', 'grabacion.mp4.fotogramas', `${n}.png`), 'png');
  const result = await collectSummary(folder, { key: 'NEO-5', summary: 'Falla', type: 'Bug', priority: 'High' });
  assert.deepEqual([result.outcome, result.model, result.usage], ['ok', null, null]);
  assert.match(result.report, /1\. Abrir \*\*Facturas\*\*\n2\. Pulsar `Exportar`\n3\. Repetir con importes negativos/, 'steps of the description and the comments');
  assert.match(result.report, /1 · el último de Ana/);
  assert.match(result.report, /\[captura\.png\]\(adjuntos\/captura\.png\) · imagen/);
  assert.match(result.report, /\[grabacion\.mp4\]\(adjuntos\/grabacion\.mp4\) · vídeo · 2 fotogramas en adjuntos\/grabacion\.mp4\.fotogramas\//);
  const empty = join(root, 'NEO-6');
  await mkdir(empty, { recursive: true });
  await writeFile(join(empty, 'descripcion.md'), '# NEO-6 · Nada\n\n## Descripción\n\n(sin descripción)\n');
  const blocked = await collectSummary(empty, { key: 'NEO-6', summary: 'Nada' });
  assert.equal(blocked.outcome, 'blocked', 'with nothing to go on it asks instead of spending an agent');
  assert.match(blocked.question, /Qué hay que reproducir/);

  // The pipeline runs it without calling any agent or listing Copilot models.
  const tickets = new TicketStore(root);
  await tickets.update('NEO-5', () => newTicket({ summary: 'Falla' }));
  const pipeline = new JiraPipeline({ tickets, agent: { run: () => { throw new Error('no agent'); } }, settings: async () => ({ models: {} }), models: () => { throw new Error('no models'); } });
  await pipeline.runStage('NEO-5');
  const ticket = await tickets.get('NEO-5');
  assert.deepEqual([ticket.stage, ticket.history[0].outcome, ticket.history[0].model], ['reproduce', 'ok', null]);
  assert.match(await readFile(join(folder, 'resumen.md'), 'utf8'), /Resumen de NEO-5 \(automático\)/);
});

test('who a ticket is assigned to is visible, and tickets of others stay out of the automatic mode', async t => {
  assert.match(assigneeView({ name: 'Lucía Martín', me: false }), /<span class="jira-avatar"[^>]*>LM<\/span>Lucía Martín<\/span>/);
  assert.match(assigneeView({ name: 'Pablo T', me: true }), /class="jira-assignee me"[\s\S]*Pablo T · tú/);
  assert.match(assigneeView(null), /Sin asignar/);
  assert.equal(autoLocked({ assignee: { me: false } }), true, 'assigned to someone else');
  assert.equal(autoLocked({ assignee: { me: true } }), false);
  assert.equal(autoLocked({ assignee: null }), false);
  assert.equal(autoLocked({ assignee: { me: false }, autoLock: false }), false, 'it can be let in');
  assert.equal(autoLocked({ assignee: null, autoLock: true }), true, 'or kept out by hand');

  const root = await temp(t), tickets = new TicketStore(root), ran = [];
  await tickets.update('NEO-1', () => ({ ...newTicket({ summary: 'Otro' }), stage: 'reproduce', assignee: { id: 'x', name: 'Otra', me: false } }));
  await tickets.update('NEO-2', () => ({ ...newTicket({ summary: 'Mío' }), stage: 'reproduce', assignee: { id: 'yo', name: 'Yo', me: true } }));
  const pipeline = new JiraPipeline({ tickets, settings: async () => ({ models: {} }), agent: { run: async ({ ticket }) => { ran.push(ticket.key); return { outcome: 'blocked', report: 'r' }; }, abort: async () => {} } });
  pipeline.setAuto(true);
  for (let i = 0; i < 50 && (pipeline.looping || !ran.length); i++) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(ran, ['NEO-2'], 'the automatic mode only took the ticket that is not someone else\'s');
  pipeline.auto = false;
  await pipeline.enqueue('NEO-1');
  for (let i = 0; i < 50 && pipeline.looping; i++) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(ran, ['NEO-2', 'NEO-1'], 'with ▶ on it, it runs');
});
