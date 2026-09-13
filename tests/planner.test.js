import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../server/demo.js';
import { LocalStore } from '../server/store.js';
import { Planner, stageChanges, planReview, resolveConflict, workingCapacity, identityKey } from '../server/planner.js';

async function fixture(t, mode = 'azure') {
  const dir = await mkdtemp(join(tmpdir(),'neo-planner-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store = new LocalStore(dir); await store.load();
  const workspace = createDemo(); workspace.mode = mode;
  await store.save({...store.data,mode,[mode]:workspace});
  const remote = new Map(workspace.items.map(i=>[i.id,structuredClone(i)]));
  const calls = [];
  const azure = {
    open: async()=>{}, getItems:async(_c,ids)=>ids.map(id=>structuredClone(remote.get(id))),
    update:async(_c,id,rev,changes)=>{
      calls.push({id,rev,changes});
      assert.equal(remote.get(id).rev,rev,'revision test');
      const updated={...remote.get(id),...changes,rev:rev+1};remote.set(id,updated);return structuredClone(updated);
    },
  };
  const planner = new Planner(store,azure);
  const stage = async(id,changes)=>{const data=structuredClone(store.data);stageChanges(data[mode],id,changes);await store.save(data);};
  return {store,workspace:()=>store.data[mode],planner,azure,remote,calls,stage};
}
test('identity comparison works with raw refs and official batch display strings',()=>{
  assert.equal(identityKey({uniqueName:'ANA@example.test'}),'ana@example.test');
  assert.equal(identityKey('Ana García <ANA@example.test>'),'ana@example.test');
});
test('staging normalizes reversions and rejects foreign assignments and fields',()=>{
  const ws=createDemo();stageChanges(ws,1042,{remainingWork:0});assert.equal(ws.drafts[1042].remainingWork,0);
  stageChanges(ws,1042,{remainingWork:12});assert.equal(ws.drafts[1042],undefined);
  for (const patch of [{assignedTo:'intruder@example.test'},{iterationPath:'Other\\Sprint'},{remainingWork:-1},{remainingWork:Infinity},{priority:5},{state:'Active'},{state:null}]) assert.throws(()=>stageChanges(ws,1042,patch));
  assert.throws(()=>stageChanges(ws,9999,{priority:1}));
  assert.throws(()=>stageChanges(ws,1047,{remainingWork:1}));
});
test('capacity honors working days, overlapping holidays and zero capacity',()=>{
  const iteration={attributes:{startDate:'2026-09-07',finishDate:'2026-09-18'}};
  const capacity={daysOff:[{start:'2026-09-07',end:'2026-09-08'}],teamMembers:[{teamMember:{id:'a'},activities:[{capacityPerDay:4},{capacityPerDay:2}],daysOff:[{start:'2026-09-08',end:'2026-09-09'}]}]};
  assert.equal(workingCapacity(iteration,capacity,'a',['monday','tuesday','wednesday','thursday','friday']),42);
  assert.equal(workingCapacity(iteration,capacity,'missing'),null);
  capacity.teamMembers[0].activities=[];assert.equal(workingCapacity(iteration,capacity,'a'),0);
});
test('unrelated remote changes are merged; synchronization sends only edited fields',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});
  f.remote.set(1042,{...f.remote.get(1042),title:'New remote title',priority:1,rev:7});
  const review=await f.planner.prepareReview();assert.ok(review.token);
  const result=await f.planner.sync(review.token);
  assert.deepEqual(result.successes,[1042]);assert.deepEqual(f.calls[0],{id:1042,rev:7,changes:{remainingWork:18}});
  assert.equal(f.workspace().items.find(i=>i.id===1042).title,'New remote title');
  assert.equal(f.workspace().drafts[1042],undefined);
  const persisted=JSON.parse(await readFile(f.store.file,'utf8'));assert.equal(persisted.azure.items.find(i=>i.id===1042).remainingWork,18);
});
test('conflicts block writes and an explicit local resolution rebases the draft',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});
  f.remote.set(1042,{...f.remote.get(1042),remainingWork:6,rev:2});
  const review=await f.planner.prepareReview();assert.equal(review.token,null);assert.deepEqual(review.plans[0].conflicts,['remainingWork']);
  await assert.rejects(()=>f.planner.sync(null));assert.equal(f.calls.length,0);
  const data=structuredClone(f.store.data);resolveConflict(data.azure,1042,'local');await f.store.save(data);
  assert.equal(f.workspace().items.find(i=>i.id===1042).remainingWork,6);assert.equal(f.workspace().drafts[1042].remainingWork,18);
  const next=await f.planner.prepareReview();assert.ok(next.token);await f.planner.sync(next.token);assert.equal(f.remote.get(1042).remainingWork,18);
});
test('choosing the remote version clears only that task draft',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});await f.stage(1045,{priority:1});
  f.remote.set(1042,{...f.remote.get(1042),remainingWork:6,rev:2});await f.planner.prepareReview();
  const data=structuredClone(f.store.data);resolveConflict(data.azure,1042,'remote');await f.store.save(data);
  assert.equal(f.workspace().drafts[1042],undefined);assert.deepEqual(f.workspace().drafts[1045],{priority:1});
});
test('already-applied remote values reconcile without replaying a write',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});
  f.remote.set(1042,{...f.remote.get(1042),remainingWork:18,rev:2});
  const review=await f.planner.prepareReview();await f.planner.sync(review.token);
  assert.equal(f.calls.length,0);assert.equal(f.workspace().drafts[1042],undefined);
});
test('a local edit invalidates a review token',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});const review=await f.planner.prepareReview();
  await f.stage(1042,{remainingWork:20});await assert.rejects(()=>f.planner.sync(review.token),/caducado/);assert.equal(f.calls.length,0);
});
test('a remote revision change after review prevents the whole batch before writes',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});await f.stage(1045,{priority:1});const review=await f.planner.prepareReview();
  f.remote.set(1045,{...f.remote.get(1045),rev:9});await assert.rejects(()=>f.planner.sync(review.token),/ha cambiado/);assert.equal(f.calls.length,0);
});
test('per-item revision test handles a race after preflight without overwriting',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});const review=await f.planner.prepareReview();
  const update=f.azure.update;f.azure.update=async(...args)=>{f.remote.set(1042,{...f.remote.get(1042),remainingWork:99,rev:5});return update(...args);};
  const result=await f.planner.sync(review.token);assert.equal(result.failures.length,1);assert.equal(f.remote.get(1042).remainingWork,99);assert.equal(f.workspace().drafts[1042].remainingWork,18);
});
test('partial sync persists successes and retries only pending tasks',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});await f.stage(1045,{priority:1});
  const update=f.azure.update;f.azure.update=async(...args)=>{if(args[1]===1045)throw new Error('Permission denied');return update(...args);};
  const review=await f.planner.prepareReview();const result=await f.planner.sync(review.token);
  assert.deepEqual(result.successes,[1042]);assert.equal(result.failures[0].id,1045);assert.deepEqual(Object.keys(f.workspace().drafts),['1045']);
  f.azure.update=update;const retry=await f.planner.prepareReview();await f.planner.sync(retry.token);assert.deepEqual(f.calls.map(c=>c.id),[1042,1045]);
});
test('an acknowledgement lost to disk failure is reconciled on next review',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});const review=await f.planner.prepareReview();
  const save=f.store.save.bind(f.store);f.store.save=async()=>{throw new Error('Disk full');};
  await assert.rejects(()=>f.planner.sync(review.token),/Disk full/);assert.equal(f.remote.get(1042).remainingWork,18);assert.ok(f.workspace().drafts[1042]);
  f.store.save=save;const retry=await f.planner.prepareReview();await f.planner.sync(retry.token);assert.equal(f.calls.length,1);assert.deepEqual(f.workspace().drafts,{});
});
test('demo simulation never contacts Azure DevOps',async t=>{
  const f=await fixture(t,'demo');for(const name of ['open','getItems','update'])f.azure[name]=async()=>{throw new Error('Must not contact Azure');};
  await f.stage(1042,{remainingWork:18});const review=await f.planner.prepareReview();const result=await f.planner.sync(review.token);assert.equal(result.demo,true);assert.deepEqual(result.successes,[1042]);
});
test('missing remote items fail closed',()=>{
  const ws=createDemo();stageChanges(ws,1042,{remainingWork:18});assert.throws(()=>planReview(ws,[]),/No se pudo leer/);
});

test('undoing a planned batch restores its previous drafts while retaining unrelated edits and sharing',async t=>{
  const f=await fixture(t,'demo');await f.stage(1053,{priority:1,iterationPath:f.workspace().iterations[1].path});await f.stage(1042,{remainingWork:26});
  const previous=structuredClone(f.workspace());
  const undo=await f.planner.planBatch('ana@example.test',[1053],'sprint-24');
  assert.equal(f.workspace().drafts[1053].assignedTo,'ana@example.test');assert.equal(f.workspace().drafts[1053].priority,1);
  await f.planner.undoPlan(undo.token);
  assert.deepEqual(f.workspace().drafts,previous.drafts);assert.deepEqual(f.workspace().participants,previous.participants);assert.deepEqual(f.workspace().conflicts,previous.conflicts);
  assert.equal(f.calls.length,0);
  await assert.rejects(()=>f.planner.undoPlan(undo.token),/ha cambiado/);
});

test('undo token expires after a subsequent local modification and never overwrites it',async t=>{
  const f=await fixture(t,'demo');const undo=await f.planner.planBatch('ana@example.test',[1053],'sprint-24');
  await f.stage(1053,{remainingWork:28});
  await assert.rejects(()=>f.planner.undoPlan(undo.token),/ha cambiado/);
  assert.equal(f.workspace().drafts[1053].remainingWork,28);assert.equal(f.workspace().drafts[1053].assignedTo,'ana@example.test');
});

// Creation tests exercise parent remapping and ambiguous network acknowledgements.
test('new hierarchy stays local, sync creates parents first, remaps links and clears pending drafts',async t=>{
  const {createLocalItem,effectiveItems}=await import('../server/planner.js');
  const f=await fixture(t,'demo'),data=structuredClone(f.store.data),ws=data.demo;
  const epic=createLocalItem(ws,{type:'Epic',title:'New epic'});
  const feature=createLocalItem(ws,{type:'Feature',title:'New feature',parent:epic});
  const story=createLocalItem(ws,{type:'User Story',title:'New story',parent:feature});
  const task=createLocalItem(ws,{type:'Task',title:'New task',parent:story,remainingWork:5,assignedTo:'ana@example.test'});
  assert.equal(effectiveItems(ws).find(i=>i.id===task).modified,true);
  await f.store.save(data);const review=await f.planner.prepareReview();assert.equal(review.plans.length,4);
  const result=await f.planner.sync(review.token);assert.deepEqual(result.failures,[]);assert.equal(result.successes.length,4);
  const saved=f.workspace();assert.deepEqual(saved.drafts,{});
  const created=saved.items.filter(i=>i.title.startsWith('New '));assert.ok(created.every(i=>i.id>0 && !i.localOnly));
  assert.equal(created.find(i=>i.title==='New task').parent,created.find(i=>i.title==='New story').id);
});
test('ambiguous creation is recovered without duplicate writes and cannot be discarded or edited meanwhile',async t=>{
  const {createLocalItem,discardLocal}=await import('../server/planner.js');
  const f=await fixture(t);const data=structuredClone(f.store.data);
  const id=createLocalItem(data.azure,{type:'Task',title:'Recover me',parent:1001,remainingWork:3});await f.store.save(data);
  let remoteCreated,creates=0,visible=false;
  f.azure.findCreation=async()=>visible ? remoteCreated : null;
  f.azure.create=async(_config,item,validate)=>{if(validate)return {};creates++;remoteCreated={...item,id:8000,rev:1};throw new Error('Connection lost');};
  let review=await f.planner.prepareReview();let result=await f.planner.sync(review.token);assert.equal(result.failures.length,1);assert.equal(creates,1);
  assert.ok(f.workspace().drafts[id]);assert.throws(()=>discardLocal(f.workspace(),id),/sin confirmar/);
  assert.throws(()=>stageChanges(f.workspace(),id,{title:'Changed'}),/Recupera/);
  review=await f.planner.prepareReview();result=await f.planner.sync(review.token);assert.equal(result.failures.length,1);assert.equal(creates,1);
  visible=true;review=await f.planner.prepareReview();result=await f.planner.sync(review.token);
  assert.deepEqual(result.failures,[]);assert.equal(creates,1);assert.ok(f.workspace().items.some(i=>i.id===8000));assert.equal(f.workspace().drafts[id],undefined);
});
test('parent revision changes stop creation before any remote write',async t=>{
  const {createLocalItem}=await import('../server/planner.js');const f=await fixture(t),data=structuredClone(f.store.data);
  createLocalItem(data.azure,{type:'Task',title:'Child',parent:1001});await f.store.save(data);
  const review=await f.planner.prepareReview();f.remote.get(1001).rev++;
  f.azure.create=async()=>assert.fail('must not create');
  await assert.rejects(()=>f.planner.sync(review.token),/ha cambiado/);assert.equal(Object.keys(f.workspace().drafts).length,1);
});
test('invalid hierarchy and creation fields are rejected; local creation can be discarded before sending',async t=>{
  const {createLocalItem,discardLocal}=await import('../server/planner.js');const f=await fixture(t,'demo');
  assert.throws(()=>createLocalItem(f.workspace(),{type:'Task',title:'No parent'}),/padre/);
  assert.throws(()=>createLocalItem(f.workspace(),{type:'Feature',title:'Wrong parent',parent:1001}),/nivel/);
  const id=createLocalItem(f.workspace(),{type:'Bug',title:'New bug',parent:1001});discardLocal(f.workspace(),id);
  assert.ok(!f.workspace().items.some(i=>i.id===id));assert.equal(f.workspace().drafts[id],undefined);
});

test('reviewing the previous iteration carries tasks over or closes them with the completed state of their type',async t=>{
  const {eligibleTasks}=await import('../dist/hierarchy.js');const {planningWorkspace}=await import('../server/planner.js');
  const f=await fixture(t),next=f.workspace().iterations[0].path,previous=f.workspace().iterations.find(i=>i.past);
  assert.equal(f.workspace().items.find(i=>i.id===1030).iterationPath,previous.path);
  await f.stage(1030,{iterationPath:next});await f.stage(1031,{state:'Closed'});
  assert.throws(()=>stageChanges(structuredClone(f.workspace()),1001,{state:'Closed'}),/completadas/,'only tasks and bugs can be closed');
  const unknown=structuredClone(f.workspace());delete unknown.completedStates;
  assert.throws(()=>stageChanges(unknown,1032,{state:'Closed'}),/completadas/,'a type without a known completed state cannot be closed');
  const review=await f.planner.prepareReview();const result=await f.planner.sync(review.token);
  assert.deepEqual(result.failures,[]);
  assert.deepEqual(f.calls.map(c=>[c.id,c.changes]),[[1030,{iterationPath:next}],[1031,{state:'Closed'}]]);
  assert.equal(f.workspace().items.find(i=>i.id===1031).state,'Closed');
  assert.ok(!eligibleTasks(planningWorkspace(f.workspace()),'marcos@example.test').some(i=>i.id===1031),'a closed task is no longer offered for planning');
  assert.ok(eligibleTasks(planningWorkspace(f.workspace()),'ana@example.test').some(i=>i.id===1030),'a carried-over task stays with its owner');
  await f.stage(1032,{state:'Closed'});await f.stage(1032,{state:'New'});
  assert.equal(f.workspace().drafts[1032],undefined,'undoing restores the imported state');
});

test('completing a task in a workspace imported without completed states looks the state up once in Azure',async t=>{
  const f=await fixture(t),data=structuredClone(f.store.data);delete data.azure.completedStates;await f.store.save(data);
  const lookups=[];f.azure.completedState=async(_config,type)=>{lookups.push(type);return 'Done';};
  await f.planner.completeTask(1031);await f.planner.completeTask(1033);
  assert.deepEqual(lookups,['Task'],'the state is kept for the next tasks of the same type');
  assert.equal(f.workspace().drafts[1031].state,'Done');assert.deepEqual(f.workspace().completedStates,{Task:'Done'});
  f.azure.completedState=async()=>null;
  await assert.rejects(()=>f.planner.completeTask(1032),/Completed/);assert.equal(f.workspace().drafts[1032],undefined);
  await assert.rejects(()=>f.planner.completeTask(1001),/tareas y bugs/);
});
