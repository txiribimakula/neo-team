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
      if (rev !== null) assert.equal(remote.get(id).rev,rev,'revision test');
      const updated={...remote.get(id),...changes,rev:remote.get(id).rev+1};remote.set(id,updated);return structuredClone(updated);
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
  assert.throws(()=>stageChanges(ws,1047,{originalEstimate:1}),/estimación original/,'the example Bug has no Original Estimate');
  stageChanges(ws,1042,{originalEstimate:10});assert.equal(ws.drafts[1042].originalEstimate,10);
  ws.estimateFields.Bug={originalEstimate:null,remainingWork:null};
  assert.throws(()=>stageChanges(ws,1047,{remainingWork:1}),'a type without the field in Azure cannot be given hours');
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
  assert.deepEqual(result.successes,[1042]);assert.deepEqual(f.calls[0],{id:1042,rev:null,changes:{remainingWork:18}});
  assert.equal(f.workspace().items.find(i=>i.id===1042).title,'New remote title');
  assert.equal(f.workspace().drafts[1042],undefined);
  const persisted=JSON.parse(await readFile(f.store.file,'utf8'));assert.equal(persisted.azure.items.find(i=>i.id===1042).remainingWork,18);
});
test('conflicts are informative and synchronizing keeps the local version',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});
  f.remote.set(1042,{...f.remote.get(1042),remainingWork:6,rev:2});
  const review=await f.planner.prepareReview();assert.ok(review.token);assert.deepEqual(review.plans[0].conflicts,['remainingWork']);
  const result=await f.planner.sync(review.token);assert.deepEqual(result.successes,[1042]);
  assert.equal(f.remote.get(1042).remainingWork,18);assert.equal(f.workspace().drafts[1042],undefined);
});
test('an explicit local resolution rebases the draft on the Azure version',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});
  f.remote.set(1042,{...f.remote.get(1042),remainingWork:6,rev:2});await f.planner.prepareReview();
  const data=structuredClone(f.store.data);resolveConflict(data.azure,1042,'local');await f.store.save(data);
  assert.equal(f.workspace().items.find(i=>i.id===1042).remainingWork,6);assert.equal(f.workspace().drafts[1042].remainingWork,18);
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
test('a remote revision change after review does not stop the local version',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});await f.stage(1045,{priority:1});const review=await f.planner.prepareReview();
  f.remote.set(1045,{...f.remote.get(1045),rev:9});const result=await f.planner.sync(review.token);
  assert.deepEqual(result.successes,[1042,1045]);assert.deepEqual(f.calls.map(c=>[c.id,c.rev]),[[1042,null],[1045,null]]);
});
test('a race after the review is overwritten with the local version',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});const review=await f.planner.prepareReview();
  const update=f.azure.update;f.azure.update=async(...args)=>{f.remote.set(1042,{...f.remote.get(1042),remainingWork:99,rev:5});return update(...args);};
  const result=await f.planner.sync(review.token);assert.deepEqual(result.failures,[]);assert.equal(f.remote.get(1042).remainingWork,18);assert.equal(f.workspace().drafts[1042],undefined);
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
test('a task that cannot be read is reported alone and does not stop the rest',async t=>{
  const ws=createDemo();stageChanges(ws,1042,{remainingWork:18});assert.equal(planReview(ws,[])[0].missing,true);
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});await f.stage(1045,{priority:1});
  const getItems=f.azure.getItems;f.azure.getItems=async(c,ids)=>getItems(c,ids.filter(id=>id!==1045));
  const review=await f.planner.prepareReview();const result=await f.planner.sync(review.token);
  assert.deepEqual(result.successes,[1042]);assert.equal(result.failures[0].id,1045);assert.match(result.failures[0].error,/No se pudo leer/);
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
test('an uncertain creation is searched again and sent again only if Azure still does not have it',async t=>{
  const {createLocalItem,discardLocal}=await import('../server/planner.js');
  const f=await fixture(t);f.planner.retryDelay=1;const data=structuredClone(f.store.data);
  const id=createLocalItem(data.azure,{type:'Task',title:'Recover me',parent:1001,remainingWork:3});await f.store.save(data);
  let creates=0,lose=true,checks=0;
  f.azure.findCreation=async()=>{checks++;return null;};
  f.azure.create=async(_config,item,validate)=>{if(validate)return {};creates++;if(lose){lose=false;throw new Error('Connection lost');}return {...item,id:8000+creates,rev:1};};
  let review=await f.planner.prepareReview();let result=await f.planner.sync(review.token);assert.equal(result.failures.length,1);assert.equal(creates,1);
  assert.ok(f.workspace().drafts[id]);assert.throws(()=>discardLocal(f.workspace(),id),/sin confirmar/);
  assert.throws(()=>stageChanges(f.workspace(),id,{title:'Changed'}),/Recupera/);
  review=await f.planner.prepareReview();checks=0;result=await f.planner.sync(review.token);
  assert.deepEqual(result.failures,[]);assert.equal(checks,4,'searched again before sending');assert.equal(creates,2);
  assert.ok(f.workspace().items.some(i=>i.id===8002));assert.equal(f.workspace().drafts[id],undefined);
});
test('an uncertain creation that appears in Azure is recovered without sending it again',async t=>{
  const {createLocalItem}=await import('../server/planner.js');
  const f=await fixture(t);f.planner.retryDelay=1;const data=structuredClone(f.store.data);
  createLocalItem(data.azure,{type:'Task',title:'Recover me',parent:1001,remainingWork:3});await f.store.save(data);
  let creates=0,remoteCreated=null;
  f.azure.findCreation=async()=>remoteCreated;
  f.azure.create=async(_config,item,validate)=>{if(validate)return {};creates++;remoteCreated={...item,id:8000,rev:1};throw new Error('Connection lost');};
  let review=await f.planner.prepareReview();await f.planner.sync(review.token);
  review=await f.planner.prepareReview();const result=await f.planner.sync(review.token);
  assert.deepEqual(result.failures,[]);assert.equal(creates,1);assert.ok(f.workspace().items.some(i=>i.id===8000));
});
test('a parent changed in Azure does not stop creating its child',async t=>{
  const {createLocalItem}=await import('../server/planner.js');const f=await fixture(t),data=structuredClone(f.store.data);
  createLocalItem(data.azure,{type:'Task',title:'Child',parent:1001});await f.store.save(data);
  const review=await f.planner.prepareReview();f.remote.get(1001).rev++;
  f.azure.findCreation=async()=>null;f.azure.create=async(_c,item,validate)=>validate ? {} : {...item,id:9000,rev:1};
  const result=await f.planner.sync(review.token);assert.deepEqual(result.failures,[]);assert.ok(f.workspace().items.some(i=>i.id===9000));
});
test('invalid hierarchy and creation fields are rejected; local creation can be discarded before sending',async t=>{
  const {createLocalItem,discardLocal}=await import('../server/planner.js');const f=await fixture(t,'demo');
  assert.throws(()=>createLocalItem(f.workspace(),{type:'Task',title:'No parent'}),/padre/);
  assert.throws(()=>createLocalItem(f.workspace(),{type:'Feature',title:'Wrong parent',parent:1001}),/nivel/);
  const id=createLocalItem(f.workspace(),{type:'Bug',title:'New bug',parent:1001});discardLocal(f.workspace(),id);
  assert.ok(!f.workspace().items.some(i=>i.id===id));assert.equal(f.workspace().drafts[id],undefined);
});

test('reviewing the previous iteration carries tasks over or closes them with the completed state of their type',async t=>{
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
  assert.equal(f.workspace().items.find(i=>i.id===1030).assignedTo,'ana@example.test','a carried-over task stays with its owner');
  await f.stage(1032,{state:'Closed'});await f.stage(1032,{state:'New'});
  assert.equal(f.workspace().drafts[1032],undefined,'undoing restores the imported state');
});

test('the person chooses the completed state of each type; tasks already marked follow a new choice',async()=>{
  const {setCompletedState,completeTask}=await import('../server/planner.js');
  const ws=createDemo();delete ws.completedStates;
  assert.throws(()=>completeTask(ws,1031),/Indica primero/);
  assert.throws(()=>setCompletedState(ws,'Epic','Closed'),/tipo/);
  assert.throws(()=>setCompletedState(ws,'Task','  '),/estado/);
  setCompletedState(ws,'Task',' Done ');completeTask(ws,1031);completeTask(ws,1033);
  assert.equal(ws.drafts[1031].state,'Done');
  stageChanges(ws,1033,{state:'Active'});
  setCompletedState(ws,'Task','Closed');
  assert.equal(ws.drafts[1031].state,'Closed');assert.equal(ws.drafts[1033],undefined,'an undone task is not closed again');
  assert.throws(()=>completeTask(ws,1032),/«Bug»/);
  assert.throws(()=>completeTask(ws,1001),/tareas y bugs/);
});
test('a task that could not be read during the review is written only if Azure still has the imported revision',async t=>{
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});await f.stage(1045,{priority:1});
  const imported=f.workspace().items.find(i=>i.id===1042).rev;
  f.azure.getItems=async()=>{throw new Error('HTTP 503');};
  // Azure rejects the whole update when the revision differs, as the real API does.
  f.azure.update=async(_c,id,rev,changes)=>{
    f.calls.push({id,rev,changes});
    if(rev!==null && f.remote.get(id).rev!==rev) throw new Error('Error updating work item [HTTP 412 Precondition Failed]: TF401289: The current work item revision is different.');
    const updated={...f.remote.get(id),...changes,rev:f.remote.get(id).rev+1};f.remote.set(id,updated);return structuredClone(updated);
  };
  f.remote.set(1045,{...f.remote.get(1045),priority:3,rev:9});
  const review=await f.planner.prepareReview();
  assert.ok(review.plans.every(p=>p.unverified));assert.match(review.unreadable[0],/HTTP 503/);
  const result=await f.planner.sync(review.token);
  assert.deepEqual(result.successes,[1042],'an unchanged task is still written');
  assert.deepEqual(f.calls.find(c=>c.id===1042).rev,imported);
  assert.equal(result.failures[0].id,1045);assert.match(result.failures[0].error,/TF401289/);
  assert.equal(f.remote.get(1045).priority,3,'the change made in Azure is not overwritten');
  assert.deepEqual(f.workspace().drafts[1045],{priority:1},'the local change stays pending');
});

test('a task is duplicated as a new local item with its parent, owner, iteration, hours, priority and tags',async()=>{
  const {duplicateItem,effectiveItems,stageChanges}=await import('../server/planner.js');
  const ws=createDemo();
  stageChanges(ws,1042,{originalEstimate:14,priority:1});
  const original=effectiveItems(ws).find(i=>i.id===1042);
  const id=duplicateItem(ws,1042), copy=effectiveItems(ws).find(i=>i.id===id);
  assert.ok(id<0 && copy.localOnly);
  for (const field of ['title','type','parent','assignedTo','iterationPath','remainingWork','originalEstimate','priority','areaPath']) assert.deepEqual(copy[field],original[field],field);
  assert.deepEqual(copy.tags,original.tags);
  const orphan=ws.items.find(i=>i.id===1059);orphan.parent=null;
  const orphanCopy=duplicateItem(ws,1059);
  assert.equal(effectiveItems(ws).find(i=>i.id===orphanCopy).parent,null,'a task without parent is duplicated without one');
  assert.throws(()=>duplicateItem(ws,1001),/tareas y bugs/);
});
test('a duplicate is created in Azure with its estimate and tags',async()=>{
  const {AzureGateway}=await import('../server/azure.js');
  const gateway=new AzureGateway();let call;
  gateway.call=async(name,args)=>{call={name,args};return {id:77,rev:1,fields:{'System.Title':'Copia','System.WorkItemType':'Task'}};};
  await gateway.create({project:'P'},{title:'Copia',type:'Task',creationKey:'k',areaPath:'P',iterationPath:'P',priority:1,assignedTo:'',remainingWork:3,originalEstimate:8,tags:['Frontend'],parent:5});
  assert.equal(call.args.fields['Microsoft.VSTS.Scheduling.OriginalEstimate'],8);
  assert.equal(call.args.fields['System.Tags'],'neo-create-k; Frontend');
  assert.equal(call.args.parent,5);
});

test('comments are kept locally with their mentions and published once when synchronizing',async t=>{
  const {addComment,discardComment,planningWorkspace}=await import('../server/planner.js');
  const f=await fixture(t), posted=[];
  f.azure.addComment=async(config,id,text)=>{posted.push({project:config.project,id,text});};
  const data=structuredClone(f.store.data), ws=data.azure;
  assert.throws(()=>addComment(ws,1042,'   '),/comentario/);
  assert.throws(()=>addComment(ws,9999,'Hola'),/no pertenece/);
  addComment(ws,1042,'Revisa esto @<ana@example.test>');addComment(ws,1045,'Otro');
  assert.equal(planningWorkspace(ws).pendingChanges,2,'comments count as pending changes');
  discardComment(ws,ws.pendingComments[1].key);assert.throws(()=>discardComment(ws,'missing'),/ya no está pendiente/);
  await f.store.save(data);
  const review=await f.planner.prepareReview();
  assert.deepEqual(review.comments.map(c=>[c.id,c.text]),[[1042,'Revisa esto @<ana@example.test>']]);
  const result=await f.planner.sync(review.token);
  assert.deepEqual(result.comments,{successes:[1042],failures:[]});
  assert.deepEqual(posted,[{project:f.workspace().config.project,id:1042,text:'Revisa esto @<ana@example.test>'}]);
  assert.deepEqual(f.workspace().pendingComments,[]);
});
test('a comment that fails stays pending and is not repeated automatically',async t=>{
  const {addComment}=await import('../server/planner.js');
  const f=await fixture(t);let attempts=0;
  f.azure.addComment=async()=>{attempts++;throw new Error('timeout');};
  const data=structuredClone(f.store.data);addComment(data.azure,1042,'Hola');await f.store.save(data);
  const result=await f.planner.sync((await f.planner.prepareReview()).token);
  assert.equal(attempts,1);assert.equal(result.comments.failures[0].error,'timeout');
  assert.equal(f.workspace().pendingComments.length,1);
  const {AzureGateway}=await import('../server/azure.js');const gateway=new AzureGateway();let call;
  gateway.call=async(name,args)=>{call={name,args};return {};};
  await gateway.addComment({project:'P'},7,'Hola @<ana@example.test>');
  assert.deepEqual(call,{name:'wit_work_item_comment_write',args:{action:'add',project:'P',workItemId:7,text:'Hola @<ana@example.test>',format:'Markdown'}});
});
test('a comment on a task created in the same synchronization is published on the new item',async t=>{
  const {addComment,createLocalItem}=await import('../server/planner.js');
  const f=await fixture(t), posted=[];
  f.azure.findCreation=async()=>null;f.azure.create=async(config,item,validate)=>validate ? {} : {...item,id:5000,rev:1,localOnly:undefined};
  f.azure.addComment=async(config,id,text)=>{posted.push(id);};
  const data=structuredClone(f.store.data);const id=createLocalItem(data.azure,{type:'Task',title:'Nueva',parent:1001});addComment(data.azure,id,'Hola');await f.store.save(data);
  const result=await f.planner.sync((await f.planner.prepareReview()).token);
  assert.deepEqual(result.comments.failures,[]);assert.deepEqual(posted,[5000]);
});
test('a duplicate copies the description of its Azure original, also when copying a copy',async t=>{
  const {duplicateItem,effectiveItems}=await import('../server/planner.js');
  const {AzureGateway}=await import('../server/azure.js');
  const ws=createDemo();
  const copy=duplicateItem(ws,1042), copyOfCopy=duplicateItem(ws,copy);
  assert.equal(effectiveItems(ws).find(i=>i.id===copy).copyFrom,1042);
  assert.equal(effectiveItems(ws).find(i=>i.id===copyOfCopy).copyFrom,1042,'a copy of a copy reads the same original');
  const f=await fixture(t), sent=[];
  f.azure.findCreation=async()=>null;f.azure.itemTexts=async(_c,id)=>({'System.Description':`<p>Texto de #${id}</p>`});
  f.azure.create=async(config,item,validate)=>{sent.push({validate,texts:item.texts});return validate ? {} : {...item,id:5001,rev:1,localOnly:undefined};};
  const data=structuredClone(f.store.data);duplicateItem(data.azure,1042);await f.store.save(data);
  const result=await f.planner.sync((await f.planner.prepareReview()).token);
  assert.deepEqual(result.failures,[]);
  assert.ok(sent.length>=2 && sent.every(s=>s.texts['System.Description']==='<p>Texto de #1042</p>'),'validation and creation carry the copied description');
});
test('a creation that needs a description is offered in the review and sent with what the person writes',async t=>{
  const {createLocalItem,setDescription,requiredDescription}=await import('../server/planner.js');
  assert.equal(requiredDescription('TF401320: Rule Error for field Description. Error code: Required, InvalidEmpty.'),'System.Description');
  assert.equal(requiredDescription('TF401320: Rule Error for field Repro Steps. Error code: Required, InvalidEmpty.'),'Microsoft.VSTS.TCM.ReproSteps');
  assert.equal(requiredDescription('TF401320: Rule Error for field Activity. Error code: Required.'),null);
  const f=await fixture(t), created=[];
  f.azure.findCreation=async()=>null;
  f.azure.create=async(config,item,validate)=>{
    if(!item.description) throw new Error('TF401320: Rule Error for field Description. Error code: Required, InvalidEmpty.');
    if(!validate) created.push(item);
    return validate ? {} : {...item,id:5002,rev:1,localOnly:undefined};
  };
  const data=structuredClone(f.store.data);const id=createLocalItem(data.azure,{type:'Task',title:'Nueva',parent:1001});await f.store.save(data);
  let review=await f.planner.prepareReview();
  assert.deepEqual(review.plans.find(p=>p.id===id).needsDescription,{field:'System.Description',label:'Description'});
  const failed=await f.planner.sync(review.token);
  assert.match(failed.failures[0].error,/Description/);assert.ok(f.workspace().items.some(i=>i.id===id),'it stays pending');
  const next=structuredClone(f.store.data);setDescription(next.azure,id,'Qué <hay> que hacer\nY cómo');await f.store.save(next);
  review=await f.planner.prepareReview();
  assert.equal(review.plans.find(p=>p.id===id).needsDescription,undefined,'once written, Azure accepts it');
  const result=await f.planner.sync(review.token);
  assert.deepEqual(result.failures,[]);assert.equal(created[0].description,'Qué <hay> que hacer\nY cómo');
  assert.throws(()=>setDescription(f.workspace(),1042,'x'),/elemento nuevo/);
});
test('the gateway sends copied texts, and the written description as HTML in its field',async()=>{
  const {AzureGateway}=await import('../server/azure.js');
  const gateway=new AzureGateway();let call;
  gateway.call=async(name,args)=>{call={name,args};return {id:78,rev:1,fields:{'System.Title':'Bug','System.WorkItemType':'Bug'}};};
  const item={title:'Bug',type:'Bug',creationKey:'k',areaPath:'P',iterationPath:'P',priority:2,assignedTo:'',remainingWork:null,tags:[],parent:null};
  await gateway.create({project:'P'},{...item,texts:{'System.Description':'<p>Original</p>','Microsoft.VSTS.TCM.ReproSteps':'<p>Pasos</p>'}});
  assert.equal(call.args.fields['System.Description'],'<p>Original</p>');assert.equal(call.args.fields['Microsoft.VSTS.TCM.ReproSteps'],'<p>Pasos</p>');
  await gateway.create({project:'P'},{...item,texts:{'Microsoft.VSTS.TCM.ReproSteps':'<p>Pasos</p>'},description:'1. <Abrir>\n2. Fallo',descriptionField:'Microsoft.VSTS.TCM.ReproSteps'});
  assert.equal(call.args.fields['Microsoft.VSTS.TCM.ReproSteps'],'1. &lt;Abrir&gt;<br>2. Fallo');
});
test('deciding a conflict updates that task in the review, without reading Azure again',async t=>{
  const {reviewTaskChoice}=await import('../server/planner.js');
  const f=await fixture(t);await f.stage(1042,{remainingWork:18});await f.stage(1045,{priority:1});
  f.remote.set(1042,{...f.remote.get(1042),remainingWork:6,rev:2});
  let reads=0;const getItems=f.azure.getItems;f.azure.getItems=async(...args)=>{reads++;return getItems(...args);};
  const decide=async(id,choice)=>{
    const data=structuredClone(f.store.data);resolveConflict(data.azure,id,choice);await f.store.save(data);
    reviewTaskChoice(f.planner.review,f.workspace(),id);f.planner.review.version=f.store.data.version;
  };
  let review=await f.planner.prepareReview();assert.equal(reads,1);
  await decide(1042,'local');
  const plan=f.planner.review.plans.find(p=>p.id===1042);
  assert.deepEqual(plan.conflicts,[]);assert.deepEqual(plan.updates,{remainingWork:18});assert.equal(plan.remote.rev,2);
  assert.ok(f.planner.review.plans.some(p=>p.id===1045),'the other changes stay as reviewed');
  const result=await f.planner.sync(review.token);
  assert.equal(reads,1,'Azure is not read again');assert.deepEqual(result.successes.sort(),[1042,1045]);assert.equal(f.remote.get(1042).remainingWork,18);

  await f.stage(1045,{priority:3});f.remote.set(1045,{...f.remote.get(1045),priority:4,rev:f.remote.get(1045).rev+1});
  review=await f.planner.prepareReview();await decide(1045,'remote');
  assert.equal(f.planner.review.plans.some(p=>p.id===1045),false,'keeping Azure removes the change from the review');
  assert.equal(f.workspace().items.find(i=>i.id===1045).priority,4);
});
