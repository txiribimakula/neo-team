import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo} from '../server/demo.js';
import {selectTasks,toggleParticipation,effectiveItems,stageChanges} from '../server/planner.js';
import {eligibleTasks,participantSources,hierarchy,selectionSummary,capacityStatus} from '../dist/hierarchy.js';
const ana='ana@example.test',marcos='marcos@example.test';
const item=(ws,id)=>effectiveItems(ws).find(i=>i.id===id);

test('checking saves the assignment immediately; unchecking releases it without losing other edits',()=>{
  const ws=createDemo();stageChanges(ws,1053,{priority:1,remainingWork:9});
  selectTasks(ws,ana,[1053],'sprint-24',true);
  assert.equal(item(ws,1053).assignedTo,ana);assert.equal(item(ws,1053).iterationPath,ws.iterations[0].path);
  assert.equal(selectionSummary(ws,ana,'sprint-24').planned.length,3);
  selectTasks(ws,ana,[1053],'sprint-24',false);
  assert.equal(item(ws,1053).assignedTo,'');assert.equal(item(ws,1053).iterationPath,ws.settings.backlogIteration.path);
  assert.deepEqual(ws.drafts[1053],{priority:1,remainingWork:9});
  assert.ok(eligibleTasks(ws,ana).some(i=>i.id===1053),'the unchecked task remains available to recheck');
});

test('an imported assignment with no shared branch remains selectable after unchecking and reloading',()=>{
  const ws=createDemo();ws.participants={};
  selectTasks(ws,ana,[1042],'sprint-24',false);
  const restored=JSON.parse(JSON.stringify(ws));
  assert.equal(item(restored,1042).assignedTo,'');
  assert.ok(eligibleTasks(restored,ana).some(i=>i.id===1042));
  selectTasks(restored,ana,[1042],'sprint-24',true);
  assert.equal(restored.drafts[1042],undefined,'rechecking the original assignment produces no remote change');
});

test('bulk unchecking validates the entire set before changing any task',()=>{
  const ws=createDemo(),before=JSON.stringify(ws);
  assert.throws(()=>selectTasks(ws,ana,[1042,1038],'sprint-24',false),/Solo puedes/);
  assert.equal(JSON.stringify(ws),before);
  assert.throws(()=>selectTasks(ws,ana,[1042],'sprint-25',false));
  assert.throws(()=>selectTasks(ws,ana,[1042],'sprint-24','false'));
});

test('removing a shared branch releases only that person current iteration tasks',()=>{
  const ws=createDemo();selectTasks(ws,ana,[1053],'sprint-24',true);
  toggleParticipation(ws,1053,marcos,true,'sprint-24');
  assert.throws(()=>selectTasks(ws,marcos,[1053],'sprint-24',false));
  const otherBefore=item(ws,1038);
  toggleParticipation(ws,1001,ana,false,'sprint-24');
  for(const id of [1042,1045,1053]){assert.equal(item(ws,id).assignedTo,'');assert.equal(item(ws,id).iterationPath,ws.settings.backlogIteration.path);}
  assert.deepEqual(item(ws,1038),otherBefore);
  assert.ok(!eligibleTasks(ws,ana).some(i=>[1042,1045,1053].includes(i.id)));
  assert.ok(eligibleTasks(ws,marcos).some(i=>i.id===1053));
  assert.ok(ws.participantExclusions[1001].includes(ana));
});

test('removing a parent suppresses nested memberships; a child can be explicitly included again',()=>{
  const ws=createDemo();toggleParticipation(ws,900,ana,true,'sprint-24');toggleParticipation(ws,1001,ana,true,'sprint-24');
  toggleParticipation(ws,900,ana,false,'sprint-24');
  assert.ok(!eligibleTasks(ws,ana).some(i=>i.id===1053));
  toggleParticipation(ws,1001,ana,true,'sprint-24');
  assert.ok(eligibleTasks(ws,ana).some(i=>i.id===1053));
  assert.ok(!eligibleTasks(ws,ana).some(i=>i.id===1059));
  const current=JSON.parse(JSON.stringify(ws));
  assert.ok(participantSources(item(current,1053),current,hierarchy(effectiveItems(current))).has(ana));
});

test('branch exclusion preserves assignments from other iterations and does not restore selected tasks when re-enabled',()=>{
  const ws=createDemo();stageChanges(ws,1042,{iterationPath:ws.iterations[1].path});
  toggleParticipation(ws,1001,ana,false,'sprint-24');
  assert.equal(item(ws,1042).assignedTo,ana);assert.equal(item(ws,1042).iterationPath,ws.iterations[1].path);
  assert.equal(item(ws,1045).assignedTo,'');
  toggleParticipation(ws,1001,ana,true,'sprint-24');
  assert.equal(item(ws,1045).assignedTo,'');assert.ok(eligibleTasks(ws,ana).some(i=>i.id===1045));
});

test('capacity indicator distinguishes remaining, full, over, missing estimates and zero capacity',()=>{
  const summary={plannedHours:16,capacity:24,unknownPlanned:0};
  assert.equal(capacityStatus(summary).status,'open');
  assert.equal(capacityStatus({...summary,plannedHours:24}).status,'full');
  assert.equal(capacityStatus({...summary,plannedHours:25}).status,'over');
  assert.equal(capacityStatus({...summary,capacity:null}).status,'unknown');
  assert.equal(capacityStatus({...summary,plannedHours:24,unknownPlanned:1}).status,'unknown');
  assert.equal(capacityStatus({...summary,plannedHours:0,capacity:0}).status,'zero');
  assert.deepEqual(capacityStatus({...summary,capacity:0}).percent,100);
});
