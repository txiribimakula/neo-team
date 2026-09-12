import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo} from '../server/demo.js';
import {confirmPerson,invalidateConfirmations,planningWorkspace,stageChanges} from '../server/planner.js';
import {personPlanningStatus,orderedPlanningMembers} from '../dist/hierarchy.js';
const ana='ana@example.test',iteration='sprint-24';
function coveredWorkspace() {
  const ws=createDemo();
  const capacity=planningWorkspace(ws).capacityHours[iteration][ws.members.find(m=>m.uniqueName===ana).id];
  stageChanges(ws,1042,{remainingWork:capacity});stageChanges(ws,1045,{remainingWork:0});
  return ws;
}
test('covered people move last with stable order and confirmation does not move the selected person',()=>{
  const ws=coveredWorkspace(),view=planningWorkspace(ws);
  const ordered=orderedPlanningMembers(view,iteration);
  const expectedCovered=ws.members.filter(m=>personPlanningStatus(view,m.uniqueName,iteration).covered);
  const expectedOpen=ws.members.filter(m=>!personPlanningStatus(view,m.uniqueName,iteration).covered);
  assert.ok(expectedCovered.some(m=>m.uniqueName===ana));
  assert.deepEqual(ordered.map(p=>p.member.id),[...expectedOpen,...expectedCovered].map(m=>m.id));
  const before=ordered.map(p=>p.member.id);confirmPerson(ws,ana,iteration);
  assert.deepEqual(orderedPlanningMembers(planningWorkspace(ws),iteration).map(p=>p.member.id),before);
  assert.equal(personPlanningStatus(planningWorkspace(ws),ana,iteration).confirmed,true);
});
test('confirmation survives serialization and unrelated edits, but an edited plan must be confirmed again',()=>{
  let ws=coveredWorkspace();confirmPerson(ws,ana,iteration);
  ws=JSON.parse(JSON.stringify(ws));invalidateConfirmations(ws);
  assert.equal(personPlanningStatus(planningWorkspace(ws),ana,iteration).confirmed,true);
  stageChanges(ws,1038,{remainingWork:2});invalidateConfirmations(ws);
  assert.equal(personPlanningStatus(planningWorkspace(ws),ana,iteration).confirmed,true);
  const original=planningWorkspace(ws).effectiveItems.find(i=>i.id===1042).remainingWork;
  stageChanges(ws,1042,{remainingWork:original+1});invalidateConfirmations(ws);
  assert.equal(personPlanningStatus(planningWorkspace(ws),ana,iteration).confirmed,false);
  stageChanges(ws,1042,{remainingWork:original});invalidateConfirmations(ws);
  assert.equal(personPlanningStatus(planningWorkspace(ws),ana,iteration).confirmed,false,'restoring hours must not resurrect confirmation');
  confirmPerson(ws,ana,iteration);
  stageChanges(ws,1042,{assignedTo:'marcos@example.test'});invalidateConfirmations(ws);
  assert.equal(personPlanningStatus(planningWorkspace(ws),ana,iteration).confirmed,false);
});
test('confirmation validates capacity, estimates, member and iteration, and allows explicit acceptance of overload',()=>{
  const ws=createDemo();assert.throws(()=>confirmPerson(ws,ana,iteration),/Completa/);
  assert.throws(()=>confirmPerson(ws,'missing',iteration),/no válida/);
  assert.throws(()=>confirmPerson(ws,ana,'missing'),/no válida/);
  const full=coveredWorkspace();stageChanges(full,1045,{remainingWork:1});confirmPerson(full,ana,iteration);
  assert.equal(personPlanningStatus(planningWorkspace(full),ana,iteration).confirmed,true);
  assert.equal(personPlanningStatus(planningWorkspace(full),ana,'sprint-25').confirmed,false);
  full.items.find(i=>i.id===1045).remainingWork=null;delete full.drafts[1045];
  assert.throws(()=>confirmPerson(full,ana,iteration),/Completa/);
  full.capacities={};assert.throws(()=>confirmPerson(full,ana,iteration),/Completa/);
});
