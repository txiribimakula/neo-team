import test from 'node:test';
import assert from 'node:assert/strict';
import { hierarchy, ancestors, eligibleTasks, participantSources, filterHierarchy } from '../dist/hierarchy.js';
import { createDemo, upgradeDemoHierarchy } from '../server/demo.js';
import { setParticipants, planTasks, stageChanges, planReview } from '../server/planner.js';
const ana='ana@example.test', marcos='marcos@example.test';

test('hierarchy follows real parents through Epic, Feature, Story and Task/Bug',()=>{
  const ws=createDemo(),tree=hierarchy(ws.items);
  assert.deepEqual(ancestors(1053,tree).map(i=>i.type),['Epic','Feature','User Story']);
  assert.deepEqual(ancestors(1057,tree).map(i=>i.id),[900,910,1002]);
  const filtered=filterHierarchy(tree.roots,item=>item.id===1057);
  assert.equal(filtered[0].id,900);assert.equal(filtered[0].children[0].children[0].children[0].id,1057);
});

test('orphans, self-parents and cycles remain visible exactly once',()=>{
  const items=[{id:1,parent:2,type:'Epic'},{id:2,parent:1,type:'Feature'},{id:3,parent:999,type:'Bug'},{id:4,parent:4,type:'Task'}];
  const tree=hierarchy(items),flatten=nodes=>nodes.flatMap(n=>[n.id,...flatten(n.children)]);
  assert.deepEqual(flatten(tree.roots).sort(),[1,2,3,4]);
  assert.deepEqual(ancestors(3,tree),[]);assert.ok(ancestors(1,tree).length<2);
});

test('shared branches inherit additively and the same leaf is eligible for several people',()=>{
  const ws=createDemo();ws.participants={};
  setParticipants(ws,[{id:900,members:[ana,ana]},{id:910,members:[marcos]}]);
  assert.deepEqual(ws.participants[900],[ana]);
  for(const person of [ana,marcos])assert.ok(eligibleTasks(ws,person).some(i=>i.id===1053));
  assert.ok(!eligibleTasks(ws,marcos).some(i=>i.id===1059));
  const sources=participantSources(ws.items.find(i=>i.id===1053),ws);
  assert.equal(sources.get(ana)[0].id,900);assert.equal(sources.get(marcos)[0].id,910);
  assert.deepEqual(ws.drafts,{},'local participation never stages Azure fields');
  setParticipants(ws,[{id:1059,members:[ana,marcos]}]);
  assert.ok(eligibleTasks(ws,marcos).some(i=>i.id===1059),'a task itself can be shared');
  setParticipants(ws,[{id:900,members:[]}]);
  assert.ok(!eligibleTasks(ws,ana).some(i=>i.id===1053));
  assert.ok(eligibleTasks(ws,ana).some(i=>i.id===1042),'the current task owner remains eligible');
});

test('invalid participant batches cannot partially alter the local sharing map',()=>{
  const ws=createDemo(),before=structuredClone(ws.participants);
  assert.throws(()=>setParticipants(ws,[{id:900,members:[ana]},{id:910,members:['foreign@example.test']}]),/integrantes/);
  assert.deepEqual(ws.participants,before);
});

test('batch planning only accepts eligible tasks, retains sharing and writes a unique owner',()=>{
  const ws=createDemo();setParticipants(ws,[{id:910,members:[ana,marcos]}]);
  const sharing=structuredClone(ws.participants);
  planTasks(ws,ana,[1053,1057],'sprint-24');
  assert.deepEqual(ws.drafts[1053],{assignedTo:ana,iterationPath:ws.iterations[0].path});
  assert.deepEqual(ws.participants,sharing);
  assert.equal(planReview(ws,ws.items).length,2);
  const before=structuredClone(ws.drafts);
  assert.throws(()=>planTasks(ws,ana,[1054,1042],'sprint-24'),/no forma parte/);
  assert.deepEqual(ws.drafts,before);
  assert.throws(()=>planTasks(ws,marcos,[1053],'sprint-24'),/otro responsable/);
  assert.throws(()=>planTasks(ws,ana,[900],'sprint-24'),/no forma parte/);
  assert.throws(()=>planTasks(ws,ana,[1053,1053],'sprint-24'),/distintas/);
  assert.throws(()=>planTasks(ws,ana,[1053],'unknown'),/iteración/);
});

test('ancestor context cannot be planned or sent to Azure',()=>{
  const ws=createDemo();ws.items.find(i=>i.id===1053).contextOnly=true;
  assert.ok(!eligibleTasks(ws,ana).some(i=>i.id===1053));
  assert.throws(()=>stageChanges(ws,1053,{assignedTo:ana}),/contexto/);
});

test('demo migration enriches the old example without discarding local work',()=>{
  const ws=createDemo();delete ws.demoHierarchyVersion;delete ws.participants;
  ws.items=ws.items.filter(i=>i.id>=1038);ws.items.forEach(i=>i.parent=null);
  ws.drafts={1042:{remainingWork:99}};
  assert.equal(upgradeDemoHierarchy(ws),true);
  assert.deepEqual(ws.drafts,{1042:{remainingWork:99}});
  assert.equal(ws.items.find(i=>i.id===1042).parent,1001);
  assert.equal(upgradeDemoHierarchy(ws),false);
});

test('selection preview counts only new eligible tasks and never turns points into hours',async()=>{
  const {selectionSummary}=await import('../dist/hierarchy.js');
  const ws=createDemo();ws.capacityHours={'sprint-24':{ana:24}};
  setParticipants(ws,[{id:1057,members:[ana]}]);
  const result=selectionSummary(ws,ana,'sprint-24',[1053,1053,1057,1042,1054]);
  assert.equal(result.plannedHours,20);assert.equal(result.selectedHours,6);assert.equal(result.projectedHours,26);assert.equal(result.freeHours,-2);
  assert.equal(result.unknownSelected,1,'bug without hours is unknown, not free work');
  assert.deepEqual(result.selected.map(i=>i.id),[1053,1057]);assert.deepEqual(result.invalidIds,[1042,1054]);
});

test('selection preview uses saved drafts and distinguishes zero from unknown capacity',async()=>{
  const {selectionSummary}=await import('../dist/hierarchy.js');
  const ws=createDemo();stageChanges(ws,1042,{remainingWork:30});
  let result=selectionSummary(ws,ana,'sprint-24',[1053]);
  assert.equal(result.plannedHours,38);assert.equal(result.capacity,null);assert.equal(result.freeHours,null);
  ws.capacityHours={'sprint-24':{ana:0}};
  result=selectionSummary(ws,ana,'sprint-24',[1053]);assert.equal(result.capacity,0);assert.equal(result.freeHours,-38);assert.deepEqual(result.selected,[]);
  planTasks(ws,ana,[1053],'sprint-24');
  result=selectionSummary(ws,marcos,'sprint-24',[1053]);assert.deepEqual(result.invalidIds,[1053]);assert.equal(result.selectedHours,0);
});

test('the previous iteration is the latest that starts earlier, whatever the listed order',async()=>{
  const {previousIteration}=await import('../dist/hierarchy.js');
  const ws=createDemo();
  assert.equal(previousIteration(ws.iterations,'sprint-24').id,'sprint-23');
  assert.equal(previousIteration(ws.iterations,'sprint-25').id,'sprint-24');
  assert.equal(previousIteration(ws.iterations,'sprint-23'),null);
  assert.equal(previousIteration(ws.iterations,'missing'),null);
  assert.equal(previousIteration([{id:'a'},{id:'b'}],'b').id,'a','undated iterations keep the Azure order');
});

test('demo migration adds the previous iteration once without discarding local work',async()=>{
  const {upgradeDemoPreviousIteration}=await import('../server/demo.js');
  const ws=createDemo();
  ws.iterations=ws.iterations.filter(i=>!i.past);ws.items=ws.items.filter(i=>i.id<1030 || i.id>1035);
  delete ws.demoPreviousVersion;delete ws.completedStates;ws.drafts={1042:{remainingWork:99}};
  assert.equal(upgradeDemoPreviousIteration(ws),true);
  const previous=ws.iterations.find(i=>i.past);
  assert.ok(previous.attributes.finishDate<ws.iterations[0].attributes.startDate);
  assert.equal(ws.items.filter(i=>i.iterationPath===previous.path).length,6);
  assert.deepEqual(ws.drafts,{1042:{remainingWork:99}});assert.equal(ws.completedStates.Task,'Closed');
  assert.equal(upgradeDemoPreviousIteration(ws),false);
});

test('each project keeps an independent hierarchy even with parent links across projects',()=>{
  const items=[{id:10,type:'Epic',sourceId:'a',project:'A'},{id:5,type:'Epic',sourceId:'b',project:'B'},{id:21,type:'Feature',parent:10,sourceId:'b',project:'B'},{id:11,type:'Feature',parent:10,sourceId:'a',project:'A'}];
  const tree=hierarchy(items);
  assert.deepEqual(tree.roots.map(n=>n.id),[10,5,21]);
  assert.deepEqual(tree.nodes.get(10).children.map(n=>n.id),[11]);
  assert.deepEqual(ancestors(21,tree),[]);
});
