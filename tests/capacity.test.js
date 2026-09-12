import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemo } from '../server/demo.js';
import { LocalStore } from '../server/store.js';
import { Planner, stageCapacity, discardCapacity, capacityChanges, effectiveCapacity, capacityEntry, planningWorkspace, resolveCapacityConflict, workingCapacity } from '../server/planner.js';

const day = value => value.slice(0,10);
function demo() {
  const workspace = createDemo();
  const iteration = workspace.iterations[0];
  return { workspace, iteration, start: day(iteration.attributes.startDate), finish: day(iteration.attributes.finishDate) };
}

test('capacity staging normalizes reversions and rejects values Azure would refuse',()=>{
  const { workspace, iteration, start, finish } = demo();
  stageCapacity(workspace,iteration.id,{key:'ana',activities:[{name:'Development',capacityPerDay:7}]});
  assert.deepEqual(workspace.capacityDrafts[iteration.id].ana.activities,[{name:'Development',capacityPerDay:7}]);
  assert.deepEqual(workspace.capacityDrafts[iteration.id].ana.daysOff,[],'the imported days off are kept when only hours change');
  stageCapacity(workspace,iteration.id,{key:'ana',activities:[{name:'Development',capacityPerDay:5}]});
  assert.equal(workspace.capacityDrafts[iteration.id],undefined,'returning to the imported value leaves nothing pending');
  stageCapacity(workspace,iteration.id,{key:'team',daysOff:[{start,end:start}]});
  assert.deepEqual(capacityChanges(workspace).map(c=>c.key),['team']);
  const invalid = [
    {key:'ana',activities:[{name:'Development',capacityPerDay:25}]},
    {key:'ana',activities:[{name:'Development',capacityPerDay:-1}]},
    {key:'ana',activities:[{name:'A',capacityPerDay:1},{name:'a',capacityPerDay:2}]},
    {key:'ana',daysOff:[{start:'2026-13-01',end:'2026-13-02'}]},
    {key:'ana',daysOff:[{start:finish,end:start}]},
    {key:'ana',daysOff:[{start,end:finish},{start,end:start}]},
    {key:'ana',daysOff:[{start:'1999-01-01',end:'1999-01-02'}]},
    {key:'intruder',activities:[]},
  ];
  for (const change of invalid) assert.throws(()=>stageCapacity(workspace,iteration.id,change),Error,JSON.stringify(change));
  assert.throws(()=>stageCapacity(workspace,'missing',{key:'ana',activities:[]}),/iteración/);
  assert.throws(()=>stageCapacity(workspace,iteration.id,{key:'ana'}),/algún cambio/);
  // Azure data that no longer fits the iteration must not block an unrelated edit.
  workspace.capacities[iteration.id].teamMembers.find(m=>m.teamMember.id==='ana').daysOff=[{start:'1999-01-01',end:'1999-01-02'}];
  stageCapacity(workspace,iteration.id,{key:'ana',activities:[{name:'Development',capacityPerDay:3}]});
  assert.deepEqual(workspace.capacityDrafts[iteration.id].ana.daysOff,[{start:'1999-01-01',end:'1999-01-02'}]);
});

test('edited capacity and days off drive the planning hours right away',()=>{
  const { workspace, iteration, start } = demo();
  const before = planningWorkspace(workspace).capacityHours[iteration.id];
  stageCapacity(workspace,iteration.id,{key:'ana',activities:[{name:'Development',capacityPerDay:10}]});
  const hours = planningWorkspace(workspace).capacityHours[iteration.id];
  assert.equal(hours.ana,before.ana*2);
  assert.equal(hours.marcos,before.marcos,'other people keep their imported capacity');
  stageCapacity(workspace,iteration.id,{key:'team',daysOff:[{start,end:start}]});
  assert.equal(planningWorkspace(workspace).capacityHours[iteration.id].ana,hours.ana-10);
  // A person without capacity in Azure can be given one from this step.
  const empty = createDemo();
  empty.capacities[iteration.id].teamMembers=empty.capacities[iteration.id].teamMembers.filter(m=>m.teamMember.id!=='ana');
  assert.equal(planningWorkspace(empty).capacityHours[iteration.id].ana,null);
  stageCapacity(empty,iteration.id,{key:'ana',activities:[{name:'',capacityPerDay:4}]});
  assert.equal(planningWorkspace(empty).capacityHours[iteration.id].ana,workingCapacity(iteration,effectiveCapacity(empty,iteration.id),'ana',empty.settings.workingDays));
  assert.ok(planningWorkspace(empty).capacityHours[iteration.id].ana>0);
  discardCapacity(empty,iteration.id);
  assert.equal(planningWorkspace(empty).capacityHours[iteration.id].ana,null);
});

async function fixture(t, mode) {
  const dir = await mkdtemp(join(tmpdir(),'neo-capacity-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const store = new LocalStore(dir); await store.load();
  const workspace = createDemo(); workspace.mode = mode;
  await store.save({...store.data,mode,[mode]:workspace});
  const remote = structuredClone(workspace.capacities), calls = [];
  const azure = {
    open:async()=>{}, getItems:async()=>[],
    capacity:async(_config,iterationId)=>structuredClone(remote[iterationId]),
    updateMemberCapacity:async(_config,iterationId,memberId,activities,daysOff)=>{
      calls.push({iterationId,memberId,activities,daysOff});
      const record=remote[iterationId].teamMembers.find(m=>m.teamMember.id===memberId);
      Object.assign(record,{activities,daysOff});
      return {activities,daysOff};
    },
    updateTeamDaysOff:async(_config,iterationId,daysOff)=>{
      calls.push({iterationId,daysOff});
      remote[iterationId].daysOff=daysOff;
      return {activities:[],daysOff};
    },
  };
  return { store, planner: new Planner(store,azure), remote, calls, workspace: ()=>store.data[mode],
    stage: async change=>{const data=structuredClone(store.data);stageCapacity(data[mode],data[mode].iterations[0].id,change);await store.save(data);} };
}

test('capacity changes reach Azure DevOps through the review and update the local copy',async t=>{
  const { store, planner, remote, calls, workspace, stage } = await fixture(t,'azure');
  const iteration = workspace().iterations[0], start = day(iteration.attributes.startDate);
  await stage({key:'ana',activities:[{name:'Development',capacityPerDay:7}],daysOff:[{start,end:start}]});
  await stage({key:'team',daysOff:[{start,end:start}]});
  const review = await planner.prepareReview();
  assert.ok(review.token,'no conflicts on an untouched iteration');
  assert.deepEqual(review.capacityPlans.map(p=>p.key),['ana','team']);
  assert.deepEqual(review.capacityPlans[0].original.activities,[{name:'Development',capacityPerDay:5}]);
  const result = await planner.sync(review.token);
  assert.deepEqual(result.capacity.failures,[]);
  assert.equal(result.capacity.successes.length,2);
  assert.deepEqual(calls[0],{iterationId:iteration.id,memberId:'ana',activities:[{name:'Development',capacityPerDay:7}],daysOff:[{start,end:start}]});
  assert.deepEqual(calls[1],{iterationId:iteration.id,daysOff:[{start,end:start}]});
  assert.equal(remote[iteration.id].teamMembers.find(m=>m.teamMember.id==='ana').activities[0].capacityPerDay,7);
  assert.deepEqual(workspace().capacityDrafts,{},'a confirmed write leaves no pending capacity');
  assert.deepEqual(capacityEntry(workspace().capacities[iteration.id],'ana'),{activities:[{name:'Development',capacityPerDay:7}],daysOff:[{start,end:start}]});
  assert.equal(store.data.azure.lastSyncedAt!==undefined,true);
});

test('a capacity changed in Azure since the import is reported as a conflict and can be resolved',async t=>{
  const { planner, remote, calls, workspace, stage } = await fixture(t,'azure');
  const iteration = workspace().iterations[0];
  await stage({key:'ana',activities:[{name:'Development',capacityPerDay:7}]});
  remote[iteration.id].teamMembers.find(m=>m.teamMember.id==='ana').activities=[{name:'Development',capacityPerDay:3}];
  const review = await planner.prepareReview();
  assert.equal(review.token,null,'a conflict blocks the synchronization');
  assert.equal(review.capacityPlans[0].conflict,true);
  assert.deepEqual(workspace().capacityConflicts[iteration.id].ana.activities,[{name:'Development',capacityPerDay:3}]);
  await assert.rejects(()=>planner.sync(review.token),/caducado|conflictos/);
  const kept = structuredClone(workspace());
  resolveCapacityConflict(kept,iteration.id,'ana','local');
  assert.deepEqual(capacityEntry(kept.capacities[iteration.id],'ana').activities,[{name:'Development',capacityPerDay:3}],'the Azure value becomes the new base');
  assert.deepEqual(kept.capacityDrafts[iteration.id].ana.activities,[{name:'Development',capacityPerDay:7}],'my change stays pending');
  const discarded = structuredClone(workspace());
  resolveCapacityConflict(discarded,iteration.id,'ana','remote');
  assert.deepEqual(discarded.capacityDrafts,{});
  assert.equal(calls.length,0,'nothing is written to Azure while the conflict is open');
  assert.throws(()=>resolveCapacityConflict(discarded,iteration.id,'ana','remote'),/Revisa/);
});

test('the demo mode simulates capacity synchronization without contacting Azure',async t=>{
  const { planner, calls, workspace, stage } = await fixture(t,'demo');
  const iteration = workspace().iterations[0];
  await stage({key:'ana',activities:[{name:'Development',capacityPerDay:9}]});
  const review = await planner.prepareReview();
  const result = await planner.sync(review.token);
  assert.equal(result.demo,true);
  assert.deepEqual(result.capacity.failures,[]);
  assert.equal(calls.length,0);
  assert.equal(capacityEntry(workspace().capacities[iteration.id],'ana').activities[0].capacityPerDay,9);
  assert.deepEqual(workspace().capacityDrafts,{});
});
