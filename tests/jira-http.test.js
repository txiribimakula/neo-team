import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
  for (const path of ['/jira', '/jira/NEO-101', '/jira/configuracion', '/revision-prs/abc123', '/planificacion/capacidad', '/mi-iteracion', '/mantenimiento', '/permisos']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200, path);
    assert.match(await response.text(), /<script type="module" src="\/app\.js">/);
  }
  for (const path of ['/jira/x.js', '/otra', '/server/index.js']) assert.equal((await fetch(url + path)).status, 404, path);
  assert.equal(state.jira, null, 'without settings there is no board');
  assert.equal((await post('/api/jira-collect')).status, 400);
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
  const collected = await post('/api/jira-collect');
  assert.equal(collected.status, 200);
  assert.deepEqual([collected.data.result.found, collected.data.result.downloaded], [3, 3]);
  const folder = join(directory, 'jira-ejemplo', 'NEO-101');
  assert.deepEqual((await readdir(join(folder, 'adjuntos'))), ['captura-exportar.png']);
  assert.match(await readFile(join(folder, 'comentarios.md'), 'utf8'), /!\[captura-exportar\.png\]\(adjuntos\/captura-exportar\.png\)/, 'comments point to the local attachment');
  assert.match(await readFile(join(folder, 'descripcion.md'), 'utf8'), /1\. Abrir \*\*Facturas\*\*/);
  assert.equal((await post('/api/jira-collect')).data.result.unchanged, 3, 'unchanged tickets are not downloaded again');
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
  assert.equal((await post('/api/jira-logs', { on: true })).status, 200);
  assert.equal(state.jira.logs, true);
  // Traffic lights: «off» does nothing, «ask» waits for approval, «auto» runs alone.
  assert.equal((await post('/api/jira-mode', { stage: 'fix', mode: 'off' })).status, 200);
  assert.equal(state.jira.modes.fix, 'off');
  assert.equal((await post('/api/jira-mode', { stage: 'fix', mode: 'rojo' })).status, 400);
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
  assert.deepEqual([board.tickets[2].stage, board.tickets[2].status, board.tickets[2].history.length], ['collect', 'pending', 0], 'the automatic mode did not touch it');
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
  assert.deepEqual(byKey['NEO-102'].history.slice(-2).map(h => `${h.stage}:${h.outcome}`), ['fix:fixed', 'verify:not_fixed'], 'it went on to verify');
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
  assert.deepEqual([byKey['NEO-102'].stage, byKey['NEO-102'].iterations], ['done', 2], 'a failed verification goes back to fix');
  assert.deepEqual([byKey['NEO-103'].stage, byKey['NEO-103'].status], ['done', 'done']);
  assert.deepEqual(byKey['NEO-102'].history.map(h => `${h.stage}:${h.outcome}`), ['collect:ok', 'reproduce:reproduced', 'fix:fixed', 'verify:not_fixed', 'fix:fixed', 'verify:verified']);
  const detail = (await get('/api/jira-ticket?key=NEO-102')).ticket;
  assert.ok(detail.history.every(h => h.stage === 'collect' ? h.posted === undefined : h.posted === true), 'with logs on every agent step is published (simulated in the example); collecting is not');
  assert.equal(detail.reports.length, 6);
  assert.match(detail.reports.at(-1).text, /ya no ocurre/);
  assert.ok(detail.files.includes('resumen.md') && detail.files.includes('verificacion-2.md'));
  const learnings = (await get('/api/jira-learnings')).learnings;
  assert.match(learnings.general, /NeoDesk se abre/);
  assert.equal(learnings.general.match(/NeoDesk se abre/g).length, 1, 'a lesson is saved once');
  assert.equal((await post('/api/jira-learnings', { scope: 'fix', text: '- Compilar en Release.\n' })).status, 200);
  assert.equal((await get('/api/jira-learnings')).learnings.fix, '- Compilar en Release.\n');
  assert.equal((await post('/api/jira-learnings', { scope: '../x', text: 'a' })).status, 400);

  assert.equal((await post('/api/jira-move', { key: 'NEO-103', stage: 'collect', resetIterations: true })).status, 200);
  // Synchronizing: NEO-101 was closed in Jira and NEO-102 has a new comment with a capture.
  const synced = await post('/api/jira-sync');
  assert.equal(synced.status, 200);
  assert.deepEqual([synced.data.result.closed, synced.data.result.updated], [['NEO-101'], [{ key: 'NEO-102', comments: 1, attachments: 1 }]]);
  const closed = synced.data.jira.tickets.find(t => t.key === 'NEO-101');
  assert.deepEqual([closed.archived, closed.closedInJira.status], [true, 'Cerrado'], 'it leaves the board, keeping its files');
  assert.ok((await readdir(join(directory, 'jira-ejemplo', 'NEO-102', 'adjuntos'))).includes('filtro-atras.png'));
  assert.match(await readFile(join(directory, 'jira-ejemplo', 'NEO-102', 'comentarios.md'), 'utf8'), /Pasa también al volver con \*\*Atrás\*\*: !\[filtro-atras\.png\]\(adjuntos\/filtro-atras\.png\)/);
  assert.equal(synced.data.jira.tickets.find(t => t.key === 'NEO-102').stage, 'done', 'the column is kept');
  assert.deepEqual((await post('/api/jira-sync')).data.result.updated, [], 'nothing new the second time');
  assert.equal((await post('/api/jira-archive', { key: 'NEO-101' })).status, 200);
  board = (await post('/api/jira-auto', { on: false })).data.jira;
  assert.ok(board.tickets.find(t => t.key === 'NEO-101').archived);
  assert.deepEqual([board.tickets.find(t => t.key === 'NEO-103').stage, board.tickets.find(t => t.key === 'NEO-103').reproduceAttempts], ['collect', 0]);
  assert.equal((await post('/api/jira-run', { key: '../../etc' })).status, 400);
});
