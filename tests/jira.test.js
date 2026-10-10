import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jqlFrom, jiraSettingsFrom, wikiToMarkdown, attachmentNames, safeName, JiraClient, collectTicket } from '../server/jira.js';
import { autoLocked, easeFrom, runBuild, collectSummary, logComment, nextAfter, defaultModel, modelFor, permissionFor, stagePrompt, systemMessage, TicketStore, JiraPipeline, AgentConversation, DemoAgent, ensureWorktree, newTicket, checkKey, collectJql, collectScopeFrom, collectFilter, syncTickets } from '../server/jira-agents.js';
import { jiraView, ticketDetail, ticketHead, typeIcon, priorityIcon, markdown, assigneeView, matchesTicket, easeView, pendingComments, commentPrompt } from '../dist/jira.js';
import { loginSteps } from '../dist/reviews.js';

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

test('updating collects the whole filter, only your tickets or a single one', async t => {
  assert.equal(collectJql('project = NEO ORDER BY updated DESC', { mode: 'filter' }), 'project = NEO ORDER BY updated DESC');
  assert.equal(collectJql('project = NEO ORDER BY updated DESC', { mode: 'mine' }), '(project = NEO) AND assignee = currentUser() ORDER BY updated DESC');
  assert.equal(collectJql('10020', { mode: 'mine' }), '(filter = 10020) AND assignee = currentUser()');
  assert.equal(collectJql('ORDER BY created', { mode: 'mine' }), 'assignee = currentUser() ORDER BY created');
  assert.equal(collectJql('project = NEO ORDER BY updated DESC', { mode: 'single', key: 'NEO-7' }), '(project = NEO) AND issuekey = NEO-7 ORDER BY updated DESC', 'one ticket, of the filter');
  assert.throws(() => collectJql('1', { mode: 'single', key: '' }), /clave del ticket/);
  assert.deepEqual(collectScopeFrom({ mode: 'single', key: ' https://e.atlassian.net/browse/neo-12 ' }), { mode: 'single', key: 'NEO-12' }, 'the key or its address');
  assert.deepEqual(collectScopeFrom(undefined), { mode: 'filter', key: '' });
  assert.throws(() => collectScopeFrom({ mode: 'single', key: 'hola' }), /no es válido/);

  const tickets = new TicketStore(await temp(t)), queries = [];
  const issue = (key, assignee) => ({ key, fields: { summary: key, updated: '2026-10-01', assignee } });
  const client = {
    search: async jql => { queries.push(jql); return { issues: [issue('NEO-1', { accountId: 'yo', displayName: 'Yo' }), issue('NEO-2', { accountId: 'otra', displayName: 'Otra' })], limited: false }; },
    issue: async key => ({ key, fields: { summary: key, status: { name: 'Open' }, updated: '2026-10-01' } }), comments: async () => [], download: async () => new Response(''),
  };
  const run = scope => collectFilter({ client, settings: { url: 'https://e.atlassian.net', filter: 'project = NEO' }, tickets, me: { id: 'yo' }, scope });
  assert.deepEqual([(await run({ mode: 'mine' })).downloaded, (await tickets.list()).map(x => x.key)], [1, ['NEO-1']], 'only yours');
  await tickets.update('NEO-9', () => newTicket({ key: 'NEO-9' }));
  assert.equal((await run({ mode: 'single', key: 'NEO-2' })).left, 0, 'one ticket does not tell which ones left the filter');
  assert.deepEqual((await tickets.list()).map(x => [x.key, x.inFilter]), [['NEO-1', true], ['NEO-2', true], ['NEO-9', true]]);
  await assert.rejects(run({ mode: 'single', key: 'NEO-5' }), /NEO-5 no está en el filtro/);
  assert.equal((await run({ mode: 'filter' })).left, 1, 'the whole filter does');
  assert.deepEqual(queries.slice(0, 2), ['(project = NEO) AND assignee = currentUser()', '(project = NEO) AND issuekey = NEO-2']);
});

test('the board chooses what updating brings and shares the state of a ticket', () => {
  const state = { mode: 'azure', jira: { url: 'https://e', filter: '1', hasToken: true } };
  const tickets = [{ key: 'NEO-1', summary: 'Uno', stage: 'analyze', status: 'pending', history: [{ stage: 'collect' }] },
    { key: 'NEO-2', summary: 'Dos', stage: 'fix', status: 'pending', history: [{ stage: 'collect' }], shared: { id: '9', author: 'Ana', created: '2026-10-10T10:00:00Z' } },
    { key: 'NEO-3', summary: 'Tres', stage: 'analyze', status: 'pending', history: [], shared: { id: '5', created: '2026-10-10T10:00:00Z' }, sharedSeen: '5' }];
  const view = collect => jiraView(state, { view: 'board', board: { settings: { ...state.jira, collect }, pipeline: {}, tickets } }, { isAuthenticated: true, models: [] });
  assert.match(view({ mode: 'mine', key: '' }), /<select data-jira-collect[^>]*>[\s\S]*?<option value="mine" selected>Asignados a mí/);
  assert.doesNotMatch(view({ mode: 'mine', key: '' }), /data-jira-collect-key/);
  assert.match(view({ mode: 'single', key: 'NEO-7' }), /<input data-jira-collect-key[^>]*value="NEO-7"/);
  const html = view({ mode: 'filter', key: '' }), card = key => html.match(new RegExp(`aria-label="${key} · [^"]+">([\\s\\S]*?)</article>`))[1];
  assert.match(card('NEO-1'), /data-action="jira-share"/);
  assert.doesNotMatch(card('NEO-1'), /jira-resume/);
  assert.match(card('NEO-2'), /data-action="jira-resume"[^>]*title="Traer el estado que subió Ana/, 'what another computer shared is offered');
  assert.doesNotMatch(card('NEO-3'), /data-action="jira-(resume|share)"/, 'nothing to share yet, and its own state is not offered back');
});

test('with one ticket or only yours, updating downloads nothing else from the board', async t => {
  const tickets = new TicketStore(await temp(t)), searches = [], downloads = [];
  for (const key of ['NEO-1', 'NEO-2', 'NEO-3']) await tickets.update(key, () => ({ ...newTicket({ key }), stage: 'analyze', updated: '2026-10-01T00:00:00Z' }));
  const assignees = { 'NEO-1': { accountId: 'yo' }, 'NEO-2': { accountId: 'otra' }, 'NEO-3': null };
  const client = {
    search: async jql => { searches.push(jql); return { issues: ['NEO-1', 'NEO-2', 'NEO-3'].filter(k => jql.includes(k)).map(key => ({ key, fields: { updated: '2026-10-02T00:00:00Z', assignee: assignees[key], status: { statusCategory: { key: 'indeterminate' } } } })) }; },
    issue: async key => { downloads.push(key); return { key, fields: { summary: key, updated: '2026-10-02T00:00:00Z' } }; }, comments: async () => [], download: async () => new Response(''),
  };
  const sync = scope => syncTickets({ client, settings: { url: 'https://e' }, tickets, me: { id: 'yo' }, scope });
  assert.deepEqual((await sync({ mode: 'single', key: 'NEO-3' })).updated.map(u => u.key), ['NEO-3']);
  assert.deepEqual([searches.at(-1), downloads], ['key in (NEO-3)', ['NEO-3']], 'only that ticket is asked for and downloaded');
  assert.deepEqual((await sync({ mode: 'mine' })).updated.map(u => u.key), ['NEO-1'], 'only yours are downloaded');
  assert.equal((await tickets.get('NEO-2')).updated, '2026-10-01T00:00:00Z', 'the rest stay as they were, to be downloaded with the whole filter');
  assert.deepEqual((await sync({ mode: 'filter' })).updated.map(u => u.key), ['NEO-2']);
});

test('tickets move between columns and back to fix while verification fails', () => {
  const t = { iterations: 1, reproduceAttempts: 1 };
  assert.deepEqual(nextAfter(t, 'collect', 'ok'), { stage: 'analyze', status: 'pending' });
  assert.deepEqual(nextAfter(t, 'analyze', 'analyzed'), { stage: 'reproduce', status: 'pending' });
  assert.deepEqual(nextAfter(t, 'analyze', 'blocked'), { stage: 'analyze', status: 'blocked' });
  assert.deepEqual(nextAfter(t, 'reproduce', 'reproduced'), { stage: 'fix', status: 'pending' });
  assert.deepEqual(nextAfter(t, 'reproduce', 'not_reproduced'), { stage: 'reproduce', status: 'pending' });
  assert.equal(nextAfter({ reproduceAttempts: 2 }, 'reproduce', 'not_reproduced').status, 'blocked');
  assert.deepEqual(nextAfter(t, 'fix', 'fixed'), { stage: 'verify', status: 'pending' }, 'a fix waits in Verificar, which builds it first');
  assert.deepEqual(nextAfter(t, 'build', 'built'), { stage: 'verify', status: 'pending' });
  assert.deepEqual(nextAfter(t, 'build', 'build_failed', 3), { stage: 'fix', status: 'pending' });
  assert.deepEqual(nextAfter({ iterations: 3 }, 'build', 'build_failed', 3), { stage: 'build', status: 'blocked', note: 'No compila tras 3 correcciones.' });
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
  assert.match(reproduce, /reproducir\.ps1 in the ticket folder: a PowerShell script that starts with the application already open[\s\S]*do not launch it in the script/, 'the reproduction is left ready to replay on the fixed build');
  assert.match(reproduce, /section «Para verificar»: preconditions and data, the exact steps, the observation point/);
  assert.match(reproduce, /Lessons of the Verificar agent[\s\S]*<lessons_verify>\n\(none yet\)/, 'and it reads what the verification learned');
  const verify = stagePrompt({ stage: 'verify', ticket, folder: '/t/NEO-1', files: [], settings, lessons: { reproduce: '- El botón Exportar tarda' }, previous: { reproduce: '/t/NEO-1/reproduccion-1.md' } });
  assert.match(verify, /Lessons of the Reproducir agent[\s\S]*<lessons_reproduce>\n- El botón Exportar tarda/, 'the verification reads what the reproduction learned');
  assert.match(verify, /Latest reproduction report: \/t\/NEO-1\/reproduccion-1\.md/);
  assert.match(verify, /Start by reading the latest reproduction report \(its «Para verificar» section\) and reproducir\.ps1/);
  assert.match(verify, /where the reproduction saw the wrong result, the expected behavior must now appear/, 'same steps, changed behavior');
  assert.match(verify, /before \(from the reproduction\) and now, side by side/);
  assert.match(reproduce, /not configured: find it/, 'without a launch command the agent finds it and learns it');
  const fix = stagePrompt({ stage: 'fix', ticket, folder: '/t/NEO-1', files: [], settings, worktree: { path: '/t/NEO-1/codigo', branch: 'neo/NEO-1' }, previous: { verify: '/t/NEO-1/verificacion-1.md' } });
  assert.match(fix, /\/t\/NEO-1\/codigo — a separate git worktree of \/r on branch neo\/NEO-1/);
  assert.match(fix, /previous fix did not pass verification/);
  assert.match(fix, /Do not build the application: the next step, «Compilar», builds it with `dotnet build`/);
  assert.match(stagePrompt({ stage: 'fix', ticket: { ...ticket, lastOutcome: 'build_failed' }, folder: '/t/NEO-1', files: [], settings, previous: { build: '/t/NEO-1/compilacion-1.md' } }), /did not build: read the latest build report[\s\S]*Latest build report: \/t\/NEO-1\/compilacion-1\.md|Latest build report: \/t\/NEO-1\/compilacion-1\.md[\s\S]*did not build: read the latest build report/);
  assert.match(stagePrompt({ stage: 'verify', ticket, folder: '/t/NEO-1', files: [], settings }), /built right before you started, as the first part of this step[\s\S]*do not build again/);
  assert.doesNotMatch(fix, /winapp ui/);
  assert.doesNotMatch(fix, /lessons_reproduce|lessons_verify/, 'the other agents keep only their own');
  assert.match(systemMessage('verify'), /neo_learn/);
});

test('verifying starts by building: a failure goes back to fix before any agent checks it', async t => {
  const root = await temp(t), tickets = new TicketStore(root);
  await tickets.update('NEO-1', () => ({ ...newTicket({ summary: 'Falla' }), stage: 'fix' }));
  const runs = [];
  const agent = { run: async options => {
    runs.push(options);
    await options.onLearn('general', 'Compilar con dotnet build');
    await options.onLearn('general', 'Compilar con dotnet build');
    return { outcome: options.stage === 'verify' ? 'verified' : 'fixed', report: 'Cambio en A.cs', model: options.model, usage: { inputTokens: 10, outputTokens: 5 } };
  }, abort: async () => {} };
  const builds = [{ ok: false, code: 1, log: 'error CS1002' }, { ok: true, code: 0, log: 'ok' }], built = [];
  const pipeline = new JiraPipeline({ tickets, agent, settings: async () => ({ repository: '/r', buildCommand: 'dotnet build', maxIterations: 3, models: {} }),
    worktree: async () => ({ path: join(root, 'NEO-1', 'codigo'), branch: 'neo/NEO-1' }), build: async (command, cwd) => { built.push([command, cwd]); return builds.shift() ?? { ok: true, code: 0, log: 'ok' }; }, models: async () => [{ id: 'claude-opus-4.5' }] });
  await pipeline.runStage('NEO-1');
  let ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status, ticket.iterations], ['verify', 'pending', 1], 'the fix waits in Verificar');
  assert.equal(built.length, 0, 'fixing does not build');
  assert.equal(runs[0].model, 'claude-opus-4.5');
  assert.equal(runs[0].workingDirectory, join(root, 'NEO-1', 'codigo'));
  assert.deepEqual(runs[0].writable, [join(root, 'NEO-1'), join(root, 'NEO-1', 'codigo')]);
  assert.equal(runs[0].customInstructions, true, 'the fix agent follows the repository instructions');
  await pipeline.runStage('NEO-1');
  ticket = await tickets.get('NEO-1');
  assert.deepEqual(built, [['dotnet build', join(root, 'NEO-1', 'codigo')]], 'verifying builds first, in the worktree, without an agent');
  assert.deepEqual([ticket.stage, ticket.status, ticket.lastOutcome, runs.length], ['fix', 'pending', 'build_failed', 1], 'a build that fails goes back to fix, without verifying');
  assert.match(await readFile(join(root, 'NEO-1', 'compilacion-1.md'), 'utf8'), /No compila \(código 1\)[\s\S]*error CS1002/);
  assert.equal(await readFile(join(root, 'NEO-1', 'compilacion-1.log'), 'utf8'), 'error CS1002');
  await pipeline.runStage('NEO-1');
  assert.match(runs[1].prompt, /did not build: read the latest build report/);
  assert.match(runs[1].prompt, /Latest build report: .*compilacion-1\.md/);
  await pipeline.runStage('NEO-1');
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.iterations, ticket.history.map(h => `${h.stage}:${h.outcome}`)], ['done', 2, ['fix:fixed', 'build:build_failed', 'fix:fixed', 'build:built', 'verify:verified']], 'built, it is verified right away');
  assert.match(runs[2].prompt, /built right before you started, as the first part of this step/);
  const lessons = await tickets.learnings('general');
  assert.equal(lessons.match(/Compilar con dotnet build/g).length, 1);
  await tickets.update('NEO-1', t => ({ ...t, stage: 'verify', status: 'pending' }));
  await pipeline.runStage('NEO-1');
  assert.equal(built.length, 3, 'every verification builds again, right before');

  // Stopping leaves the step pending, without counting it as a failure.
  await tickets.update('NEO-1', t => ({ ...t, stage: 'verify', status: 'pending' }));
  let release;
  pipeline.agent = { run: () => new Promise((_, reject) => { release = () => reject(Object.assign(new Error('Detenido.'), { stopped: true })); }), abort: async () => release() };
  const running = pipeline.runStage('NEO-1');
  for (let i = 0; i < 50 && !release; i++) await new Promise(done => setTimeout(done, 10));
  assert.equal(pipeline.snapshot().running.key, 'NEO-1');
  await pipeline.stop(); await running;
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status, ticket.history.at(-1).outcome], ['verify', 'pending', 'stopped']);

  // A build is stopped too, and without a command it asks for one.
  pipeline.build = (command, cwd, { signal }) => new Promise(done => signal.addEventListener('abort', () => done({ ok: false, code: null, log: '', stopped: true })));
  const building = pipeline.runStage('NEO-1');
  await new Promise(done => setTimeout(done, 20));
  await pipeline.stop(); await building;
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status, ticket.history.at(-1).outcome], ['build', 'pending', 'stopped']);
  pipeline.settings = async () => ({ repository: '/r', buildCommand: '', maxIterations: 3, models: {} });
  await pipeline.runStage('NEO-1');
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status], ['build', 'blocked']);
  assert.match(ticket.question, /comando de compilación/);
});

test('the build command runs in its folder and stops when asked', async t => {
  const dir = await temp(t);
  const ok = await runBuild('node -e "console.log(process.cwd())"', dir);
  assert.deepEqual([ok.ok, ok.code, ok.stopped], [true, 0, false]);
  assert.match(ok.log, new RegExp(dir.split('/').at(-1)));
  assert.deepEqual([(await runBuild('node -e "process.exit(3)"', dir)).ok, (await runBuild('node -e "process.exit(3)"', dir)).code], [false, 3]);
  const control = new AbortController();
  const slow = runBuild('node -e "setTimeout(() => {}, 60000)"', dir, { signal: control.signal });
  setTimeout(() => control.abort(), 50);
  assert.deepEqual([(await slow).ok, (await slow).stopped], [false, true]);
});

test('rewinding undoes the latest step and the ticket does it again', async t => {
  const root = await temp(t), tickets = new TicketStore(root);
  const step = (stage, number, outcome, report) => ({ stage, number, outcome, report, finishedAt: '2026-10-10T10:00:00Z' });
  await tickets.update('NEO-1', () => ({ ...newTicket({ summary: 'Falla' }), stage: 'verify', status: 'pending', iterations: 1, reproduceAttempts: 1, lastOutcome: 'fixed',
    history: [step('collect', 1, 'ok', 'resumen.md'), step('analyze', 1, 'analyzed', 'analisis.md'), step('reproduce', 1, 'reproduced', 'reproduccion-1.md'), step('fix', 1, 'fixed', 'solucion-1.md')] }));
  const runs = [];
  const agent = { run: async options => { runs.push(options); return { outcome: 'fixed', report: 'Otra vez', model: null, usage: null }; }, abort: async () => {} };
  const pipeline = new JiraPipeline({ tickets, agent, demo: true, settings: async () => ({ repository: '/r', maxIterations: 3, models: {}, modes: { verify: 'off' } }) });
  await pipeline.rewind('NEO-1');
  let ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.status, ticket.iterations, ticket.lastOutcome], ['fix', 'pending', 0, 'reproduced'], 'back to the column of the step undone');
  assert.deepEqual(ticket.history.map(h => [h.stage, !!h.rewound]), [['collect', false], ['analyze', false], ['reproduce', false], ['fix', true]], 'the step stays in the history, marked');
  // The agent does it again without the report of the step undone.
  await pipeline.enqueue('NEO-1');
  for (let i = 0; i < 50 && (await tickets.get('NEO-1')).history.length < 5; i++) await new Promise(done => setTimeout(done, 10));
  assert.doesNotMatch(runs[0].prompt, /solucion-1\.md/);
  assert.deepEqual((await tickets.get('NEO-1')).history.slice(4).map(h => [h.stage, h.number, h.report]), [['fix', 2, 'solucion-2.md']], 'numbered after the one undone');
  for (let i = 0; i < 100 && (pipeline.looping || pipeline.running); i++) await new Promise(done => setTimeout(done, 10));
  await pipeline.rewind('NEO-1'); await pipeline.rewind('NEO-1');
  ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.reproduceAttempts, ticket.iterations], ['reproduce', 0, 0]);
  await pipeline.rewind('NEO-1');
  assert.equal((await tickets.get('NEO-1')).stage, 'analyze');
  await assert.rejects(pipeline.rewind('NEO-1'), /No hay ningún paso que rebobinar/, 'collecting is not undone');
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
  assert.deepEqual([...html.matchAll(/<section class="jira-column[^"]*" aria-label="([^"]+)">/g)].map(m => m[1]), ['Analizar', 'Reproducir', 'Solucionar', 'Verificar'], 'a column per agent: collecting, building and the solved ones have none');
  const flow = jiraView(state, { view: 'board', board: { ...board, pipeline: {}, tickets: [{ key: 'NEO-7', summary: 'Hecho', stage: 'done', status: 'done' }, { key: 'NEO-8', summary: 'Por compilar', stage: 'build', status: 'pending' }, { key: 'NEO-9', summary: 'Nuevo', stage: 'collect', status: 'pending' }] } }, { isAuthenticated: true, models: [] });
  const column = name => flow.match(new RegExp(`aria-label="${name}">([\\s\\S]*?)</section>`))[1];
  assert.match(column('Verificar'), /NEO-8[\s\S]*<article class="jira-card status-done[^"]*"[^>]*aria-label="NEO-7 · Hecho"/, 'the solved ones stay in Verificar, at the end and highlighted, as one waiting for its build');
  assert.doesNotMatch(column('Verificar').match(/aria-label="NEO-7 · Hecho">([\s\S]*?)<\/article>/)[1], /data-action="jira-(run|done|autolock)"/, 'with nothing left to do');
  assert.match(column('Analizar'), /NEO-9/, 'a ticket being indexed shows in Analizar');
  assert.match(html, /aria-label="Reproducir">[\s\S]*?data-action="jira-warn" data-stage="reproduce"/, 'an agent that lacks something it needs warns');
  assert.doesNotMatch(html, /data-stage="analyze" aria-expanded/, 'and one that has everything does not');
  const tip = jiraView(state, { view: 'board', board, warn: 'reproduce' }, { isAuthenticated: true, models: [] });
  assert.match(tip, /<span class="jira-warn-tip" role="tooltip"><strong>Falta<\/strong><ul><li>winapp: instálalo<\/li><\/ul>/, 'clicking it lists what to install');
  assert.doesNotMatch(html, /data-jira-model="collect"/);
  assert.match(html, /<option value="claude-opus-4\.5" selected>Claude Opus 4\.5 · ×3/);
  assert.match(html, /data-action="jira-auto" data-on="false"[^>]*aria-label="Pausar">❚❚<\/button>/, 'started: the button pauses');
  assert.match(html, /data-action="jira-learnings" data-stage="fix"/, 'each column opens its own lessons');
  assert.match(html, /data-stage="fix" data-mode="auto" class="light-auto" aria-pressed="true"/, 'every column starts on autopilot');
  assert.match(html, /winapp ui inspect -a App/, 'the card in progress shows what its agent is doing');
  assert.match(html, /<section class="jira-column is-active mode-auto" aria-label="Reproducir">/, 'and its column is highlighted');
  assert.match(html, /status-running[\s\S]*data-action="jira-stop"/, 'it is stopped from the card');
  assert.doesNotMatch(html, /jira-running/, 'there is no separate progress panel');
  assert.match(html, /Necesita datos/);
  assert.doesNotMatch(html, /NEO-3 · Tres/, 'tickets taken off the board are hidden');
  assert.match(html, /Mostrar 1 quitados/);
  assert.match(jiraView({ mode: 'azure', jira: null }, {}), /id="jira-settings-form"/, 'without settings the section is the form');
  const signedOut = jiraView(state, { view: 'board', board: { ...board, pipeline: { auto: false, running: null, needsCopilot: true, error: 'Sin sesión' } } }, { isAuthenticated: true });
  assert.doesNotMatch(signedOut, /Iniciar sesión en GitHub Copilot/, 'signing in is not in the middle of the board');
  const signedOutTip = jiraView(state, { view: 'board', warn: 'analyze', board: { ...board, pipeline: { auto: false, running: null, needsCopilot: true, error: 'Sin sesión' } } }, { isAuthenticated: true });
  assert.match(signedOutTip, /data-stage="analyze"[\s\S]*<li><button class="link-button" data-action="jira-copilot-login">Copilot: inicia sesión<\/button><\/li>/, 'without a Copilot session the warning of each agent links to signing in');
  assert.match(loginSteps(), /copilot<\/code> → <code>\/login/, 'which shows how, as in pull request reviews');
});

test('the ticket popup has a tab per completed step and the answer field while stuck', () => {
  const ticket = { key: 'NEO-3', summary: 'Tres', stage: 'reproduce', status: 'blocked', question: '¿Qué impresora?', url: 'https://e/browse/NEO-3' };
  const board = { settings: { modes: {} }, pipeline: {}, tickets: [ticket] };
  const detail = { key: 'NEO-3', folder: '/t/NEO-3', files: ['resumen.md', 'reproduccion-1.md', 'evidencias/1.png', 'descripcion.md'], description: '# NEO-3', comments: '', answers: [],
    history: [{ stage: 'collect', number: 1, outcome: 'ok', report: 'resumen.md', finishedAt: '2026-10-06T10:00:00Z', model: 'claude-haiku-4.5', posted: true },
      { stage: 'reproduce', number: 1, outcome: 'blocked', report: 'reproduccion-1.md', question: '¿Qué impresora?', finishedAt: '2026-10-06T10:05:00Z' }],
    reports: [{ stage: 'collect', number: 1, report: 'resumen.md', text: 'Resumen del ticket' }, { stage: 'reproduce', number: 1, report: 'reproduccion-1.md', text: 'No falla con mis impresoras' }] };
  const html = ticketDetail(board, detail, false, { 'NEO-3': 'Borrador' });
  assert.deepEqual([...html.matchAll(/data-action="jira-tab" data-tab="([^"]+)" aria-selected="(true|false)">([^<]+)</g)].map(m => [m[1], m[2], m[3]]), [['ticket', 'false', 'Ticket'], ['step-0', 'false', 'Recolectar'], ['step-1', 'true', 'Reproducir 1']], 'the ticket comes first and the latest step is open');
  assert.match(html, /No falla con mis impresoras/);
  assert.match(html, /evidencias\/1\.png/, 'with the files of that step');
  assert.match(html, /<textarea data-jira-answer="NEO-3"[^>]*>Borrador<\/textarea>/, 'the answer field keeps the draft');
  const head = ticketHead(board, 'NEO-3', false);
  assert.match(head, /^<div class="jira-head"><h2 id="modal-title"><a class="jira-title-link" href="https:\/\/e\/browse\/NEO-3" target="_blank" rel="noopener noreferrer" title="Abrir en Jira">NEO-3 · Tres<\/a><\/h2>/, 'the key and title open it in Jira');
  assert.match(head, /<p class="jira-meta">[\s\S]*<span>Reproducir<\/span><span>Necesita ayuda<\/span><\/p><\/div>$/, 'what describes it goes next to the title');
  assert.doesNotMatch(html, /Abrir en Jira/, 'with no separate link');
  assert.doesNotMatch(ticketHead({ ...board, tickets: [{ ...ticket, status: 'pending' }] }, 'NEO-3', false), /Pendiente/, 'pending is the usual state: it is not said');
  assert.doesNotMatch(ticketHead(board, 'NEO-3', true), /<a /, 'the example links nowhere');
  const first = ticketDetail(board, detail, false, {}, 'step-0');
  assert.match(first, /Resumen del ticket/);
  assert.match(first, /En Jira/, 'and whether it was published in Jira');
  assert.doesNotMatch(html, /data-action="jira-(rewind|run|autolock|archive|open-folder)"|data-jira-move/, 'the popup leaves every action to the card, and has no column picker');
  const byHand = ticketDetail(board, { ...detail, history: [{ ...detail.history[0], by: 'person', model: null }] }, false, {}, 'step-0');
  assert.match(byHand, /Hecho por ti/);
  assert.match(ticketDetail(board, { ...detail, history: [{ ...detail.history[0], rewound: '2026-10-10T10:00:00Z' }] }, false, {}, 'step-0'), /<span class="pill" title="Deshecho [^"]+">Rebobinado<\/span>/);
  const cardHtml = jiraView({ mode: 'azure', jira: { url: 'https://e', filter: '1' } }, { view: 'board', board: { ...board, settings: { url: 'https://e', filter: '1' } } }, null);
  assert.doesNotMatch(cardHtml, /data-action="jira-done"/, 'there is no «done by hand» any more');
  const rewindCard = jiraView({ mode: 'azure', jira: { url: 'https://e', filter: '1' } }, { view: 'board', board: { ...board, settings: { url: 'https://e', filter: '1' }, tickets: [{ ...ticket, history: [{ stage: 'collect', number: 1 }, { stage: 'build', number: 2, outcome: 'build_failed' }, { stage: 'fix', number: 3, rewound: '2026-10-10' }] }] } }, null);
  assert.match(rewindCard, /class="icon-button jira-rewind" data-action="jira-rewind" data-key="NEO-3" title="Rebobinar: deshacer Compilar 2 y volver a Verificar"/, 'the latest step not undone yet, in the column it shows in');
  assert.doesNotMatch(jiraView({ mode: 'azure', jira: { url: 'https://e', filter: '1' } }, { view: 'board', board: { ...board, settings: { url: 'https://e', filter: '1' }, tickets: [{ ...ticket, history: [{ stage: 'collect', number: 1 }] }] } }, null), /jira-rewind/, 'collecting is not rewound');
  assert.match(cardHtml, /<span class="jira-card-tools"><button class="icon-button jira-tool" data-action="jira-open-folder" data-key="NEO-3"[^>]*><svg[\s\S]*?<button class="icon-button jira-tool" data-action="jira-archive" data-key="NEO-3" data-archived="true" title="Quitar del tablero \(su carpeta se conserva\)"/, 'its folder opens and it leaves the board from its card');
  const archivedCard = jiraView({ mode: 'azure', jira: { url: 'https://e', filter: '1' } }, { view: 'board', showArchived: true, board: { ...board, settings: { url: 'https://e', filter: '1' }, tickets: [{ ...ticket, archived: true }] } }, null);
  assert.match(archivedCard, /data-action="jira-archive" data-key="NEO-3" data-archived="false" title="Volver al tablero"/, 'and comes back the same way');
  assert.match(ticketDetail(board, detail, false, {}, 'ticket'), /data-part="description" open/);
});

test('the analysis estimates how easy a ticket is to reproduce and fix, shown as bars', () => {
  const prompt = stagePrompt({ stage: 'analyze', ticket: { key: 'NEO-1', summary: 'Falla' }, folder: '/t/NEO-1', files: ['descripcion.md'], settings: { repository: '/r' } });
  assert.match(prompt, /look at the code in \/r \(read only\)/);
  assert.match(prompt, /Do not launch the application, do not build and do not change code/);
  assert.match(stagePrompt({ stage: 'reproduce', ticket: { key: 'NEO-1', summary: 'Falla' }, folder: '/t/NEO-1', files: [], settings: {}, previous: { analyze: '/t/NEO-1/analisis-1.md' } }), /Analysis of the ticket: \/t\/NEO-1\/analisis-1\.md/, 'the next agents read it');
  assert.deepEqual(easeFrom({ reproduce: 'easy', fix: 'medium', reason: '  Un solo sitio.  ' }), { reproduce: 'easy', fix: 'medium', reason: 'Un solo sitio.' });
  assert.equal(easeFrom({ reproduce: 'trivial', fix: 'easy' }), null);
  const bars = html => (html.match(/class="on"/g) ?? []).length;
  assert.equal(bars(easeView({ reproduce: 'easy', fix: 'easy' })), 3);
  assert.equal(bars(easeView({ reproduce: 'easy', fix: 'hard', reason: 'Toca el motor de cálculo' })), 1, 'the harder of the two decides');
  assert.match(easeView({ reproduce: 'medium', fix: 'easy', reason: 'Faltan datos' }), /title="Facilidad media · reproducir: con dudas · solución: sencilla · Faltan datos"/);
  assert.equal(easeView(null), '');
  const state = { mode: 'azure', jira: { url: 'https://e', filter: '1' } };
  const board = { settings: state.jira, pipeline: {}, tickets: [{ key: 'NEO-1', summary: 'Uno', stage: 'reproduce', status: 'pending', ease: { reproduce: 'easy', fix: 'easy', reason: 'Claro' } }] };
  const html = jiraView(state, { view: 'board', board }, null);
  assert.match(html, /<h2><span class="jira-column-name">Analizar</, 'the analysis has its column');
  assert.match(html, /data-key="NEO-1"[\s\S]*class="jira-ease ease-3"/, 'and its card shows how easy it looks');
});

test('a step cut off when Neo Team stopped goes back to pending, to be run again', async t => {
  const root = await temp(t), tickets = new TicketStore(root);
  await tickets.update('NEO-1', () => ({ ...newTicket({ summary: 'Cortado' }), stage: 'fix', status: 'running', iterations: 1 }));
  await tickets.update('NEO-2', () => ({ ...newTicket({ summary: 'En marcha' }), stage: 'reproduce', status: 'running' }));
  await tickets.update('NEO-3', () => ({ ...newTicket({ summary: 'Bloqueado' }), stage: 'verify', status: 'blocked', note: 'Pregunta' }));
  const pipeline = new JiraPipeline({ tickets, agent: {}, settings: async () => ({ models: {} }) });
  pipeline.running = { key: 'NEO-2', stage: 'reproduce', activity: [] };
  await pipeline.recover();
  const [cut, busy, blocked] = await Promise.all(['NEO-1', 'NEO-2', 'NEO-3'].map(key => tickets.get(key)));
  assert.deepEqual([cut.stage, cut.status, cut.iterations], ['fix', 'pending', 1]);
  assert.match(cut.note, /Solucionar se interrumpió/);
  assert.equal(busy.status, 'running', 'the step running now is left alone');
  assert.deepEqual([blocked.status, blocked.note], ['blocked', 'Pregunta']);
  const html = jiraView({ mode: 'azure', jira: { url: 'https://e', filter: '1' } }, { view: 'board', board: { settings: { url: 'https://e', filter: '1' }, pipeline: {}, tickets: [cut] } }, null);
  assert.match(html, /data-action="jira-run" data-key="NEO-1"/, 'and it can be run again from its card');
});

test('talking to the agent works like a chat: interrupt, ask, get an answer and go on', async () => {
  // A fake session: each turn waits until it is aborted or let finish.
  const turns = [];
  let finishTurn, reported = false;
  const conversation = new AgentConversation({ waitMs: 60000,
    send: next => new Promise(done => { turns.push(next); finishTurn = done; }),
    abort: async () => finishTurn(),
  });
  const states = [];
  conversation.onState = state => states.push(state);
  const tick = () => new Promise(done => setTimeout(done, 5));
  const running = conversation.run({ prompt: 'Arregla el ticket', timeoutMs: 1000, finished: () => reported });
  await tick();
  await conversation.tell('¿Qué estás mirando?');
  await tick();
  assert.equal(turns.length, 2, 'the message interrupts the turn in progress');
  assert.equal(turns[1].person, true);
  assert.match(turns[1].prompt, /<person_message>\n¿Qué estás mirando\?\n<\/person_message>/);
  assert.match(turns[1].prompt, /If it is a question, answer it and end your turn/);
  finishTurn(); await tick();
  assert.equal(conversation.state, 'waiting', 'after answering, it waits for the person');
  await conversation.tell('Mira primero Exportador.cs');
  await tick();
  assert.match(turns[2].prompt, /Mira primero Exportador\.cs/, 'a message while it waits is its next turn');
  finishTurn(); await tick();
  conversation.resume(); await tick();
  assert.match(turns[3].prompt, /go on with your task where you left it/, 'Continuar lets it go on');
  await conversation.pause(); await tick();
  assert.equal(conversation.state, 'waiting', 'Pausar interrupts it and it waits');
  conversation.resume(); await tick();
  reported = true; finishTurn();
  await running;
  assert.equal(turns.length, 5);
  assert.deepEqual([...new Set(states)], ['working', 'waiting']);

  // Without an answer, it goes on alone after a while.
  const alone = [];
  const quiet = new AgentConversation({ waitMs: 10, send: async next => { alone.push(next.prompt); if (alone.length === 3) reported = true; }, abort: async () => {} });
  reported = false;
  quiet.inbox.push('¿Vas bien?');
  await quiet.run({ prompt: 'Empieza', timeoutMs: 1000, finished: () => reported });
  assert.match(alone.at(-1), /did not answer/);
});

test('the person talks to the agent from its live log, and the log stays after the step', async t => {
  const root = await temp(t), tickets = new TicketStore(root);
  await tickets.update('NEO-1', () => ({ ...newTicket({ summary: 'Falla' }), stage: 'fix' }));
  const pipeline = new JiraPipeline({ tickets, agent: new DemoAgent({ delayMs: 30 }), demo: true, settings: async () => ({ models: {} }) });
  await assert.rejects(pipeline.tell('Hola'), /Ningún agente está trabajando/);
  const running = pipeline.runStage('NEO-1');
  await new Promise(done => setTimeout(done, 15));
  await assert.rejects(pipeline.tell('   '), /Escribe el mensaje/);
  await pipeline.tell('¿Dónde estás?');
  for (let i = 0; i < 50 && pipeline.running?.conversation !== 'waiting'; i++) await new Promise(done => setTimeout(done, 10));
  assert.equal(pipeline.snapshot().running.conversation, 'waiting', 'it answered and waits');
  assert.deepEqual(pipeline.running.activity.filter(a => ['person', 'agent'].includes(a.kind)).map(a => a.kind), ['person', 'agent']);
  assert.match(pipeline.running.activity.find(a => a.kind === 'agent').message, /Respuesta simulada/);
  await pipeline.pause(false);
  await running;
  const ticket = await tickets.get('NEO-1');
  assert.deepEqual([ticket.stage, ticket.history.at(-1).outcome], ['verify', 'fixed'], 'and then it finished its task');
  assert.ok(ticket.history.at(-1).activity.some(a => a.kind === 'agent'), 'the conversation stays in the log of the step');
  const last = pipeline.snapshot().last;
  assert.deepEqual([last.key, last.outcome], ['NEO-1', 'fixed'], 'the log stays on view after the step');
  pipeline.running = { key: 'NEO-1', stage: 'build', activity: [] };
  await assert.rejects(pipeline.tell('Más rápido'), /Compilar no usa un agente/);
  pipeline.running = null;

  // On the board: the prompt with Enviar, Pausar or Continuar and Detener; then the last log, closable.
  const state = { mode: 'azure', jira: { url: 'https://e', filter: '1' } };
  const board = pipelineState => ({ settings: state.jira, pipeline: pipelineState, tickets: [{ key: 'NEO-1', summary: 'Uno', stage: pipelineState.running?.stage ?? 'build', status: pipelineState.running ? 'running' : 'pending' }] });
  const live = run => jiraView(state, { view: 'board', board: board({ running: { key: 'NEO-1', startedAt: Date.now(), activity: [], ...run } }), tell: 'Borrador' }, null);
  const working = live({ stage: 'fix', conversation: 'working' });
  assert.match(working, /<section class="jira-activity"[\s\S]*<textarea data-jira-tell[^>]*>Borrador<\/textarea><button[^>]*data-action="jira-tell"[\s\S]*data-action="jira-pause" data-on="true"[\s\S]*data-action="jira-stop"/);
  const waiting = live({ stage: 'fix', conversation: 'waiting' });
  assert.match(waiting, /Esperando tu respuesta/);
  assert.match(waiting, /data-action="jira-pause" data-on="false"[^>]*>Continuar/);
  const building = live({ stage: 'build' }).match(/aria-label="Logs en vivo"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(building, /data-jira-tell|jira-pause/, 'a step without an agent can only be stopped');
  const after = jiraView(state, { view: 'board', board: board({ last }) }, null);
  assert.match(after, /Registro de la fase<\/strong><span>NEO-1 · Solucionar · Corregido<\/span><button[^>]*data-action="jira-close-log"/);
  assert.doesNotMatch(jiraView(state, { view: 'board', board: board({ last }), closedLog: String(last.startedAt) }, null), /jira-close-log/, 'until it is closed');
});

test('every step keeps its log in the ticket and its agent can be talked to afterwards', async t => {
  const root = await temp(t), tickets = new TicketStore(root);
  await tickets.update('NEO-1', () => ({ ...newTicket({ summary: 'Uno' }), stage: 'fix' }));
  await tickets.update('NEO-2', () => ({ ...newTicket({ summary: 'Dos' }) }));
  await mkdir(join(root, 'NEO-2'), { recursive: true });
  await writeFile(join(root, 'NEO-2', 'descripcion.md'), '# NEO-2\n\n## Descripción\n\n1. Abrir\n2. Guardar\n');
  const pipeline = new JiraPipeline({ tickets, agent: new DemoAgent({ delayMs: 20 }), demo: true, settings: async () => ({ models: {} }), chatAgent: () => new DemoAgent({ delayMs: 5, waitMs: 60000 }) });
  const wait = async (check, label) => { for (let i = 0; i < 200 && !(await check()); i++) await new Promise(done => setTimeout(done, 10)); assert.ok(await check(), label); };

  // ▶ on a ticket in Recolectar while another one is at work: it is collected now and queued.
  await tickets.update('NEO-1', t => ({ ...t, autoLock: true }));
  await pipeline.enqueue('NEO-1');
  await wait(() => pipeline.running?.key === 'NEO-1', 'NEO-1 is at work');
  await pipeline.enqueue('NEO-2');
  let two = await tickets.get('NEO-2');
  assert.deepEqual([two.stage, two.status, two.history[0].outcome], ['analyze', 'pending', 'ok'], 'collected at once, without waiting');
  assert.deepEqual([pipeline.snapshot().queue, pipeline.running.key], [['NEO-2'], 'NEO-1'], 'and queued for Analizar');
  assert.match(await readFile(join(root, 'NEO-2', 'registros', 'recolectar-1.log'), 'utf8'), /\[result\] Descripción: sí · 0 comentarios · 0 adjuntos · 2 pasos enumerados/);
  await wait(() => !pipeline.looping, 'both are done');
  assert.deepEqual((await tickets.get('NEO-2')).history.slice(0, 2).map(h => h.stage), ['collect', 'analyze'], 'then it went on with Analizar');

  // The log of each step is in the ticket: in its history and complete in registros/.
  let one = await tickets.get('NEO-1');
  const fix = one.history[0];
  assert.equal(fix.log, 'registros/solucionar-1.log');
  await pipeline.writeLog('NEO-1', 'x', []);
  assert.match(await readFile(join(root, 'NEO-1', fix.log), 'utf8'), /\[info\] Editando Facturas\/Exportador\.cs[\s\S]*Solucionar finalizado/);

  // Talking to the agent of a step that ended: its answer goes to the log of that step.
  await pipeline.talkToStep('NEO-1', 0, '¿Qué cambiaste?');
  await wait(async () => (await tickets.get('NEO-1')).history[0].activity.some(a => a.kind === 'agent'), 'the agent of the step answers');
  assert.equal(pipeline.snapshot().chats['NEO-1#0'], 'waiting');
  await pipeline.talkToStep('NEO-1', 0, '¿Y por qué?');
  await wait(async () => (await tickets.get('NEO-1')).history[0].activity.filter(a => a.kind === 'agent').length === 2, 'the same chat goes on');
  await pipeline.stopChat('NEO-1', 0);
  assert.equal(pipeline.snapshot().chats['NEO-1#0'], undefined);
  one = await tickets.get('NEO-1');
  assert.deepEqual(one.history[0].activity.filter(a => ['person', 'agent'].includes(a.kind)).map(a => a.kind), ['person', 'agent', 'person', 'agent', 'person']);
  await pipeline.writeLog('NEO-1', 'x', []);
  assert.match(await readFile(join(root, 'NEO-1', fix.log), 'utf8'), /Tú: ¿Qué cambiaste\?[\s\S]*Respuesta simulada a «¿Y por qué\?»/);
  await assert.rejects(pipeline.talkToStep('NEO-1', 9, 'Hola'), /Ese paso ya no está/);

  // The general assistant: its conversation is kept in the tickets folder until started anew.
  await pipeline.talkGeneral('Quita los aprendizajes repetidos');
  await wait(() => pipeline.general.activity.some(a => a.kind === 'agent'), 'the assistant answers');
  assert.equal(pipeline.snapshot().general.conversation, 'waiting');
  await pipeline.stopGeneral();
  await pipeline.saveGeneral();
  assert.match(await readFile(join(root, 'asistente.json'), 'utf8'), /Quita los aprendizajes repetidos/);
  await pipeline.resetGeneral();
  assert.deepEqual(JSON.parse(await readFile(join(root, 'asistente.json'), 'utf8')), { sessionId: null, activity: [] });
});

test('nothing reaches Jira from the agents: no token, no Neo Team data and no web', () => {
  const guard = { writable: ['/t/NEO-1'], cwd: '/t/NEO-1', hidden: ['/app/.neo-team'], visible: ['/app/.neo-team/jira'], blocked: ['empresa.atlassian.net', 'jira.empresa.local'] };
  const shell = command => permissionFor({ kind: 'shell', fullCommandText: command }, guard).kind;
  for (const command of ['curl -X POST https://jira.empresa.local/rest/api/2/issue/NEO-1/comment', 'Invoke-RestMethod -Uri $u -Method Post', 'iwr https://example.com', 'type C:\\app\\.neo-team\\jira-token', 'echo %NEO_TEAM_JIRA_TOKEN%', 'node -e "fetch(\'https://x\')"', 'cat /app/.neo-team/workspace.json']) assert.equal(shell(command), 'reject', command);
  for (const command of ['dotnet build App.sln', 'winapp ui inspect -a App', 'cat /app/.neo-team/jira/NEO-1/descripcion.md']) assert.equal(shell(command), 'approve-once', command);
  assert.equal(permissionFor({ kind: 'read', path: '/app/.neo-team/jira-token' }, guard).kind, 'reject');
  assert.equal(permissionFor({ kind: 'read', path: '/app/.neo-team/jira/NEO-1/descripcion.md' }, guard).kind, 'approve-once');
  assert.equal(permissionFor({ kind: 'url', url: 'https://empresa.atlassian.net' }, guard).kind, 'reject');
  assert.match(systemMessage('fix'), /Never contact Jira or any web service and never publish anything/);
});

test('the board is filtered by key or title while typing', () => {
  const ticket = { key: 'NEO-102', summary: 'El filtro de clientes se pierde al volver' };
  for (const search of ['', 'neo-102', '102', 'CLIENTES', 'filtro volver', 'NEO clientés']) assert.ok(matchesTicket(ticket, search), search);
  for (const search of ['NEO-103', 'impresora', 'filtro impresora']) assert.ok(!matchesTicket(ticket, search), search);
  const state = { mode: 'azure', jira: { url: 'https://e', filter: '1' } };
  const board = { settings: state.jira, pipeline: {}, tickets: [{ ...ticket, stage: 'reproduce', status: 'pending' }, { key: 'NEO-103', summary: 'Error al imprimir', stage: 'fix', status: 'pending' }] };
  const html = jiraView(state, { view: 'board', board, search: 'impri' }, null);
  assert.match(html, /<label class="jira-search"><svg[\s\S]*?<\/svg><input type="search" data-jira-search data-focus="jira-search" value="impri"[^>]*><\/label>/, 'with a funnel');
  assert.match(html, /<div class="jira-board-controls">\s*<button[^>]*data-action="jira-refresh"[\s\S]*?<span class="jira-links"><button class="button jira-square" data-action="jira-auto"[^>]*>[^<]*<\/button><button class="icon-button jira-gear" data-action="jira-settings"[\s\S]*?<\/span><\/div><div class="jira-board">/, 'updating first; starting and the settings on the right');
  assert.doesNotMatch(html.match(/<div class="jira-board-controls">[\s\S]*?<\/div><div class="jira-board">/)[0], /jira-search/);
  assert.match(html, /<\/div><div class="jira-board-foot"><label class="jira-search">/, 'the search, below the board');
  assert.match(html, /Error al imprimir/);
  assert.doesNotMatch(html, /El filtro de clientes/, 'in every column');
});

test('each agent step proposes a Jira comment, sent only once confirmed', async () => {
  const text = logComment({ stage: 'reproduce', outcome: 'blocked', report: '# Informe\n{noformat}x', question: '¿Qué impresora?' });
  assert.match(text, /^\*Neo Team · agente Reproducir:\* Bloqueado/);
  assert.match(text, /\*Pregunta:\* ¿Qué impresora\?/);
  assert.equal(text.match(/\{noformat\}/g).length, 2, 'the report cannot close the block early');
  let sent;
  const client = new JiraClient({ url: 'https://e.atlassian.net', deployment: 'cloud', email: 'a@b.c' }, 't', { fetch: async (url, options) => { sent = [url.pathname, options.method, JSON.parse(options.body)]; return jsonResponse({ id: '9' }, 201); } });
  await client.addComment('NEO-1', 'hola');
  assert.deepEqual(sent, ['/rest/api/2/issue/NEO-1/comment', 'POST', { body: 'hola' }]);
});

test('a comment ready for Jira is asked about, and can be decided from its step', () => {
  const ticket = { key: 'NEO-4', summary: 'Cuatro', stage: 'fix', status: 'pending', history: [{ stage: 'collect', number: 1, outcome: 'ok' }, { stage: 'analyze', number: 1, outcome: 'analyzed', finishedAt: '2026-10-06T10:00:00Z', pendingComment: '*Neo Team · agente Analizar:* <b>Analizado</b>' }] };
  const board = { settings: { modes: {} }, pipeline: {}, tickets: [ticket] };
  assert.deepEqual(pendingComments(board), [{ key: 'NEO-4', index: 1, stage: 'analyze', text: '*Neo Team · agente Analizar:* <b>Analizado</b>' }]);
  const prompt = commentPrompt(pendingComments(board)[0]);
  assert.match(prompt.body, /&lt;b&gt;Analizado/, 'the text to publish is shown, escaped');
  assert.match(prompt.actions, /data-action="jira-comment" data-key="NEO-4" data-index="1" data-publish="false">No publicar[\s\S]*data-publish="true">Publicar en Jira/);
  const step = ticketDetail(board, { key: 'NEO-4', folder: '/t', files: [], history: ticket.history, reports: [] }, false, {}, 'step-1');
  assert.match(step, /data-action="jira-comment" data-key="NEO-4" data-index="1" data-publish="true"/);
  assert.doesNotMatch(jiraView({ mode: 'azure', jira: {} }, { view: 'board', board }), /jira-logs/, 'there is no switch to publish everything');
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
  assert.deepEqual([ticket.stage, ticket.history[0].outcome, ticket.history[0].model], ['analyze', 'ok', null]);
  assert.match(await readFile(join(folder, 'resumen.md'), 'utf8'), /Resumen de NEO-5 \(automático\)/);
});

test('an agent that lacks what it needs does not run, by hand or in the automatic mode', async t => {
  const root = await temp(t), tickets = new TicketStore(root), ran = [];
  await tickets.update('NEO-1', () => ({ ...newTicket({ summary: 'Uno' }), stage: 'analyze' }));
  await tickets.update('NEO-9', () => ({ ...newTicket({ summary: 'Nueve' }), stage: 'analyze', autoLock: true }));
  let missing = { copilot: true };
  const pipeline = new JiraPipeline({ tickets, settings: async () => ({ models: {} }), missing: async () => missing, agent: { run: async ({ ticket }) => { ran.push(ticket.key); return { outcome: 'blocked', report: 'r' }; }, abort: async () => {} } });
  await assert.rejects(pipeline.enqueue('NEO-1'), /Analizar no puede trabajar: falta sesión de Copilot/);
  pipeline.setAuto(true);
  for (let i = 0; i < 10; i++) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(ran, [], 'the automatic mode leaves it waiting');
  missing = {};
  await pipeline.enqueue('NEO-1');
  for (let i = 0; i < 50 && !ran.length; i++) await new Promise(done => setTimeout(done, 10));
  assert.deepEqual(ran, ['NEO-1'], 'once it has everything, it runs');
  for (let i = 0; i < 100 && (pipeline.looping || pipeline.running); i++) await new Promise(done => setTimeout(done, 10));

  const board = { settings: { modes: { collect: 'off' } }, tools: { winapp: false, ffmpeg: true }, pipeline: {}, tickets: [{ key: 'NEO-2', summary: 'Dos', stage: 'reproduce', status: 'pending' }, { key: 'NEO-3', summary: 'Tres', stage: 'analyze', status: 'pending' }] };
  const html = jiraView({ mode: 'azure', jira: {} }, { view: 'board', board }, { isAuthenticated: true });
  assert.match(html, /<button class="icon-button jira-run" disabled title="No se puede ejecutar: falta winapp" aria-label="Ejecutar NEO-2">/, 'its ▶ is disabled');
  assert.match(html, /data-action="jira-run" data-key="NEO-3"/, 'while an agent with everything can run');
  assert.doesNotMatch(html, /data-stage="collect" data-mode/, 'collecting has no traffic light');
  const noFfmpeg = jiraView({ mode: 'azure', jira: {} }, { view: 'board', board: { ...board, tools: { winapp: true, ffmpeg: false } }, warn: 'analyze' }, { isAuthenticated: true });
  assert.match(noFfmpeg, /aria-label="Analizar">[\s\S]*?<li>ffmpeg: instálalo<\/li>/, 'without ffmpeg, Analizar warns');
  assert.match(noFfmpeg, /data-action="jira-run" data-key="NEO-3"/, 'but it still runs: ffmpeg is only for the frames');
  assert.doesNotMatch(noFfmpeg.match(/class="jira-board-controls">([\s\S]*?)<\/div>/)[1], /jira-warn/, 'downloading warns of nothing');
  assert.match(html.match(/class="jira-board-controls">([\s\S]*?)<\/div>/)[1], /data-action="jira-refresh"[^>]*aria-label="Actualizar"><svg/, 'one button updates from Jira, in the row above the board');
  assert.doesNotMatch(html, /data-action="jira-(collect|sync)"/, 'instead of two');
  const news = jiraView({ mode: 'azure', jira: {} }, { view: 'board', board: { ...board, tickets: [{ key: 'NEO-4', summary: 'Cuatro', stage: 'fix', status: 'pending', news: { comments: 2, attachments: 1 } }] } }, { isAuthenticated: true });
  assert.match(news, /<span class="pill jira-news" title="Desde Jira: 2 comentarios y 1 adjunto nuevos\. Ábrelo para verlo">Novedades<\/span>/, 'a ticket with news from Jira shows it');
  assert.match(html, /<textarea data-jira-tell data-general="true"[^>]*placeholder="Pide algo al asistente[^>]*><\/textarea><button[^>]*>Enviar/, 'with a Copilot session the assistant can be asked');
  assert.doesNotMatch(html, /data-stage="general"/);
  const signedOut = jiraView({ mode: 'azure', jira: {} }, { view: 'board', board }, { isAuthenticated: false });
  assert.match(signedOut, /<strong>Asistente<\/strong><span class="jira-warn"><button class="jira-warn-icon" data-action="jira-warn" data-stage="general"/, 'without it, the assistant warns');
  assert.match(signedOut, /placeholder="Inicia sesión en Copilot para usar el asistente" aria-label="Mensaje para el asistente general" disabled><\/textarea><button class="button small primary" data-action="jira-tell" data-general="true"[^>]*disabled>Enviar/, 'and cannot be asked');
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
