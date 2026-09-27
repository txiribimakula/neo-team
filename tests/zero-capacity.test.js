import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo} from '../server/demo.js';
import {planningWorkspace,stageChanges} from '../server/planner.js';
import {hasPlanningCapacity} from '../dist/hierarchy.js';
const ana='ana@example.test',iteration='sprint-24';

test('people with zero capacity get no lane, but their tasks can still be moved',()=>{
  const ws=createDemo(),person=ws.members.find(m=>m.uniqueName===ana);
  ws.capacities[iteration].teamMembers.find(record=>record.teamMember.id===person.id).activities=[{name:'Development',capacityPerDay:0}];
  const view=planningWorkspace(ws);
  assert.equal(view.capacityHours[iteration][person.id],0);
  assert.equal(hasPlanningCapacity(view,ana,iteration),false);
  assert.doesNotThrow(()=>stageChanges(ws,1053,{assignedTo:ana,iterationPath:ws.iterations.find(i=>i.id===iteration).path}),'moving a task there is allowed: the interface only warns');
  assert.equal(ws.drafts[1053].assignedTo,ana);
});
