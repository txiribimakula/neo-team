import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createDemo } from '../server/demo.js';
import { createFromTicket, effectiveItems } from '../server/planner.js';
import { parentOptions, ticketItems } from '../dist/planning-jira.js';
import { kindOf } from '../dist/jira.js';

test('a ticket becomes a local task under its story, or a story and its task under a feature', () => {
  const ws = createDemo();
  const [task] = createFromTicket(ws, { title: '  Importar clientes desde CSV ', parent: 1001 });
  const created = ws.items.find(i => i.id === task);
  assert.deepEqual([created.type, created.title, created.parent, created.localOnly], ['Task', 'Importar clientes desde CSV', 1001, true]);
  const [story, child] = createFromTicket(ws, { title: 'Exportar albaranes a PDF', parent: 910, story: true });
  const items = effectiveItems(ws);
  assert.deepEqual([items.find(i => i.id === story).type, items.find(i => i.id === story).parent], ['User Story', 910]);
  assert.deepEqual([items.find(i => i.id === child).type, items.find(i => i.id === child).parent, items.find(i => i.id === child).title], ['Task', story, 'Exportar albaranes a PDF']);
  assert.ok(items.filter(i => [story, child].includes(i.id)).every(i => i.modified), 'both wait to be synchronized');
  // The parent must fit the level: a task goes under a story, a story under a feature.
  assert.throws(() => createFromTicket(ws, { title: 'X', parent: 910 }), /no corresponde/);
  assert.throws(() => createFromTicket(ws, { title: 'X', parent: 1001, story: true }), /no corresponde/);
  assert.throws(() => createFromTicket(ws, { title: ' ', parent: 1001 }), /título/);
  assert.throws(() => createFromTicket(ws, { title: 'X' }), /padre/);
});

test('the parents offered depend on creating a story, and the items of a ticket are found by title or key', () => {
  const ws = createDemo(); ws.effectiveItems = effectiveItems(ws);
  const stories = parentOptions(ws, false, 1001), features = parentOptions(ws, true, '');
  assert.match(stories, /<option value="1001" selected>/);
  assert.match(stories, /<optgroup label="Experiencia de producto">/, 'stories are grouped under their feature');
  assert.doesNotMatch(stories, /value="910"/);
  assert.match(features, /value="910"/);
  assert.doesNotMatch(features, /value="1001"/);
  createFromTicket(ws, { title: 'importar clientes desde csv', parent: 1001 });
  createFromTicket(ws, { title: 'NEO-213 · PDF', parent: 1001 });
  ws.effectiveItems = effectiveItems(ws);
  assert.equal(ticketItems(ws, { key: 'NEO-211', summary: 'Importar clientes desde CSV' }).length, 1, 'same title, ignoring case');
  assert.equal(ticketItems(ws, { key: 'NEO-213', summary: 'Exportar albaranes a PDF' }).length, 1, 'or its key in the title');
  assert.equal(ticketItems(ws, { key: 'NEO-21', summary: 'Otra cosa' }).length, 0, 'a shorter key is not the same ticket');
  assert.deepEqual(['Estimación', 'Valoración', 'Spike', 'Historia', 'Mejora', 'Desarrollo', 'Story'].map(kindOf), ['estimate', 'estimate', 'estimate', 'development', 'development', 'development', 'development']);
});

test('HTTP Planificación reads the Jira filter of the example and creates from a ticket', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-planning-jira-'));
  const port = 14381, url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, NEO_TEAM_PORT: String(port), NEO_TEAM_DATA_DIR: directory, NEO_TEAM_JIRA_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const get = async path => { const response = await fetch(url + path, { headers: { 'X-Neo-CSRF': state.csrf } }); return { status: response.status, data: await response.json() }; };

  for (const path of ['/planificacion/estimacion', '/planificacion/desarrollo', '/planning-jira.js']) assert.equal((await fetch(url + path)).status, 200, path);
  assert.equal((await fetch(url + '/api/planning-jira')).status, 403, 'it needs the session');
  assert.equal((await get('/api/planning-jira')).status, 400, 'without Jira there is nothing to read');

  await post('/api/mode', { mode: 'demo' });
  assert.equal(state.planningJiraFilter, '10002');
  const read = await get('/api/planning-jira');
  assert.equal(read.status, 200);
  const kinds = read.data.planningJira.entries.map(e => kindOf(e.type));
  assert.deepEqual([kinds.filter(k => k === 'estimate').length, kinds.filter(k => k === 'development').length], [3, 3]);
  assert.equal(read.data.planningJira.url, 'https://ejemplo.atlassian.net');

  assert.equal((await post('/api/planning-jira-filter', { filter: 'https://ejemplo.atlassian.net/issues/' })).status, 400, 'a URL without a filter is rejected');
  assert.equal((await post('/api/planning-jira-filter', { filter: ' project = NEO ' })).status, 200);
  assert.equal(state.planningJiraFilter, 'project = NEO');

  const before = state.workspace.items.length;
  const created = await post('/api/create-from-jira', { title: 'Importar clientes desde CSV', parent: 910, story: true });
  assert.equal(created.status, 200);
  const added = state.workspace.items.slice(before);
  assert.deepEqual(added.map(i => [i.type, i.title, i.localOnly]), [['User Story', 'Importar clientes desde CSV', true], ['Task', 'Importar clientes desde CSV', true]]);
  assert.equal(added[1].parent, added[0].id);
  const wrong = await post('/api/create-from-jira', { title: 'X', parent: 910 });
  assert.equal(wrong.status, 400);
  assert.equal(state.workspace.items.length, before + 2, 'a rejected creation leaves nothing');
});
