import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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

  assert.deepEqual(state.planningJiraFilters, {estimates:'project = NEO',development:'10002'}, 'saving estimates preserves the development query');
  assert.equal((await post('/api/planning-jira-filter', {section:'development',filter:'project = DEV'})).status,200);
  assert.equal(state.planningJiraFilters.estimates,'project = NEO');
  assert.equal(state.planningJiraFilters.development,'project = DEV');
  assert.equal((await get('/api/planning-jira?section=estimates')).data.planningJira.filter,'project = NEO');
  const development=await get('/api/planning-jira?section=development');
  assert.equal(development.data.planningJira.filter,'project = DEV');
  assert.equal(development.data.planningJira.section,'development');
  assert.equal((await get('/api/planning-jira?section=other')).status,400);
  assert.equal((await post('/api/planning-jira-filter',{section:'other',filter:'project = BAD'})).status,400);
  const persisted=JSON.parse(await readFile(join(directory,'workspace.json'),'utf8'));
  assert.deepEqual(persisted.planningJiraFilters.demo,{estimates:'project = NEO',development:'project = DEV'},'both queries survive a server restart');
  await post('/api/mode',{mode:'azure'});
  assert.deepEqual(state.planningJiraFilters,{estimates:'',development:''},'demo queries do not leak to real mode');
  await post('/api/mode',{mode:'demo'});
  assert.deepEqual(state.planningJiraFilters,persisted.planningJiraFilters.demo);

  const commentPath='/api/planning-jira-comment';
  const noSession=await fetch(url+commentPath,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'NEO-211',text:'Hola'})});
  assert.equal(noSession.status,403);
  for(const input of [
    {key:'../other',text:'Hola',section:'estimates'},
    {key:'NEO-211',text:' ',section:'estimates'},
    {key:'NEO-211',text:'x'.repeat(4001),section:'development'},
    {key:'NEO-211',text:'Hola',section:'other'},
  ])assert.equal((await post(commentPath,input)).status,400);
  const versionBeforeComment=state.version,itemsBeforeComment=JSON.stringify(state.workspace.items);
  const estimateComment=await post(commentPath,{key:'NEO-211',section:'estimates',text:'  Comentario de estimación\nSegunda línea  '});
  assert.equal(estimateComment.status,200);
  assert.deepEqual(estimateComment.data.posted,{key:'NEO-211',section:'estimates',id:'1',simulated:true});
  const developmentComment=await post(commentPath,{key:'NEO-212',section:'development',text:'Comentario de desarrollo'});
  assert.equal(developmentComment.status,200);
  assert.equal(developmentComment.data.posted.id,'2','invalid requests did not publish');
  assert.equal(state.version,versionBeforeComment);
  assert.equal(JSON.stringify(state.workspace.items),itemsBeforeComment,'Jira comments do not change Azure tasks');

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

test('legacy queries supply both sections until independently saved, including explicit empty queries',async()=>{
  const {planningFilters,savePlanningFilter}=await import('../server/planning-jira-settings.js');
  const data={mode:'azure',planningJiraFilters:{azure:'project = OLD'}};
  assert.deepEqual(planningFilters(data),{estimates:'project = OLD',development:'project = OLD'});
  savePlanningFilter(data,'development','project = DEV');
  assert.deepEqual(planningFilters(data),{estimates:'project = OLD',development:'project = DEV'});
  savePlanningFilter(data,'estimates','');
  assert.deepEqual(planningFilters(data),{estimates:'',development:'project = DEV'});
});

test('each query is rendered in its own section with an explicit refresh button',async()=>{
  const {planningJiraView}=await import('../dist/planning-jira.js');
  const state={jira:{},planningJiraFilters:{estimates:'project = EST',development:'project = DEV'}};
  const estimates=planningJiraView('estimates',state,{}),development=planningJiraView('development',state,{});
  assert.match(estimates,/value="project = EST"/);assert.doesNotMatch(estimates,/project = DEV/);
  assert.match(development,/value="project = DEV"/);assert.doesNotMatch(development,/project = EST/);
  assert.match(estimates,/Actualizar Estimación desde Jira/);assert.match(development,/Actualizar Desarrollo desde Jira/);
});

test('switching sections keeps separate cached results and late replies cannot overwrite another section',async()=>{
  const {runInNewContext}=await import('node:vm');
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const cache=app.slice(app.indexOf('let pjUi;'),app.indexOf('let state,'));
  const loader=app.slice(app.indexOf('function ensurePlanningJira()'),app.indexOf('async function loadJira()'));
  const context={state:{mode:'azure',csrf:'x',jira:{url:'https://jira.example'},planningJiraFilters:{estimates:'EST',development:'DEV'}},tab:'estimates',render:()=>{},loadState:async()=>{},encodeURIComponent};
  const pending=new Map();context.fetch=url=>new Promise(resolve=>pending.set(url,resolve));
  const api=runInNewContext(cache+loader+'; ({ui:planningJiraUi,load:loadPlanningJira})',context);
  const estimates=api.ui('estimates'),development=api.ui('development');
  assert.notEqual(estimates,development);
  const first=api.load('estimates');context.tab='development';const second=api.load('development');
  pending.get('/api/planning-jira?section=development')({ok:true,json:async()=>({planningJira:{filter:'DEV',entries:[{key:'DEV-1'}]}})});await second;
  pending.get('/api/planning-jira?section=estimates')({ok:true,json:async()=>({planningJira:{filter:'EST',entries:[{key:'EST-1'}]}})});await first;
  assert.equal(api.ui('development').data.entries[0].key,'DEV-1');
  assert.equal(api.ui('estimates').data.entries[0].key,'EST-1');
  context.state.planningJiraFilters.estimates='NEW';
  assert.equal(api.ui('estimates').data,null);
  assert.equal(api.ui('development'),development,'changing estimates preserves development results');
});

test('estimation and development rows each offer an independent Jira comment editor',async()=>{
  const {planningJiraView}=await import('../dist/planning-jira.js');
  const entries=[{key:'NEO-211',type:'Estimación',summary:'Estimar'},{key:'NEO-212',type:'Desarrollo',summary:'Desarrollar'}];
  const state={mode:'azure',jira:{},planningJiraFilters:{estimates:'EST',development:'DEV'}};
  for(const [section,key] of [['estimates','NEO-211'],['development','NEO-212']]){
    const ui={data:{url:'https://jira.example',entries},commentOpen:key,comments:{[key]:{text:'<script>Prueba</script>',error:'Sin permisos'}}};
    const html=planningJiraView(section,state,ui);
    assert.match(html,new RegExp(`aria-label="Comentar ${key}"`));
    assert.match(html,new RegExp(`data-pj-comment="${key}"`));
    assert.match(html,/Publicar en Jira/);assert.match(html,/directamente en Jira/);
    assert.match(html,/&lt;script&gt;Prueba&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
    assert.match(html,/role="alert">Sin permisos/);
    assert.match(html,/pj-comment-close/);
  }
});

test('Jira comment sending retains failed drafts, prevents duplicate clicks and clears only on success',async()=>{
  const {runInNewContext}=await import('node:vm');
  const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('async function submitPlanningJiraComment('),app.indexOf('function ensurePlanningJira()'));
  const ui={},calls=[];
  const context={tab:'estimates',planningJiraUi:()=>ui,render:()=>{},request:async(path,input)=>{calls.push([path,input]);throw new Error('Jira: sin permisos');}};
  const submit=runInNewContext(source+'; submitPlanningJiraComment',context);
  const form={dataset:{key:'NEO-211'},elements:{text:{value:'Comentario que conservar'}}};
  await submit(form);
  assert.equal(ui.comments['NEO-211'].text,'Comentario que conservar');
  assert.equal(ui.comments['NEO-211'].error,'Jira: sin permisos');
  assert.equal(ui.comments['NEO-211'].posting,false);
  assert.equal(calls[0][0],'/api/planning-jira-comment');assert.equal(calls[0][1].section,'estimates');
  let finish;context.request=()=>new Promise(resolve=>{finish=resolve;});
  const first=submit(form);await submit(form);
  assert.equal(ui.comments['NEO-211'].posting,true);
  finish({posted:{key:'NEO-211',simulated:true}});await first;
  assert.equal(ui.comments['NEO-211'].text,'');
  assert.match(ui.comments['NEO-211'].notice,/NEO-211 \(simulado\)/);
});
