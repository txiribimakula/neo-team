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
 for(const field of ['items','members','capacities','settings','participants'])assert.deepEqual(next[field],ws[field]);
 assert.deepEqual(calls.map(([name,args])=>[name,args.action]),[['work','list_team_iterations']]);assert.deepEqual(ws,before);
});
test('capacity refresh reads only capacity and holidays and keeps pending task edits',async()=>{
 const ws=fixture();ws.drafts={[ws.items[0].id]:{title:'Local'}};
 const {azure,calls}=gateway(ws),next=await refreshSection(ws,'capacity',azure,[]);
 assert.equal(next.capacities[ws.iterations[0].id].teamMembers[0].activities[0].capacityPerDay,3);
 for(const field of ['items','drafts','iterations','members','participants'])assert.deepEqual(next[field],ws[field]);
 assert.ok(calls.every(([name,args])=>name==='neo_team_days_off' || name==='work' && args.action==='get_team_capacity'));
});
test('task refresh does not request iterations, settings, members or capacities; capacity drafts survive',async()=>{
 const ws=fixture();ws.capacityDrafts={[ws.iterations[0].id]:{ana:{activities:[{name:'',capacityPerDay:4}],daysOff:[]}}};
 const {azure,calls}=gateway(ws),next=await refreshSection(ws,'tasks',azure,[]);
 assert.deepEqual(next.items,[]);
 for(const field of ['capacities','capacityDrafts','iterations','members','settings','participants'])assert.deepEqual(next[field],ws[field]);
 assert.ok(calls.every(([name])=>['neo_work_item_types','neo_work_item_states','neo_query_work_items'].includes(name)));
});
test('only drafts affected by the refresh block it; failure leaves the workspace intact',async()=>{
 const ws=fixture();ws.drafts={[ws.items[0].id]:{title:'Pending'}};const {azure}=gateway(ws);
 await assert.rejects(()=>refreshSection(ws,'tasks',azure,[]),/cambios de esta sección/);
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
