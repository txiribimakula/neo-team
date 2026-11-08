import test from 'node:test';
import assert from 'node:assert/strict';
import { readIterationTree } from '../server/iteration-tree.js';
import { globalTemplate, saveGlobalTemplate } from '../server/iteration-settings.js';
import { renamePlan, globalNumbers, sprintName, datesProblem } from '../dist/sprint-name.js';
import { iterationRenames, renameLocally, sharedIterations } from '../server/iterations.js';
import { sourcesOf } from '../server/multi-project.js';
import { refreshSection } from '../server/refresh.js';
const iteration=(id,name,start='2026-10-26',end='2026-11-06')=>({id,name,path:`Project\\${name}`,attributes:{startDate:`${start}T00:00:00Z`,finishDate:`${end}T00:00:00Z`}});

test('global settings preserve the explicit criterion, migrate legacy settings deterministically and isolate demo',()=>{
  const sources=[{id:'a'},{id:'b'}],data={mode:'azure',iterationTemplates:{a:'Semana {semana}',b:'Sprint {n}',demo:'Ejemplo {n}'}};
  assert.equal(globalTemplate(data,sources),'Semana {semana}');
  saveGlobalTemplate(data,{a:'S{semana}-{semana+1}',b:'S{semana}-{semana+1}'});
  assert.equal(globalTemplate(data,[...sources].reverse()),'S{semana}-{semana+1}');
  assert.equal(data.iterationTemplates.b,'Sprint {n}','legacy values retained as migration backup');
  data.mode='demo';assert.equal(globalTemplate(data,sources),'Ejemplo {n}');
});

test('full tree reads more than 500 historical nodes and descends without a fixed depth',async()=>{
  const children=Array.from({length:620},(_,n)=>({identifier:`old-${n}`,name:`Old ${n}`,attributes:{startDate:'2000-01-01T00:00:00Z',finishDate:'2000-01-02T00:00:00Z'}}));
  children.push({identifier:'folder',name:'Archive',hasChildren:true});
  const calls=[],all=await readIterationTree('Project',async path=>{
    calls.push(path);
    if(!path.length)return {hasChildren:true,children};
    if(path.length<15)return {identifier:path.join('/'),name:path.at(-1),hasChildren:true,children:[{identifier:`level-${path.length}`,name:'Nested',hasChildren:true}]};
    return {identifier:'deepest',name:'Nested',children:[]};
  });
  assert.equal(all.length,635);assert.equal(all.at(-1).id,'deepest');
  assert.equal(calls.at(-1).length,15);
  assert.equal(all[0].path,'Project\\Old 0');
  await assert.rejects(()=>readIterationTree('Project',async()=>({hasChildren:true})),/todas las iteraciones/);
});

test('week mismatch proposes only a name and preserves original dates, including ISO year boundaries',()=>{
  const old=iteration('old','Semana 43-44'),boundary=iteration('new','Wrong','2026-12-28','2027-01-08');
  const before=structuredClone([old,boundary]),plan=renamePlan([old,boundary],'Semana {semana}-{semana+1}','2026-11-08');
  assert.equal(plan.rows[0].to,'Semana 44-45');
  assert.match(plan.rows[0].explanation,/semana ISO 44/);
  assert.equal(plan.rows[1].to,'Semana 53-01');
  assert.deepEqual(plan.rows.map(r=>[r.startDate,r.finishDate]),[['2026-10-26','2026-11-06'],['2026-12-28','2027-01-08']]);
  assert.deepEqual([old,boundary],before);
});

test('undated nodes remain visible without preventing valid renames; impossible dates are flagged',()=>{
  const plan=renamePlan([iteration('dated','Wrong'),{id:'undated',name:'Folder',path:'Project\\Folder'}],'S{semana}');
  assert.equal(plan.rows.length,2);assert.equal(plan.renames.length,1);assert.equal(plan.problem,'');
  assert.match(plan.rows[1].explanation,/Faltan fechas/);
  assert.match(datesProblem('2026-02-30','2026-03-01'),/fecha de inicio/);
  assert.match(renamePlan([iteration('bad','Bad','2026-11-06','2026-10-26')],'S{semana}').problem,/anterior/);
});

test('all historical iterations are reviewed and local renames preserve exact attributes',async()=>{
  const old=iteration('old','Wrong','2001-01-01','2001-01-12'),current=iteration('current','Wrong now');
  const ws={mode:'azure',config:{organization:'org',project:'Project',team:'Team'},iterations:[current],projectIterations:[old,current],items:[],settings:{}};
  const before=structuredClone(ws),plan=iterationRenames(ws,{template:'S{semana} {año}'});
  assert.equal(plan.sources[0].renames.length,2);
  const local=renameLocally(structuredClone(ws),plan.sources.flatMap(({source,renames})=>renames.map(rename=>({source,rename}))));
  assert.deepEqual(local.projectIterations.map(i=>i.attributes),before.projectIterations.map(i=>i.attributes));
  assert.equal(local.projectIterations[0].name,'S01 2001');
  assert.throws(()=>iterationRenames({...ws,projectIterations:undefined},{template:'S{semana}'}),/histórico completo/);
  const refreshed=await refreshSection(ws,'iterations',{import:async()=>({...ws,projectIterations:[...ws.projectIterations,iteration('extra','Extra','1999-01-01','1999-01-12')]})},[]);
  assert.equal(sourcesOf(refreshed)[0].projectIterations.length,3);
});

test('same date ranges share a number across projects and duplicate memberships',()=>{
  const a={iterations:[iteration('a','Sprint 7')]},b={iterations:[iteration('b','Sprint 40'),iteration('c','Sprint 41','2026-11-09','2026-11-20')]};
  const numbering=globalNumbers([a,b,a]);
  assert.equal(numbering.numbers.size,2);
  assert.equal(numbering.forIterations(b.iterations).get('b'),7);
  assert.equal(numbering.forIterations(b.iterations).get('c'),8);
  assert.equal(sprintName('Sprint {n}',{startDate:'2026-10-26',number:numbering.forIterations(a.iterations).get('a')}),'Sprint 7');
});

test('shared-team check batches all historical renames beyond the MCP limit',async()=>{
  const renames=Array.from({length:1203},(_,n)=>({id:String(n)})),calls=[];
  const shared=await sharedIterations({sources:[{source:{id:'s',config:{project:'Project'}},renames}]},{open:async()=>{},iterationTeams:async(config,ids)=>{calls.push(ids.length);return Object.fromEntries(ids.map(id=>[id,['Team B']]));}});
  assert.deepEqual(calls,[500,500,203]);assert.equal(Object.keys(shared.s).length,1203);
});

test('gateway creation and rename send separate tools; rename never sends dates',async()=>{
  const {AzureGateway}=await import('../server/azure.js'),gateway=new AzureGateway(),calls=[];
  gateway.call=async(...args)=>{calls.push(args);return {id:'id'};};
  const config={project:'Project',team:'Team'};
  await gateway.createIteration(config,{parentPath:'',name:'S44',startDate:'2026-10-26',finishDate:'2026-11-06'});
  await gateway.renameIteration(config,{id:'id',path:'Old',parentPath:'',name:'S44'});
  assert.equal(calls[0][0],'neo_iteration_create_write');
  assert.equal(calls[1][0],'neo_iteration_rename_write');
  assert.equal(calls[0].length,2);
  assert.deepEqual(calls[1][1],{project:'Project',id:'id',path:'Old',parentPath:'',name:'S44'});
});

test('review UI has one global input, every project in details, visible original dates and proposed calendar names',async()=>{
  const {readFile}=await import('node:fs/promises'),{runInNewContext}=await import('node:vm');
  const helpers=await import('../dist/sprint-name.js'),app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
  const first=iteration('a','Wrong'),second={...iteration('b','Other'),path:'Other\\Other'};
  const state={mode:'azure',iterationTemplate:'Semana {semana}-{semana+1}',workspace:{sources:[
    {id:'a',config:{project:'Project'},iterations:[first],projectIterations:[first]},
    {id:'b',config:{project:'Other'},iterations:[second],projectIterations:[second]},
  ]}};
  let section=app.slice(app.indexOf('const namingSources='),app.indexOf('function namingInput('));
  section=section.replace(/document.addEventListener\([^\n]+\n/,'');
  const result=runInNewContext(section+'; ({html:namingSection(),name:proposedName(state.workspace.sources[0].iterations[0])})',{
    ...helpers,inferIterationDates:(await import('../dist/iteration-dates.js')).inferIterationDates,state,localDay:()=> '2026-11-08',escape:s=>String(s??''),pendingCount:()=>0,
  });
  assert.equal((result.html.match(/data-naming="global"/g)??[]).length,1);
  assert.equal((result.html.match(/<details /g)??[]).length,2);
  assert.match(result.html,/Fechas existentes: 2026-10-26 — 2026-11-06/);
  assert.match(result.html,/Actual: Wrong/);
  assert.match(result.html,/Propuesta: Semana 44-45/);
  assert.equal(result.name,'Semana 44-45');
});

test('legacy global migration is persisted once and stays stable when projects are reordered',async()=>{
  const {migrateIterationTemplates}=await import('../server/iteration-settings.js');
  const ws={sources:[{id:'a'},{id:'b'}]},data={mode:'azure',azure:ws,iterationTemplates:{a:'Semana {semana}',b:'Sprint {n}'}};
  assert.equal(migrateIterationTemplates(data),true);
  ws.sources.reverse();
  assert.equal(migrateIterationTemplates(data),false);
  assert.equal(globalTemplate(data,ws.sources),'Semana {semana}');
});
