import test from 'node:test';
import assert from 'node:assert/strict';
import {AzureGateway} from '../server/azure.js';
import {refreshSection} from '../server/refresh.js';
import {createDemo} from '../server/demo.js';
import {mergeProjects} from '../server/multi-project.js';
function fixture(){const ws=createDemo();ws.mode='azure';ws.iterations=ws.iterations.filter(i=>!i.past);ws.backlogLevels=[];return ws;}
function gateway(ws){
 const azure=new AzureGateway(),calls=[];azure.open=async()=>{};
 azure.call=async(name,args)=>{calls.push([name,args]);
  if(name==='work' && args.action==='list_team_iterations')return ws.iterations.map(i=>({...i,name:i.name+' actualizada'}));
  if(name==='work' && args.action==='get_team_settings')return ws.settings;
  if(name==='work' && args.action==='get_team_capacity')return {teamMembers:ws.members.map(m=>({teamMember:m,activities:[{name:'Development',capacityPerDay:3}],daysOff:[]}))};
  if(name==='neo_team_days_off')return {daysOff:[]};
  if(name==='neo_work_item_types')return [{name:'Task'}];
  if(name==='neo_work_item_states')return [{name:'Active',category:'InProgress'},{name:'Closed',category:'Completed'}];
  if(name==='neo_query_work_items')return {workItems:[],limited:false};
  throw new Error('Unexpected request '+name+' '+args.action);
 };return {azure,calls};
}
test('iteration refresh reads only iteration metadata, preserving tasks, members and capacities',async()=>{
 const ws=fixture(),before=structuredClone(ws),{azure,calls}=gateway(ws);
 const next=await refreshSection(ws,'iterations',azure,[]);
 assert.ok(next.iterations[0].name.endsWith('actualizada'));
 for(const field of ['items','members','capacities','settings'])assert.deepEqual(next[field],ws[field]);
 assert.deepEqual(calls.map(([name,args])=>[name,args.action]),[['work','list_team_iterations']]);assert.deepEqual(ws,before);
});
test('capacity refresh reads only capacity and holidays and keeps pending task edits',async()=>{
 const ws=fixture();ws.drafts={[ws.items[0].id]:{title:'Local'}};
 const {azure,calls}=gateway(ws),next=await refreshSection(ws,'capacity',azure,[]);
 assert.equal(next.capacities[ws.iterations[0].id].teamMembers[0].activities[0].capacityPerDay,3);
 for(const field of ['items','drafts','iterations','members'])assert.deepEqual(next[field],ws[field]);
 assert.ok(calls.every(([name,args])=>name==='neo_team_days_off' || name==='work' && args.action==='get_team_capacity'));
});
test('task download asks with the team current sprints and areas but keeps the local calendar, members and capacities',async()=>{
 const ws=fixture();ws.capacityDrafts={[ws.iterations[0].id]:{ana:{activities:[{name:'',capacityPerDay:4}],daysOff:[]}}};
 const {azure,calls}=gateway(ws),next=await refreshSection(ws,'tasks',azure,[]);
 assert.deepEqual(next.items,[]);
 for(const field of ['capacities','capacityDrafts','iterations','members','settings'])assert.deepEqual(next[field],ws[field]);
 assert.ok(calls.every(([name])=>['work','neo_work_item_types','neo_work_item_states','neo_query_work_items'].includes(name)),'no members or capacities are read');
 assert.ok(!calls.some(([name,args])=>name==='work' && args.action==='get_team_capacity'));
});
test('the task download brings the latest finished iteration to decide its open tasks',async()=>{
 const ws=fixture(),{azure}=gateway(ws),finished={id:'sprint-23',name:'Sprint 23',path:'Neo Platform\\Sprint 23',attributes:{startDate:'2026-01-05T00:00:00Z',finishDate:'2026-01-16T00:00:00Z',timeFrame:0}};
 const base=azure.call;azure.call=async(name,args)=>name==='work' && args.action==='list_team_iterations' ? [finished,...ws.iterations] : base(name,args);
 const next=await refreshSection(ws,'tasks',azure,[]);
 assert.deepEqual(next.iterations.map(i=>[i.id,!!i.past]),[['sprint-23',true],...ws.iterations.map(i=>[i.id,false])]);
 assert.ok(!next.warnings.some(w=>/iteraciones nuevas/.test(w)));
});
test('a sprint added to the team after the import is included in the task download, with a notice',async()=>{
 const ws=fixture(),{azure,calls}=gateway(ws),added={id:'sprint-new',name:'Sprint nuevo',path:'Neo Platform\\Sprint nuevo',attributes:{timeFrame:2}};
 const base=azure.call;azure.call=async(name,args)=>name==='work' && args.action==='list_team_iterations' ? [...ws.iterations,added] : base(name,args);
 const next=await refreshSection(ws,'tasks',azure,[]);
 assert.ok(calls.filter(([name])=>name==='neo_query_work_items').every(([,args])=>args.wiql.includes("UNDER 'Neo Platform\\Sprint nuevo'")),'its tasks are requested');
 assert.deepEqual(next.iterations,ws.iterations,'the planning calendar is not changed');
 assert.ok(next.warnings.some(w=>w.includes('Sprint nuevo')));
});
test('downloading tasks keeps local changes on top; capacity drafts still block a capacity refresh',async()=>{
 const ws=fixture(),edited=ws.items.find(i=>!i.localOnly),untouched=ws.items.find(i=>i.id!==edited.id && !i.localOnly);
 ws.drafts={[edited.id]:{title:'Pending'}};ws.items.push({...edited,id:-1,localOnly:true,title:'Nuevo en local'});const {azure}=gateway(ws);
 const next=await refreshSection(ws,'tasks',azure,[]);
 assert.ok(next.items.some(i=>i.id===-1),'an item not created in Azure yet is kept');
 assert.deepEqual(next.drafts,{[edited.id]:{title:'Pending'}},'local changes survive the download');
 assert.ok(next.items.some(i=>i.id===edited.id),'an edited item Azure no longer lists stays to be reviewed');
 assert.ok(!next.items.some(i=>i.id===untouched.id),'an unedited item follows Azure');
 // A change Azure already has is no longer pending; other fields stay.
 const base=azure.call;
 azure.call=async(name,args)=>name==='neo_query_work_items' ? {workItems:[{id:edited.id,rev:5,fields:{'System.Title':'Pending','System.WorkItemType':'Task','System.State':'Active','System.IterationPath':edited.iterationPath}}],limited:false} : base(name,args);
 ws.drafts={[edited.id]:{title:'Pending',priority:1}};
 const synced=await refreshSection(ws,'tasks',azure,[]);
 assert.deepEqual(synced.drafts,{[edited.id]:{priority:1}});
 ws.drafts={};ws.capacityDrafts={any:{}};
 await assert.rejects(()=>refreshSection(ws,'capacity',azure,[]),/cambios de esta sección/);
 ws.capacityDrafts={};const before=structuredClone(ws);
 azure.capacity=async()=>{throw new Error('401');};await assert.rejects(()=>refreshSection(ws,'capacity',azure,[]),/401/);assert.deepEqual(ws,before);
 await assert.rejects(()=>refreshSection(ws,'unknown',azure,[]),/Sección no válida/);
});
function joint(){
 const a=fixture(),b=fixture();b.config={...a.config,project:'Other',team:'Other'};
 b.settings.backlogIteration.path='Other';b.items=[];
 b.iterations=b.iterations.map(i=>({...i,id:i.id+'b',path:'Other\\'+i.name}));
 b.capacities=Object.fromEntries(Object.entries(b.capacities).map(([id,value])=>[id+'b',value]));
 return mergeProjects(a,b);
}
test('joint capacity refresh combines Azure allocations without altering the plan',async()=>{
 const ws=joint(),before=structuredClone(ws),{azure}=gateway(ws);
 const next=await refreshSection(ws,'capacity',azure,[]);
 for(const field of ['items','iterations','members','drafts'])assert.deepEqual(next[field],ws[field]);
 assert.equal(next.capacities[ws.iterations[0].id].teamMembers[0].activities[0].capacityPerDay,6);
 assert.deepEqual(ws,before);
});
test('joint iteration refresh preserves the capacity budget and tasks while remapping dates',async()=>{
 const ws=joint();const azure={import:async(config,report,rules,{snapshot})=>({...snapshot,iterations:snapshot.iterations.map(i=>({...i,attributes:{...i.attributes,startDate:i.attributes.startDate.replace(/T.*/, 'T00:00:00Z')}}))})};
 const next=await refreshSection(ws,'iterations',azure,[]);
 assert.deepEqual(next.capacities,ws.capacities);assert.deepEqual(next.items,ws.items);assert.deepEqual(next.members,ws.members);
});
test('in a joint plan the task download brings each project\'s finished iteration, with its open tasks',async()=>{
 const ws=joint(),dates={startDate:'2026-01-05T00:00:00Z',finishDate:'2026-01-16T00:00:00Z',timeFrame:0};
 const finished=source=>({id:'done'+source.config.project,name:'Done',path:`${source.config.project}\\Done`,attributes:dates,past:true});
 const azure={import:async(config,report,rules,{snapshot})=>({...snapshot,iterations:[finished(snapshot),...snapshot.iterations],items:snapshot.config.project==='Other' ? [] : [{id:900,type:'Task',title:'Pendiente',state:'Active',iterationPath:finished(snapshot).path,assignedTo:'',tags:[],parent:null}],warnings:[]})};
 const next=await refreshSection(ws,'tasks',azure,[]);
 const done=next.iterations.find(i=>i.past);
 assert.equal(next.iterations[0],done);assert.equal(next.iterations.filter(i=>i.past).length,1);
 assert.deepEqual(Object.keys(done.sourceIterations).length,2);
 assert.equal(next.items.find(i=>i.id===900).iterationPath,done.path);
 assert.ok(!next.capacities[done.id]);
});
test('in a joint plan, a day off counts where the person has hours, so Azure\'s hours per day stay',async()=>{
 const ws=joint(),iteration=ws.iterations.find(i=>!i.past),ana=ws.members[0],[a,b]=ws.sources;
 const holiday=iteration.attributes.startDate.slice(0,10);
 const azure={open:async()=>{},capacity:async(config)=>config.project===a.config.project
  ? {daysOff:[{start:holiday+'T00:00:00Z',end:holiday+'T00:00:00Z'}],teamMembers:[{teamMember:ana,activities:[{name:'Development',capacityPerDay:5}],daysOff:[]}]}
  : {daysOff:[],teamMembers:[{teamMember:ana,activities:[],daysOff:[]}]}};
 const {downloadCapacity}=await import('../server/refresh.js');
 const next=await downloadCapacity(ws,iteration.id,azure);
 const entry=next.capacities[iteration.id].teamMembers.find(m=>m.teamMember.id===ana.id);
 assert.equal(entry.activities[0].capacityPerDay,5);
 assert.deepEqual(entry.daysOff,[{start:holiday,end:holiday}]);
});
test('with pending changes, refreshing iterations only adds the new ones, and refuses when an existing one changed',async()=>{
 const ws=fixture();ws.drafts={[ws.items[0].id]:{title:'Local'}};
 const added={id:'sprint-new',name:'Sprint nuevo',path:'Neo Platform\\Sprint nuevo',attributes:{startDate:'2099-01-05T00:00:00Z',finishDate:'2099-01-16T00:00:00Z',timeFrame:2}};
 const {azure,calls}=gateway(ws),base=azure.call;
 azure.call=async(name,args)=>name==='work' && args.action==='list_team_iterations' ? [...ws.iterations,added] : base(name,args);
 const next=await refreshSection(ws,'iterations',azure,[]);
 assert.deepEqual(next.iterations.map(i=>i.id),[...ws.iterations.map(i=>i.id),'sprint-new']);
 for(const field of ['items','drafts','capacities','members'])assert.deepEqual(next[field],ws[field]);
 assert.deepEqual(calls,[],'nothing but the iterations is read');
 azure.call=async(name,args)=>name==='work' && args.action==='list_team_iterations' ? [{...ws.iterations[0],attributes:{...ws.iterations[0].attributes,finishDate:'2099-12-31T00:00:00Z'}},...ws.iterations.slice(1)] : base(name,args);
 await assert.rejects(()=>refreshSection(ws,'iterations',azure,[]),/ha cambiado o ya no está/);
 azure.call=async(name,args)=>name==='work' && args.action==='list_team_iterations' ? ws.iterations.slice(1) : base(name,args);
 await assert.rejects(()=>refreshSection(ws,'iterations',azure,[]),/ha cambiado o ya no está/);
});
test('in a joint plan with pending changes, a new iteration joins the shared calendar',async()=>{
 const ws=joint();ws.drafts={[ws.items[0].id]:{title:'Local'}};
 const added=source=>({id:'new-'+source.config.project,name:'Nueva',path:`${source.config.project}\\Nueva`,attributes:{startDate:'2099-01-05T00:00:00Z',finishDate:'2099-01-16T00:00:00Z'}});
 const azure={import:async(config,report,rules,{snapshot})=>({...snapshot,iterations:[...snapshot.iterations,added(snapshot)]})};
 const next=await refreshSection(ws,'iterations',azure,[]);
 const shared=next.iterations.find(i=>i.id==='joint:2099-01-05/2099-01-16');
 assert.equal(Object.keys(shared.sourceIterations).length,2);
 for(const field of ['items','drafts','capacities'])assert.deepEqual(next[field],ws[field]);
});
