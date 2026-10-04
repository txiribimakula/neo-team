import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createDemo} from '../server/demo.js';
import {LocalStore} from '../server/store.js';
import {Planner,completeTask,stageChanges,createLocalItem,discardLocal,discardStateChanges,resolveConflict} from '../server/planner.js';
import {refreshSection} from '../server/refresh.js';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'neo-closing-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=new LocalStore(directory);await store.load();
  const workspace=createDemo();workspace.mode='azure';
  stageChanges(workspace,1042,{state:'Ready for Test'});
  stageChanges(workspace,1042,{state:'Closed'});
  await store.save({...store.data,mode:'azure',azure:workspace});
  const remote=new Map(workspace.items.map(i=>[i.id,structuredClone(i)])),calls=[];
  const azure={open:async()=>{},getItems:async(_config,ids)=>ids.map(id=>structuredClone(remote.get(id))),update:async(config,id,rev,fields)=>{
    calls.push({config,id,rev,fields});
    assert.equal(rev,remote.get(id).rev);
    const updated={...remote.get(id),...fields,rev:rev+1};remote.set(id,updated);return structuredClone(updated);
  }};
  const planner=new Planner(store,azure);
  return {directory,store,azure,planner,remote,calls};
}

test('local state changes retain every transition, including repeated states and returns to the original',()=>{
  const ws=createDemo();
  for (const state of ['Active','Active','Ready for Test','Active','New']) stageChanges(ws,1042,{state});
  assert.deepEqual(ws.stateChanges[1042],['Active','Ready for Test','Active','New']);
  assert.equal(ws.drafts[1042].state,'New');
  stageChanges(ws,1042,{remainingWork:7});
  discardStateChanges(ws,1042);
  assert.deepEqual(ws.drafts[1042],{remainingWork:7});
  assert.equal(ws.stateChanges[1042],undefined);
  stageChanges(ws,1042,{state:'Active'});discardLocal(ws,1042);
  assert.equal(ws.stateChanges[1042],undefined);assert.equal(ws.drafts[1042],undefined);
  assert.throws(()=>stageChanges(ws,1042,{state:'Unknown'}));
  assert.throws(()=>stageChanges(ws,1001,{state:'Closed'}));
});

test('state history applies ordered states with the latest revision and other edits only once',async t=>{
  const f=await fixture(t),data=structuredClone(f.store.data);
  stageChanges(data.azure,1042,{remainingWork:0});await f.store.save(data);
  const review=await f.planner.prepareReview();
  assert.deepEqual(review.plans[0].stateSteps,['Ready for Test','Closed']);
  const result=await f.planner.sync(review.token);
  assert.deepEqual(result.failures,[]);assert.deepEqual(result.successes,[1042]);
  assert.deepEqual(f.calls.map(c=>[c.rev,c.fields]),[[1,{state:'Ready for Test',remainingWork:0}],[2,{state:'Closed'}]]);
  assert.equal(f.store.data.azure.items.find(i=>i.id===1042).state,'Closed');
  assert.equal(f.store.data.azure.drafts[1042],undefined);
});

test('failure at the final step persists the intermediate state and resumes after restarting',async t=>{
  const f=await fixture(t),update=f.azure.update;
  f.azure.update=async(...args)=>{if(args[3].state==='Closed')throw new Error('Campo obligatorio');return update(...args);};
  const result=await f.planner.sync((await f.planner.prepareReview()).token);
  assert.equal(result.failures.length,1);assert.match(result.failures[0].error,/Ready for Test/);
  const restored=new LocalStore(f.directory);await restored.load();
  assert.equal(restored.data.azure.items.find(i=>i.id===1042).state,'Ready for Test');
  assert.deepEqual(restored.data.azure.drafts[1042],{state:'Closed'});
  const planner=new Planner(restored,{...f.azure,update});
  const review=await planner.prepareReview();assert.deepEqual(review.plans[0].stateSteps,['Closed']);
  assert.deepEqual((await planner.sync(review.token)).failures,[]);
  assert.deepEqual(f.calls.map(c=>c.fields.state),['Ready for Test','Closed']);
});

test('a lost response reconciles Azure before continuing, without repeating the applied transition',async t=>{
  const f=await fixture(t),update=f.azure.update;let lost=true;
  f.azure.update=async(...args)=>{const updated=await update(...args);if(lost){lost=false;throw new Error('Respuesta perdida');}return updated;};
  assert.equal((await f.planner.sync((await f.planner.prepareReview()).token)).failures.length,1);
  const review=await f.planner.prepareReview();assert.deepEqual(review.plans[0].stateSteps,['Closed']);
  assert.deepEqual((await f.planner.sync(review.token)).failures,[]);
  assert.deepEqual(f.calls.map(c=>c.fields.state),['Ready for Test','Closed']);
});

test('revision changes stop the sequence before a write and new state changes invalidate review',async t=>{
  const f=await fixture(t),review=await f.planner.prepareReview();
  f.remote.get(1042).rev++;
  const result=await f.planner.sync(review.token);
  assert.equal(result.failures.length,1);assert.equal(f.remote.get(1042).state,'New');
  const nextReview=await f.planner.prepareReview(),data=structuredClone(f.store.data);
  stageChanges(data.azure,1042,{state:'Active'});await f.store.save(data);
  await assert.rejects(()=>f.planner.sync(nextReview.token),/caducado/);
});

test('refresh keeps a state queue even when its final state matches Azure',async()=>{
  const ws=createDemo();ws.mode='azure';
  stageChanges(ws,1042,{state:'Active'});stageChanges(ws,1042,{state:'New'});
  const refreshed=await refreshSection(ws,'tasks',{import:async()=>createDemo()},[]);
  assert.deepEqual(refreshed.stateChanges[1042],['Active','New']);
  assert.equal(refreshed.drafts[1042].state,'New');
});

test('new local tasks are created before applying their saved states',async t=>{
  const f=await fixture(t),data=structuredClone(f.store.data);data.azure.drafts={};data.azure.stateChanges={};
  const id=createLocalItem(data.azure,{type:'Task',title:'Nueva tarea',parent:1001});stageChanges(data.azure,id,{state:'Ready for Test'});completeTask(data.azure,id);await f.store.save(data);
  f.azure.create=async(_config,item,validate)=>{
    assert.equal(item.state,'New');
    const created={...item,id:9000,rev:1,localOnly:false};if(!validate)f.remote.set(9000,created);return created;
  };
  const review=await f.planner.prepareReview();assert.deepEqual(review.plans[0].stateSteps,['Ready for Test','Closed']);
  const result=await f.planner.sync(review.token);
  assert.deepEqual(result.failures,[]);assert.equal(f.remote.get(9000).state,'Closed');
  assert.equal(f.store.data.azure.items.some(i=>i.id===id),false);
});

test('a repeated-state sequence survives a lost response without skipping later occurrences',async t=>{
  const f=await fixture(t),data=structuredClone(f.store.data);
  discardLocal(data.azure,1042);
  for (const state of ['Active','New','Active','Closed']) stageChanges(data.azure,1042,{state});
  await f.store.save(data);
  const update=f.azure.update;let lost=true;
  f.azure.update=async(...args)=>{const updated=await update(...args);if(lost){lost=false;throw new Error('Respuesta perdida');}return updated;};
  assert.equal((await f.planner.sync((await f.planner.prepareReview()).token)).failures.length,1);
  const restored=new LocalStore(f.directory);await restored.load();
  const planner=new Planner(restored,f.azure),review=await planner.prepareReview();
  assert.deepEqual(review.plans[0].stateSteps,['New','Active','Closed']);
  assert.deepEqual((await planner.sync(review.token)).failures,[]);
  assert.deepEqual(f.calls.map(c=>c.fields.state),['Active','New','Active','Closed']);
});

test('an ambiguous lost response requires a choice and cannot silently replay the sequence',async t=>{
  const f=await fixture(t),update=f.azure.update;
  f.azure.update=async(...args)=>{await update(...args);throw new Error('Respuesta perdida');};
  await f.planner.sync((await f.planner.prepareReview()).token);
  f.remote.get(1042).rev++;f.remote.get(1042).state='Active';
  const review=await f.planner.prepareReview();assert.equal(review.plans[0].stateSequenceConflict,true);
  assert.equal((await f.planner.sync(review.token)).failures.length,1);
  assert.equal(f.calls.length,1);
  const data=structuredClone(f.store.data);resolveConflict(data.azure,1042,'local');await f.store.save(data);
  f.azure.update=update;
  assert.deepEqual((await f.planner.sync((await f.planner.prepareReview()).token)).failures,[]);
  assert.deepEqual(f.calls.map(c=>c.fields.state),['Ready for Test','Ready for Test','Closed']);
});

test('discarding a remote conflict removes the queue, while choosing local retains every step',async t=>{
  const f=await fixture(t);f.remote.get(1042).state='Active';f.remote.get(1042).rev++;
  await f.planner.prepareReview();
  const local=structuredClone(f.store.data.azure);resolveConflict(local,1042,'local');
  assert.deepEqual(local.stateChanges[1042],['Ready for Test','Closed']);
  const remote=structuredClone(f.store.data.azure);resolveConflict(remote,1042,'remote');
  assert.equal(remote.stateChanges[1042],undefined);assert.equal(remote.drafts[1042],undefined);
});

test('simulation applies all saved transitions and returning to the original still counts as pending',async t=>{
  const f=await fixture(t),data=structuredClone(f.store.data);data.mode='demo';data.demo=data.azure;data.demo.mode='demo';
  discardLocal(data.demo,1042);
  stageChanges(data.demo,1042,{state:'Active'});stageChanges(data.demo,1042,{state:'New'});
  await f.store.save(data);
  const result=await f.planner.sync((await f.planner.prepareReview()).token);
  assert.deepEqual(result.failures,[]);assert.equal(f.calls.length,0);
  assert.equal(f.store.data.demo.items.find(i=>i.id===1042).rev,3);
  assert.equal(f.store.data.demo.items.find(i=>i.id===1042).state,'New');
  assert.equal(f.store.data.demo.drafts[1042],undefined);
});

test('a failed disk acknowledgement recovers the sent state after restart',async t=>{
  const f=await fixture(t),save=f.store.save.bind(f.store);let fail=true;
  f.store.save=async data=>{
    if (fail && data.azure.items.find(i=>i.id===1042).state==='Ready for Test') {fail=false;throw new Error('Disk unavailable');}
    return save(data);
  };
  const token=(await f.planner.prepareReview()).token;
  await assert.rejects(()=>f.planner.sync(token),/Disk unavailable/);
  const restored=new LocalStore(f.directory);await restored.load();
  const planner=new Planner(restored,f.azure),review=await planner.prepareReview();
  assert.deepEqual(review.plans[0].stateSteps,['Closed']);
  assert.deepEqual((await planner.sync(review.token)).failures,[]);
  assert.deepEqual(f.calls.map(c=>c.fields.state),['Ready for Test','Closed']);
});
