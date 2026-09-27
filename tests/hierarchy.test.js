import test from 'node:test';
import assert from 'node:assert/strict';
import { hierarchy, ancestors, filterHierarchy } from '../dist/hierarchy.js';
import { createDemo, upgradeDemoHierarchy } from '../server/demo.js';
import { stageChanges } from '../server/planner.js';
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

test('ancestor context cannot be edited or sent to Azure',()=>{
  const ws=createDemo();ws.items.find(i=>i.id===1053).contextOnly=true;
  assert.throws(()=>stageChanges(ws,1053,{assignedTo:ana}),/contexto/);
});

test('demo migration enriches the old example without discarding local work',()=>{
  const ws=createDemo();delete ws.demoHierarchyVersion;
  ws.items=ws.items.filter(i=>i.id>=1038);ws.items.forEach(i=>i.parent=null);
  ws.drafts={1042:{remainingWork:99}};
  assert.equal(upgradeDemoHierarchy(ws),true);
  assert.deepEqual(ws.drafts,{1042:{remainingWork:99}});
  assert.equal(ws.items.find(i=>i.id===1042).parent,1001);
  assert.equal(upgradeDemoHierarchy(ws),false);
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
test('estimate fields follow each type in Azure, with the usual Task fields when unknown',async()=>{
  const {estimateFields}=await import('../dist/hierarchy.js');
  const task={type:'Task',canEstimateHours:true,originalEstimate:null}, bug={type:'Bug',canEstimateHours:false,originalEstimate:null};
  assert.deepEqual(estimateFields({},task),{originalEstimate:'Original Estimate',remainingWork:'Remaining Work'});
  assert.deepEqual(estimateFields({},bug),{originalEstimate:null,remainingWork:null});
  const scrum={estimateFields:{Task:{originalEstimate:null,remainingWork:'Remaining Work'}}};
  assert.deepEqual(estimateFields(scrum,task),{originalEstimate:null,remainingWork:'Remaining Work'},'a process without Original Estimate does not offer it');
  const joint={sources:[{id:'a',estimateFields:{Task:{originalEstimate:'Estimación original',remainingWork:'Trabajo restante'}}}]};
  assert.equal(estimateFields(joint,{...task,sourceId:'a'}).remainingWork,'Trabajo restante','each project uses its own field names');
});
