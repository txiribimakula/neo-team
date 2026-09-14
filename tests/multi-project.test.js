import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeProjects,sourceFor,remoteFields,planningItem} from '../server/multi-project.js';
import {Planner,projectCapacityPlans,stageCapacity,stageChanges,planningWorkspace,createLocalItem} from '../server/planner.js';
const member={id:'ana',displayName:'Ana',uniqueName:'ana@example.test'};
function project(name,id,hours=0) {
  return {mode:'azure',config:{organization:'org',project:name,team:name+' team'},settings:{backlogIteration:{path:name},workingDays:[1,2,3,4,5]},members:[member],iterations:[{id:'iteration-'+name,name:'Sprint '+name,path:name+'\\Sprint',attributes:{startDate:'2026-09-14T00:00:00Z',finishDate:'2026-09-18T00:00:00Z'}}],capacities:{['iteration-'+name]:{daysOff:[],teamMembers:[{teamMember:member,activities:[{name:'Development',capacityPerDay:8}],daysOff:[]}]}},items:[{id,rev:1,type:'Task',title:'Task '+name,state:'Active',assignedTo:member.uniqueName,iterationPath:hours ? name+'\\Sprint' : name,remainingWork:hours,canEstimateHours:true,areaPath:name}],drafts:{},conflicts:{},warnings:[],completedStates:{Task:'Closed'},participants:{}};
}
function storeFor(workspace){return {data:{mode:'azure',azure:workspace,version:0},async save(data){this.data={...data,version:this.data.version+1};}};}
test('projects share a calendar and a single member budget, while paths stay routable',()=>{
 const ws=mergeProjects(project('A',1,30),project('B',2,10));
 assert.equal(ws.sources.length,2);assert.equal(ws.members.length,1);assert.equal(ws.iterations.length,1);
 assert.equal(planningWorkspace(ws).capacityHours[ws.iterations[0].id].ana,40);
 assert.equal(ws.items[0].iterationPath,ws.items[1].iterationPath);
 assert.equal(sourceFor(ws,ws.items[1]).config.project,'B');
 assert.equal(remoteFields(ws,ws.items[1],{iterationPath:ws.iterations[0].path}).iterationPath,'B\\Sprint');
 assert.equal(remoteFields(ws,ws.items[0],{iterationPath:ws.settings.backlogIteration.path}).iterationPath,'A');
 const plans=projectCapacityPlans(ws);
 assert.deepEqual(plans.map(p=>[p.config.project,p.allocated,p.entry.activities[0].capacityPerDay]),[['A',30,6],['B',10,2]]);
 stageCapacity(ws,ws.iterations[0].id,{key:'ana',activities:[{name:'Development',capacityPerDay:6}]});
 assert.deepEqual(projectCapacityPlans(ws).map(p=>p.allocated),[22.5,7.5]);
});
test('refresh retains the global budget, project origins and locally defined participation',()=>{
 let ws=mergeProjects(project('A',1,30),project('B',2,10));
 ws.capacities[ws.iterations[0].id].teamMembers[0].activities[0].capacityPerDay=7;
 ws.participants={1:['ana@example.test']};
 ws=mergeProjects(ws,project('A',1,20));
 assert.deepEqual(ws.items.map(i=>i.id).sort(),[1,2]);assert.equal(ws.members.length,1);
 assert.equal(planningWorkspace(ws).capacityHours[ws.iterations[0].id].ana,35);
 assert.deepEqual(ws.participants,{1:['ana@example.test']});
 assert.equal(ws.sources.find(s=>s.config.project==='A').capacities['iteration-A'].teamMembers[0].activities[0].capacityPerDay,8);
});
test('prevents ID collisions across organizations, ambiguous team capacity and incompatible calendars',()=>{
 const a=project('A',1), b=project('B',2);
 b.config.organization='other';assert.throws(()=>mergeProjects(a,b),/misma organización/);
 b.config.organization='org';b.iterations[0].attributes.finishDate='2026-09-19T00:00:00Z';assert.throws(()=>mergeProjects(a,b),{message:'Los proyectos tienen iteraciones solapadas con fechas distintas. Alinea sus fechas para compartir una única capacidad: «A» · Sprint A (2026-09-14 → 2026-09-18) se solapa con «B» · Sprint B (2026-09-14 → 2026-09-19).'});
 const twice=project('B',2);twice.iterations.push({...twice.iterations[0],id:'iteration-B2',name:'Sprint B bis',path:'B\\Sprint bis'});assert.throws(()=>mergeProjects(a,twice),{message:'«B» tiene dos iteraciones con las mismas fechas (2026-09-14 → 2026-09-18): «Sprint B» y «Sprint B bis». Corrige el calendario del equipo antes de unirlo.'});
 const other=project('A',2);other.config.team='another';assert.throws(()=>mergeProjects(a,other),/otro equipo/);
});
test('unassigned tasks release their project allocation and unknown estimates are reviewed without blocking',async()=>{
 const ws=mergeProjects(project('A',1,30),project('B',2,10));
 stageChanges(ws,2,{assignedTo:''});
 assert.deepEqual(projectCapacityPlans(ws).map(p=>p.allocated),[40,0]);
 stageChanges(ws,1,{assignedTo:''});assert.deepEqual(projectCapacityPlans(ws).map(p=>p.allocated),[0,0]);
 ws.items[0].remainingWork=null;stageChanges(ws,1,{assignedTo:member.uniqueName});
 const store=storeFor(ws), planner=new Planner(store,{open:async()=>{},getItems:async(c,ids)=>ids.map(id=>({...ws.items.find(i=>i.id===id),iterationPath:c.project+'\\Sprint'})),capacity:async(c,id)=>structuredClone(project(c.project,1).capacities[id])});
 const review=await planner.prepareReview();
 assert.deepEqual(review.incompleteAllocations.map(p=>[p.iteration,p.missingEstimate]),[['A · Sprint A',true],['B · Sprint B',true]]);
 assert.ok(Array.isArray(review.capacityPlans));
});
test('review and synchronization route tasks and capacities to each project; repeat review has no pending writes',async()=>{
 const ws=mergeProjects(project('A',1,30),project('B',2,10)), store=storeFor(ws), calls=[];
 const remotes={A:project('A',1,30),B:project('B',2,10)};
 const azure={open:async()=>{},getItems:async(c,ids)=>structuredClone(remotes[c.project].items.filter(i=>ids.includes(i.id))),capacity:async(c,id)=>structuredClone(remotes[c.project].capacities[id]),update:async(c,id,rev,fields)=>{calls.push(['task',c.project,id,fields]);const item=remotes[c.project].items.find(i=>i.id===id);Object.assign(item,fields,{rev:rev+1});return structuredClone(item);},updateMemberCapacity:async(c,id,key,activities,daysOff)=>{calls.push(['capacity',c.project,id,key]);const entry={activities,daysOff};Object.assign(remotes[c.project].capacities[id].teamMembers[0],entry);return entry;}};
 stageChanges(ws,1,{title:'A changed'});stageChanges(ws,2,{title:'B changed'});
 const planner=new Planner(store,azure), review=await planner.prepareReview();
 assert.equal(review.capacityPlans.length,2);assert.ok(review.token);
 const result=await planner.sync(review.token);assert.deepEqual(result.failures,[]);assert.deepEqual(result.capacity.failures,[]);
 assert.deepEqual(calls.map(c=>c.slice(0,2)),[['task','A'],['task','B'],['capacity','A'],['capacity','B']]);
 assert.equal(store.data.azure.items[1].project,'B');assert.equal(store.data.azure.items[1].iterationPath,ws.iterations[0].path);
 assert.deepEqual(projectCapacityPlans(store.data.azure).map(p=>p.original.activities),projectCapacityPlans(store.data.azure).map(p=>p.entry.activities));
 await assert.rejects(()=>planner.prepareReview(),/No hay cambios/);
});
test('a failed task write prevents publishing a capacity split based on unapplied tasks',async()=>{
 const ws=mergeProjects(project('A',1,30),project('B',2,10)),store=storeFor(ws);let capacityWrites=0;
 stageChanges(ws,2,{remainingWork:20});
 const planner=new Planner(store,{open:async()=>{},getItems:async(c,ids)=>ids.map(id=>({...ws.items.find(i=>i.id===id),iterationPath:c.project+'\\Sprint'})),capacity:async(c,id)=>project(c.project,1).capacities[id],update:async()=>{throw new Error('Denied');},updateMemberCapacity:async()=>{capacityWrites++;}});
 const review=await planner.prepareReview(),result=await planner.sync(review.token);
 assert.equal(result.failures.length,1);assert.equal(capacityWrites,0);assert.equal(result.capacity.failures.length,1);
});
test('creation requires a project, inherits parent origin and validates membership and calendar',()=>{
 const a=project('A',1), b=project('B',2);b.members=[];const ws=mergeProjects(a,b);
 assert.throws(()=>createLocalItem(ws,{type:'Epic',title:'New'}),/Elige el proyecto/);
 const id=createLocalItem(ws,{type:'Epic',title:'New',sourceId:ws.sources[1].id});
 assert.equal(sourceFor(ws,ws.items.find(i=>i.id===id)).config.project,'B');
 assert.throws(()=>stageChanges(ws,2,{assignedTo:member.uniqueName}),/pertenecer al equipo/);
 const remote=planningItem(ws,{id:99,iterationPath:'B\\NotImported'},ws.sources[1]);assert.equal(remote.iterationPath,'B\\NotImported');
});
test('remote changes to untouched tasks or project holidays cannot produce a stale allocation',async()=>{
 const ws=mergeProjects(project('A',1,30),project('B',2,10)),store=storeFor(ws);
 let taskChanged=true,daysChanged=false;
 const azure={open:async()=>{},getItems:async(c,ids)=>ids.map(id=>({...project(c.project,id,10).items[0],rev:taskChanged ? 2 : 1})),capacity:async(c,id)=>({...project(c.project,1).capacities[id],daysOff:daysChanged ? [{start:'2026-09-14',end:'2026-09-14'}] : []})};
 const planner=new Planner(store,azure);
 await assert.rejects(()=>planner.prepareReview(),/tareas que han cambiado/);
 taskChanged=false;daysChanged=true;await assert.rejects(()=>planner.prepareReview(),/días libres/);
 daysChanged=false;const review=await planner.prepareReview();taskChanged=true;
 await assert.rejects(()=>planner.sync(review.token),/ha cambiado desde la revisión/);
});
test('personal and global holidays overlap safely and source working days preserve the total budget',()=>{
 const a=project('A',1,30), b=project('B',2,10);b.settings.workingDays=[1,2,3,4];
 const ws=mergeProjects(a,b),iteration=ws.iterations[0];
 stageCapacity(ws,iteration.id,{key:'team',daysOff:[{start:'2026-09-14',end:'2026-09-14'}]});
 stageCapacity(ws,iteration.id,{key:'ana',daysOff:[{start:'2026-09-14',end:'2026-09-14'}]});
 const plans=projectCapacityPlans(ws);
 assert.deepEqual(plans.map(p=>p.entry.daysOff.length),[1,1]);
 assert.ok(Math.abs(plans.reduce((n,p)=>n+p.allocated,0)-32)<0.03);
});
test('completed state names remain scoped to their project',async()=>{
 const {completeTask,setCompletedState}=await import('../server/planner.js');
 const a=project('A',1,30),b=project('B',2,10);b.completedStates={Task:'Delivered'};
 const ws=mergeProjects(a,b);
 completeTask(ws,1);completeTask(ws,2);
 assert.equal(ws.drafts[1].state,'Closed');assert.equal(ws.drafts[2].state,'Delivered');
 setCompletedState(ws,'Task','Finished',ws.sources[1].id);
 assert.equal(ws.drafts[1].state,'Closed');assert.equal(ws.drafts[2].state,'Finished');
});
test('zero global capacity clears project allocations and ignores assigned work',()=>{
 const ws=mergeProjects(project('A',1,30),project('B',2,10)),iteration=ws.iterations[0];
 stageCapacity(ws,iteration.id,{key:'ana',activities:[{name:'Development',capacityPerDay:0}]});
 const plans=projectCapacityPlans(ws);
 assert.deepEqual(plans.map(plan=>[plan.hours,plan.ratio,plan.allocated]),[[0,0,0],[0,0,0]]);
 assert.ok(plans.every(plan=>plan.entry.activities[0].capacityPerDay===0 && !plan.missingEstimate && !plan.unavailable));
});
test('an item moved between projects stays only where Azure has it now, and real duplicates are named',()=>{
 const moved=mergeProjects(project('A',1),project('B',1));
 assert.deepEqual(moved.items.map(i=>[i.id,i.project,i.title]),[[1,'B','Task B']]);
 const twice=project('B',2);twice.items.push({...twice.items[0]});
 assert.throws(()=>mergeProjects(project('A',1),twice),{message:'Hay elementos duplicados entre los proyectos importados: #2 «Task B» (B y B).'});
});
