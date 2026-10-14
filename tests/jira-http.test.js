import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('HTTP Jira board in the example: collect, run the agents to the end and learn', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-jira-http-'));
  const port = 14363, url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, NEO_TEAM_PORT: String(port), NEO_TEAM_DATA_DIR: directory, NEO_TEAM_DEMO_AGENT_MS: '0', NEO_TEAM_JIRA_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

  // Every section has its own address and reloading it gives the page.
  for (const path of ['/jira', '/jira/NEO-101', '/mantenimiento/NEO-101', '/mantenimiento/configuracion', '/mantenimiento/lista', '/revision-prs/abc123', '/planificacion/capacidad', '/mi-iteracion', '/planes-prueba', '/pipelines', '/pipelines/12', '/mantenimiento', '/permisos']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<script type="module" src="\/app\.js">/);
  }
  // Every module the interface imports is served: one missing stops the whole page.
  for (const file of await readdir(new URL('../dist/', import.meta.url))) {
    if (!file.endsWith('.js')) continue;
    for (const [, imported] of (await readFile(new URL(`../dist/${file}`, import.meta.url), 'utf8')).matchAll(/^import .* from '\.\/([^']+)';$/gm)) assert.equal((await fetch(`${url}/${imported}`)).status, 200, `${file} imports ${imported}`);
  }
  for (const path of ['/jira/x.js', '/otra', '/server/index.js']) assert.equal((await fetch(url + path)).status, 404, path);
  assert.equal(state.jira, null, 'without settings there is no board');
  assert.equal((await post('/api/jira-refresh')).status, 400);
  const invalid = await post('/api/jira-settings', { settings: { url: 'https://empresa.atlassian.net', deployment: 'cloud', email: 'yo@empresa.com', filter: '' } });
  assert.deepEqual([invalid.status, invalid.data.field], [400, 'filter'], 'the error names the field to correct')
  // Saving checks the connection at once; nothing answers here, so it is saved and reported.
  const saved = await post('/api/jira-settings', { settings: { url: 'localhost:9/', deployment: 'cloud', email: 'yo@empresa.com', filter: 'https://empresa.atlassian.net/issues/?filter=10500', maxIterations: 2 }, token: 'secreto' });
  assert.equal(saved.status, 400);
  assert.match(saved.data.error, /Configuración guardada, pero Jira no aceptó la conexión/);
  assert.equal(saved.data.field, 'url');
  state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.jira.url, 'https://localhost:9');
  assert.equal(state.jira.hasToken, true);
  assert.ok(!JSON.stringify(state).includes('secreto'), 'the token never reaches the interface');
  assert.ok(!(await readFile(join(directory, 'workspace.json'), 'utf8')).includes('secreto'), 'nor the workspace file');

  await post('/api/mode', { mode: 'demo' });
  const collected = await post('/api/jira-refresh');
  assert.equal(collected.status, 200);
  assert.deepEqual([collected.data.result.collect.found, collected.data.result.collect.downloaded, collected.data.result.sync.checked], [3, 3, 0], 'the first update downloads the filter');
  assert.deepEqual([collected.data.jira.pipeline.feed.at(-1).family, collected.data.jira.pipeline.feed.at(-1).title], ['jira', 'Actualizado desde Jira: 3 descargados'], 'the activity tells it, curated');
  const folder = join(directory, 'jira-ejemplo', 'NEO-101');
  assert.deepEqual(collected.data.jira.tickets.map(t => [t.stage, t.history.map(h => h.stage)]), [['analyze', ['collect']], ['analyze', ['collect']], ['analyze', ['collect']]], 'downloading also indexes: new tickets go straight to Analizar');
  assert.match(await readFile(join(folder, 'resumen.md'), 'utf8'), /NEO-101/);
  assert.deepEqual((await readdir(join(folder, 'adjuntos'))), ['captura-exportar.png']);
  assert.match(await readFile(join(folder, 'comentarios.md'), 'utf8'), /!\[captura-exportar\.png\]\(adjuntos\/captura-exportar\.png\)/, 'comments point to the local attachment');
  assert.match(await readFile(join(folder, 'descripcion.md'), 'utf8'), /1\. Abrir \*\*Facturas\*\*/);
  // The state of a ticket goes to Jira (in the example, it stays in memory).
  const shared = await post('/api/jira-share', { key: 'NEO-101' });
  assert.equal(shared.status, 200);
  assert.ok(shared.data.result.files >= 2);
  const sharedTicket = shared.data.jira.tickets.find(x => x.key === 'NEO-101');
  assert.ok(sharedTicket.shared.id && sharedTicket.shared.id === sharedTicket.sharedSeen, 'what this computer shared is not offered back to it');
  const again2 = await post('/api/jira-share', { key: 'NEO-101' });
  const replacedTicket = again2.data.jira.tickets.find(x => x.key === 'NEO-101');
  assert.deepEqual([again2.status, again2.data.result.replaced, replacedTicket.shared.id !== sharedTicket.shared.id, replacedTicket.sharedOwn], [200, true, true, replacedTicket.shared.id], 'uploading again replaces the previous one this computer uploaded');
  // Someone else's newer state, not brought here: the upload stops so it is brought first.
  const stateFile = join(directory, 'jira-ejemplo', 'NEO-101', 'estado.json');
  await writeFile(stateFile, JSON.stringify({ ...JSON.parse(await readFile(stateFile, 'utf8')), sharedSeen: 'otro' }));
  const blocked = await post('/api/jira-share', { key: 'NEO-101' });
  assert.deepEqual([blocked.status, /que no has traído/.test(blocked.data.error)], [409, true]);
  // Worked on here too since it was shared: nothing is replaced, the card offers the choice.
  const edit = async change => writeFile(stateFile, JSON.stringify(change(JSON.parse(await readFile(stateFile, 'utf8')))));
  await edit(t => ({ ...t, history: [...t.history, { stage: 'analyze', number: 9, outcome: 'analyzed' }] }));
  const both = await post('/api/jira-share', { key: 'NEO-101' });
  const choosing = (await get('/api/jira')).jira.tickets.find(x => x.key === 'NEO-101');
  assert.deepEqual([both.status, both.data.reason, choosing.diverged.mine, choosing.diverged.id], [409, 'diverged', '1 paso', replacedTicket.shared.id]);
  assert.equal((await post('/api/jira-resume', { key: 'NEO-101' })).data.reason, 'diverged', 'bringing does not replace it either');
  // «Subir el mío»: it goes on as the latest one.
  const mine = await post('/api/jira-share', { key: 'NEO-101', force: true });
  const kept = mine.data.jira.tickets.find(x => x.key === 'NEO-101');
  assert.deepEqual([mine.status, mine.data.result.replaced, kept.diverged, kept.sharedSeen === kept.shared.id], [200, false, undefined, true], 'the other one is not deleted');
  // «Traer el suyo»: what was done here goes to the copies.
  await edit(t => ({ ...t, sharedSeen: 'otro', history: [...t.history, { stage: 'fix', number: 9, outcome: 'fixed' }] }));
  assert.equal((await post('/api/jira-resume', { key: 'NEO-101' })).data.reason, 'diverged');
  const theirs = await post('/api/jira-resume', { key: 'NEO-101', force: true });
  assert.deepEqual([theirs.status, theirs.data.jira.tickets.find(x => x.key === 'NEO-101').diverged], [200, undefined]);
  assert.ok(theirs.data.result.backup);
  const nothing = await post('/api/jira-resume', { key: 'NEO-102' });
  assert.deepEqual([nothing.status, /no tiene un estado compartido/.test(nothing.data.error)], [404, true]);
  const again = (await post('/api/jira-refresh')).data.result;
  assert.deepEqual([again.collect.unchanged, again.sync.checked, again.sync.updated], [3, 3, []], 'unchanged tickets are not downloaded again');
  // The ticket's images are served to the page, only with the session and inside its folder.
  const image = await fetch(`${url}/api/jira-file?key=NEO-101&path=${encodeURIComponent('adjuntos/captura-exportar.png')}&s=${state.csrf}`);
  assert.deepEqual([image.status, image.headers.get('content-type')], [200, 'image/png']);
  assert.equal((await fetch(`${url}/api/jira-file?key=NEO-101&path=adjuntos/captura-exportar.png&s=otra`)).status, 403);
  assert.equal((await fetch(`${url}/api/jira-file?key=NEO-101&path=${encodeURIComponent('../NEO-102/estado.json')}&s=${state.csrf}`)).status, 404);
  assert.equal((await fetch(`${url}/api/jira-file?key=NEO-101&path=descripcion.md&s=${state.csrf}`)).status, 404, 'only images');
  const comments = (await get('/api/jira-ticket?key=NEO-101')).ticket.commentList;
  assert.deepEqual(comments.map(c => [c.author, c.body]), [['Lucía Martín', 'Pasa también con el cliente @lmartin de pruebas. La captura es ![captura-exportar.png](adjuntos/captura-exportar.png)']]);

  assert.equal((await post('/api/jira-model', { stage: 'fix', model: 'claude-opus-4.5' })).status, 200);
  assert.equal(state.jiraModels ?? state.jira.models.fix, 'claude-opus-4.5');
  const general = await post('/api/jira-model', { stage: 'general', model: 'claude-opus-4.5', effort: 'max' });
  assert.deepEqual([general.status, state.jira.models.general, state.jira.efforts.general], [200, 'claude-opus-4.5', 'max'], 'the board\'s assistant has its own model and effort');
  assert.equal((await post('/api/jira-model', { stage: 'otra', model: '' })).status, 400);
  // Traffic lights: «off» does nothing, «ask» waits for approval, «auto» runs alone.
  assert.equal((await post('/api/jira-mode', { stage: 'fix', mode: 'off' })).status, 200);
  assert.equal(state.jira.modes.fix, 'off');
  assert.equal((await post('/api/jira-mode', { stage: 'fix', mode: 'rojo' })).status, 400);
  // Monitors: only Windows device names are kept; the rest is automatic.
  const screens = await post('/api/jira-screens', { web: '\\\\.\\DISPLAY2', app: 'otro' });
  assert.equal(screens.status, 200);
  assert.deepEqual(screens.data.jira.settings.screens, { web: '\\\\.\\DISPLAY2', app: null });
  if (process.platform !== 'win32') assert.deepEqual((await get('/api/jira-screens')).screens, []);
  assert.equal((await post('/api/jira-auto', { on: true })).status, 200);
  let board;
  const idle = async () => {
    for (let i = 0; i < 200; i++) {
      board = (await get('/api/jira')).jira;
      if (!board.pipeline.running && board.tickets.every(t => t.status !== 'running' && (t.status !== 'pending' || t.locked || ['off', 'ask'].includes(board.settings.modes?.[t.stage])))) return;
      await new Promise(done => setTimeout(done, 50));
    }
  };
  await idle();
  assert.deepEqual(board.tickets.filter(t => t.stage === 'fix').map(t => [t.key, t.status, t.iterations]), [['NEO-101', 'pending', 0], ['NEO-102', 'pending', 0]]);
  assert.equal((await post('/api/jira-run', { key: 'NEO-101' })).status, 409, 'nor by hand');
  // Who each ticket is assigned to; one assigned to someone else is left out of the automatic mode.
  assert.deepEqual(board.tickets.map(t => [t.key, t.assignee?.name ?? null, t.assignee?.me ?? null, t.locked]), [['NEO-101', 'Cuenta de ejemplo', true, false], ['NEO-102', null, null, false], ['NEO-103', 'Lucía Martín', false, true]]);
  assert.deepEqual([board.tickets[2].stage, board.tickets[2].status, board.tickets[2].history.map(h => h.stage)], ['analyze', 'pending', ['collect']], 'downloading indexed it, but the automatic mode did not touch it');
  board = (await post('/api/jira-autolock', { key: 'NEO-103', locked: false })).data.jira;
  assert.equal(board.tickets[2].locked, false, 'it can be let in');
  await idle();
  // The agent that gets stuck asks; the ticket waits for the answer.
  let stuck = board.tickets.find(t => t.key === 'NEO-103');
  assert.deepEqual([stuck.stage, stuck.status, stuck.question], ['reproduce', 'blocked', '¿Qué modelo de impresora de red y qué versión de Windows usa el cliente?']);
  assert.equal((await post('/api/jira-answer', { key: 'NEO-101', answer: 'x' })).status, 409, 'only a stuck ticket takes an answer');
  assert.equal((await post('/api/jira-answer', { key: 'NEO-103', answer: '  ' })).status, 400);

  assert.equal((await post('/api/jira-mode', { stage: 'fix', mode: 'ask' })).status, 200);
  await idle();
  assert.equal(board.tickets.find(t => t.key === 'NEO-102').iterations, 0, 'asking: nothing runs without approval');
  // ▶ works on that ticket alone, through the columns on autopilot, and pauses the rest.
  board = (await post('/api/jira-run', { key: 'NEO-102' })).data.jira;
  assert.deepEqual([board.pipeline.auto, board.pipeline.focus], [false, 'NEO-102']);
  for (let i = 0; i < 200; i++) { board = (await get('/api/jira')).jira; if (!board.pipeline.running && !board.pipeline.focus) break; await new Promise(done => setTimeout(done, 50)); }
  let byKey = Object.fromEntries(board.tickets.map(t => [t.key, t]));
  assert.deepEqual(byKey['NEO-102'].history.slice(-3).map(h => `${h.stage}:${h.outcome}`), ['fix:fixed', 'build:built', 'verify:not_fixed'], 'it went on to build and verify');
  assert.deepEqual([byKey['NEO-102'].stage, byKey['NEO-102'].status], ['fix', 'pending'], 'and waits again for approval in fix');
  assert.deepEqual([byKey['NEO-101'].stage, byKey['NEO-101'].iterations], ['fix', 0], 'the rest did nothing');

  // The answer is kept and the ticket resumes with it.
  board = (await post('/api/jira-answer', { key: 'NEO-103', answer: 'HP LaserJet M404 en red, Windows 11 23H2.' })).data.jira;
  assert.equal(board.pipeline.focus, 'NEO-103');
  for (let i = 0; i < 200; i++) { board = (await get('/api/jira')).jira; if (!board.pipeline.running && !board.pipeline.focus) break; await new Promise(done => setTimeout(done, 50)); }
  stuck = board.tickets.find(t => t.key === 'NEO-103');
  assert.deepEqual([stuck.stage, stuck.question, stuck.answers.map(a => [a.stage, a.answer])], ['fix', null, [['reproduce', 'HP LaserJet M404 en red, Windows 11 23H2.']]]);

  assert.equal((await post('/api/jira-mode', { stage: 'fix', mode: 'auto' })).status, 200);
  assert.equal((await post('/api/jira-auto', { on: true })).status, 200);
  await idle();
  byKey = Object.fromEntries(board.tickets.map(t => [t.key, t]));
  assert.deepEqual([byKey['NEO-101'].stage, byKey['NEO-101'].status], ['done', 'done']);
  assert.deepEqual([byKey['NEO-102'].stage, byKey['NEO-102'].iterations], ['done', 3], 'a failed verification and a review with comments go back to fix');
  assert.deepEqual([byKey['NEO-103'].stage, byKey['NEO-103'].status], ['done', 'done']);
  assert.deepEqual(byKey['NEO-102'].history.map(h => `${h.stage}:${h.outcome}`), ['collect:ok', 'analyze:analyzed', 'reproduce:reproduced', 'fix:fixed', 'build:built', 'verify:not_fixed', 'fix:fixed', 'build:built', 'verify:verified',
    'review:commented', 'fix:fixed', 'build:built', 'verify:verified', 'review:approved']);
  assert.deepEqual(byKey['NEO-101'].history.slice(-2).map(h => `${h.stage}:${h.outcome}`), ['verify:verified', 'review:approved'], 'every verified fix is reviewed');
  // The review is a draft pull request (simulated in the example) with its comments;
  // the fix answered each one and left the manual check for the verification.
  const review = byKey['NEO-102'].review;
  assert.ok(Number.isInteger(review.pullRequest.id) && review.pullRequest.id !== byKey['NEO-101'].review.pullRequest.id, 'a pull request per ticket');
  assert.deepEqual(review.comments.map(c => [c.id, c.severity, c.manual, c.posted, c.answers.map(a => `${a.stage}:${a.action}${a.ok === undefined ? '' : `:${a.ok}`}:${a.posted}`)]), [
    ['c1', 'minor', false, true, ['fix:changed:true']],
    ['c2', 'check', true, true, ['fix:verify:true', 'verify:checked:true:true']],
  ]);
  const detail = (await get('/api/jira-ticket?key=NEO-102')).ticket;
  assert.ok(detail.history.every(h => h.posted === undefined), 'nothing is published in Jira without asking');
  assert.ok(detail.history.every(h => ['collect', 'build'].includes(h.stage) ? !h.pendingComment : /^\*Neo Team · agente /.test(h.pendingComment)), 'each agent step leaves its comment ready; collecting and building do not');
  const analyze = detail.history.findIndex(h => h.stage === 'analyze'), fix = detail.history.findIndex(h => h.stage === 'fix');
  // Asked once: after reloading it is not asked again, but it can still be decided in its step.
  board = (await post('/api/jira-comment', { key: 'NEO-102', index: analyze, asked: true })).data.jira;
  assert.deepEqual([board.tickets.find(t => t.key === 'NEO-102').history[analyze].commentAsked, !!board.tickets.find(t => t.key === 'NEO-102').history[analyze].pendingComment], [true, true]);
  board = (await post('/api/jira-comment', { key: 'NEO-102', index: analyze, publish: true })).data.jira;
  board = (await post('/api/jira-comment', { key: 'NEO-102', index: fix, publish: false })).data.jira;
  const decided = board.tickets.find(t => t.key === 'NEO-102').history;
  assert.deepEqual([decided[analyze].posted, decided[analyze].pendingComment, decided[fix].declined, decided[fix].posted], [true, undefined, true, undefined], 'published when confirmed (simulated in the example), dropped when not');
  assert.equal((await post('/api/jira-comment', { key: 'NEO-102', index: analyze, publish: true })).status, 409, 'and only once');
  assert.equal((await post('/api/jira-comment', { key: 'NEO-102', index: 'x', publish: true })).status, 400);
  assert.equal(detail.reports.length, 14);
  assert.deepEqual([detail.ease.reproduce, detail.ease.fix], ['easy', 'medium'], 'the analysis leaves how easy it looks');
  assert.deepEqual(detail.history.find(h => h.stage === 'analyze').ease.reason, detail.ease.reason);
  assert.match(detail.reports.find(r => r.report === 'verificacion-2.md').text, /ya no ocurre/);
  assert.match(detail.reports.find(r => r.report === 'revision-1.md').text, /## Pull request[\s\S]*## Comentarios\n\n- c1 · \*\*Minor\*\* · `Clientes\/FiltroClientes\.cs:42` — The filter is saved twice[\s\S]*- c2 · \*\*Check \(manual test\)\*\*/, 'the review says where its comments are');
  assert.match(detail.reports.find(r => r.report === 'solucion-3.md').text, /## Respuestas a la revisión\n\n- c1 · \*\*Changed\*\*: [\s\S]*- c2 · \*\*Left for the manual verification\*\*/);
  assert.match(detail.reports.find(r => r.report === 'verificacion-3.md').text, /## Comprobaciones de la revisión\n\n- c2 · \*\*Verified\*\*: Closed with Escape/);
  assert.match(detail.reports.at(-1).text, /no afecta a otros usos/);
  assert.ok(detail.files.includes('resumen.md') && detail.files.includes('verificacion-2.md') && detail.files.includes('revision-2.md'));
  const learnings = (await get('/api/jira-learnings')).learnings;
  assert.match(learnings.general, /NeoDesk se abre/);
  assert.equal(learnings.general.match(/NeoDesk se abre/g).length, 1, 'a lesson is saved once');
  assert.equal((await post('/api/jira-learnings', { scope: 'fix', text: '- Compilar en Release.\n' })).status, 200);
  assert.equal((await get('/api/jira-learnings')).learnings.fix, '- Compilar en Release.\n');
  assert.equal((await post('/api/jira-learnings', { scope: '../x', text: 'a' })).status, 400);

  assert.equal((await post('/api/jira-auto', { on: false })).status, 200);
  assert.equal((await post('/api/jira-move', { key: 'NEO-103', stage: 'collect', resetIterations: true })).status, 200);
  // Synchronizing: NEO-101 was closed in Jira and NEO-102 has a new comment with a capture.
  const synced = await post('/api/jira-refresh');
  assert.equal(synced.status, 200);
  assert.deepEqual([synced.data.result.sync.closed, synced.data.result.sync.updated, synced.data.result.collect.downloaded], [['NEO-101'], [{ key: 'NEO-102', comments: 1, attachments: 1 }], 0], 'one update brings both: what finished and what changed, without downloading twice');
  const fresh = synced.data.jira.tickets.find(t => t.key === 'NEO-102');
  assert.deepEqual([fresh.news.comments, fresh.news.attachments], [1, 1], 'what is new is marked on its card');
  assert.match(await readFile(join(directory, 'jira-ejemplo', 'NEO-102', 'resumen.md'), 'utf8'), /filtro-atras\.png/, 'and its index is redone');
  assert.equal((await post('/api/jira-seen', { key: 'NEO-102' })).data.jira.tickets.find(t => t.key === 'NEO-102').news, undefined, 'until the person opens it');
  assert.ok(!synced.data.jira.tickets.some(t => t.key === 'NEO-101'), 'the one closed in Jira is deleted');
  assert.equal(await readdir(join(directory, 'jira-ejemplo', 'NEO-101')).catch(() => null), null, 'with its folder');
  assert.ok((await readdir(join(directory, 'jira-ejemplo', 'NEO-102', 'adjuntos'))).includes('filtro-atras.png'));
  assert.match(await readFile(join(directory, 'jira-ejemplo', 'NEO-102', 'comentarios.md'), 'utf8'), /Pasa también al volver con \*\*Atrás\*\*: !\[filtro-atras\.png\]\(adjuntos\/filtro-atras\.png\)/);
  assert.equal(synced.data.jira.tickets.find(t => t.key === 'NEO-102').stage, 'done', 'the column is kept');
  assert.deepEqual((await post('/api/jira-refresh')).data.result.sync.updated, [], 'nothing new the second time');
  board = (await post('/api/jira-auto', { on: false })).data.jira;
  assert.ok(!board.tickets.some(t => t.key === 'NEO-101'), 'and it does not come back from the filter');
  assert.deepEqual([board.tickets.find(t => t.key === 'NEO-103').stage, board.tickets.find(t => t.key === 'NEO-103').reproduceAttempts], ['analyze', 0], 'updating indexed it again and it is back in Analizar');
  // Done by hand: the step is recorded as the person's and the ticket goes on.
  board = (await post('/api/jira-done', { key: 'NEO-103', note: 'Analizado a mano.' })).data.jira;
  const byHand = board.tickets.find(t => t.key === 'NEO-103');
  assert.deepEqual([byHand.stage, byHand.status, byHand.history.at(-1).by, byHand.history.at(-1).outcome], ['reproduce', 'pending', 'person', 'analyzed']);
  assert.equal(board.pipeline.running, null, 'paused: nothing runs after it');
  assert.ok(board.pipeline.feed.some(item => item.family === 'person' && item.key === 'NEO-103' && item.title === 'Hecho por ti: Analizar' && item.detail === 'Analizado a mano.'));
  assert.equal((await post('/api/jira-done', { key: 'NEO-102' })).status, 409, 'a resolved ticket has no step left');
  assert.equal((await post('/api/jira-done', { key: 'NEO-103', note: 7 })).status, 400);
  assert.ok(board.pipeline.feed.some(item => item.family === 'step' && /^Verificar · Verificado$/.test(item.title) && item.detail), 'each step ends in one line, its report folded');
  assert.ok(!board.pipeline.feed.some(item => /Preparando archivos|sigue en curso/.test(item.title)), 'without the noise');
  assert.equal((await post('/api/jira-done', { key: 'NEO-999' })).status, 404);
  assert.ok(board.pipeline.feed.some(item => item.family === 'jira' && item.key === 'NEO-102' && /^2 comentarios en el pull request \d+$/.test(item.title)), 'publishing the review shows in the activity');
  assert.equal((await post('/api/jira-run', { key: '../../etc' })).status, 400);
  // Updating brings what the filters of Mantenimiento leave; the whole filter is read, not downloaded.
  const single = (await post('/api/jira-refresh', { filters: { text: 'neo-102' } })).data;
  assert.deepEqual([single.result.collect.filtered, single.result.collect.found, single.result.collect.left], [true, 1, 0]);
  assert.deepEqual(single.jira.catalog.map(e => [e.key, e.components]), [['NEO-101', ['Facturación']], ['NEO-102', ['Clientes']], ['NEO-103', ['Impresión']]], 'the filter, as it was read');
  assert.equal(single.jira.pipeline.feed.at(-1).meta, '1 filtrado');
  const outside = (await post('/api/jira-refresh', { filters: { text: 'NEO-999' } })).data.result.collect;
  assert.deepEqual([outside.found, outside.downloaded], [0, 0], 'a ticket outside the filter is not brought');
  const byField = (await post('/api/jira-refresh', { filters: { conditions: [{ field: 'jira.components', value: 'Impresión', kind: 'select' }] } })).data.result.collect;
  assert.deepEqual([byField.filtered, byField.found], [true, 1], 'any field filters what is brought');
  // Empezar takes the tickets the filters leave, and follows them while it works.
  board = (await post('/api/jira-auto', { on: true, keys: ['NEO-103'] })).data.jira;
  assert.deepEqual(board.pipeline.scope, ['NEO-103']);
  assert.ok(board.pipeline.feed.some(item => item.title === 'Empezar: los 1 filtrados, uno tras otro'));
  assert.deepEqual((await post('/api/jira-scope', { keys: ['NEO-102', 'NEO-103'] })).data.jira.pipeline.scope, ['NEO-102', 'NEO-103']);
  assert.equal((await post('/api/jira-scope', { keys: ['../x'] })).status, 400);
  assert.equal((await post('/api/jira-scope', { keys: 'NEO-1' })).status, 400);
  board = (await post('/api/jira-auto', { on: false })).data.jira;
  await idle();
  assert.equal((await post('/api/jira-auto', { on: true })).data.jira.pipeline.scope, null, 'with nothing filtered, all of them');
  await post('/api/jira-auto', { on: false });
  await idle();
  // Deleted by hand: it goes with its folder and updating does not bring it back, unless it is asked for.
  board = (await post('/api/jira-delete', { key: 'NEO-103' })).data.jira;
  assert.ok(!board.tickets.some(t => t.key === 'NEO-103') && board.pipeline.feed.some(item => item.key === 'NEO-103' && item.title === 'Borrado'));
  assert.equal(await readdir(join(directory, 'jira-ejemplo', 'NEO-103')).catch(() => null), null);
  const unbrought = await post('/api/jira-refresh');
  assert.deepEqual([unbrought.data.result.collect.downloaded, unbrought.data.jira.tickets.some(t => t.key === 'NEO-103')], [0, false]);
  assert.ok((await post('/api/jira-refresh', { filters: { text: 'NEO-103' } })).data.jira.tickets.some(t => t.key === 'NEO-103'), 'filtering that one ticket brings it back');
  assert.equal((await post('/api/jira-delete', { key: 'NEO-999' })).status, 404);
  // One comment from Mantenimiento goes at once to every item chosen (in the example,
  // Jira keeps it in memory and Azure DevOps is simulated); the activity tells it.
  const commented = await post('/api/maintenance-comment', { targets: [{ origin: 'jira', key: 'NEO-101' }, { origin: 'jira', key: 'NEO-102' }, { origin: 'azure', key: 2101 }], text: ' Revisado.\nSegunda línea. ' });
  assert.equal(commented.status, 200);
  assert.deepEqual([commented.data.posted, commented.data.failed], [['jira:NEO-101', 'jira:NEO-102', 'azure:2101'], []]);
  const told = commented.data.jira.pipeline.feed.at(-1);
  assert.deepEqual([told.family, told.title, told.meta, told.detail], ['person', 'Comentario publicado en Jira en 2 tickets', 'NEO-101, NEO-102', 'Revisado.\nSegunda línea.']);
  for (const [input, why] of [[{ targets: [{ origin: 'jira', key: 'NEO-101' }], text: '  ' }, 'an empty comment'], [{ targets: [], text: 'Hola' }, 'nothing chosen'], [{ targets: [{ origin: 'azure', key: '2101' }], text: 'Hola' }, 'an id that is not a number'], [{ targets: [{ origin: 'jira', key: '../x' }], text: 'Hola' }, 'a key that is not one'], [{ targets: [{ origin: 'jira', key: 'NEO-101' }], text: 'x'.repeat(4001) }, 'a comment too long']]) assert.equal((await post('/api/maintenance-comment', input)).status, 400, why);
});
