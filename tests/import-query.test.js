import test from 'node:test';
import assert from 'node:assert/strict';
import {AzureGateway} from '../server/azure.js';
import {stateAction,importWiql} from '../server/import-query.js';
const config={organization:'org',project:'Project',team:'Team'};
function gatewayFor({unknown=false,page=false}={}) {
 const gateway=new AzureGateway(),calls=[],progress=[];gateway.open=async()=>{};
 gateway.call=async(name,args)=>{
  calls.push({name,args});
  if(name==='work' && args.action==='get_team_settings')return {backlogIteration:{path:''},areaPaths:[{value:'Project\\Team',includeChildren:true}],workingDays:[1,2,3,4,5]};
  if(name==='work' && args.action==='list_team_iterations')return [{id:'old',name:'Old',path:'Project\\Old',attributes:{timeFrame:'past'}},{id:'now',name:'Now',path:'Project\\Now',attributes:{timeFrame:'current'}}];
  if(name==='neo_team_members')return [{id:'ana',displayName:'Ana'}];
  if(name==='wit_backlog' && args.action==='list')return [{workItemTypes:[{name:'User Story'}]}];
  if(name==='neo_work_item_types')return [{name:'Task'},{name:'User Story'}];
  if(name==='neo_work_item_states')return [{name:'Active',category:'InProgress'},{name:'Closed',category:'Completed'},{name:'Discarded'},{name:'Delivered',category:'Removed'},...(unknown ? [{name:'Custom'}] : [])];
  if(name==='neo_query_work_items'){
   const task=args.wiql.includes("= 'Task'"),sample=args.top===1,parent=args.wiql.includes('[System.Id] IN'),second=args.wiql.includes('[System.Id] > 1');
   if(parent && task || !parent && !task || second && !page) return {workItems:[],limited:false};
   const id=parent ? 10 : second ? 2 : 1;
   return {workItems:[{id,rev:1,fields:{'System.Title':'Item '+id,'System.State':sample ? 'Custom' : 'Active','System.TeamProject':'Project','System.WorkItemType':task ? 'Task' : 'User Story','System.Parent':task ? 10 : null,'System.IterationPath':'Project\\Now','System.AreaPath':task ? 'Project\\Team' : 'Project\\Portfolio'}}],limited:page && !parent && !second};
  }
  if(name==='work' && args.action==='get_team_capacity')return {teamMembers:[]};
  if(name==='neo_team_days_off')return {daysOff:[]};
  throw new Error('Unexpected '+name);
 };
 return {gateway,calls,progress};
}
test('only open workflow states enter WIQL before batching, including children without downloading closed parents',async()=>{
 const {gateway,calls,progress}=gatewayFor();
 const ws=await gateway.import(config,p=>progress.push(p));
 assert.deepEqual(ws.items.map(i=>[i.id,i.contextOnly ?? false]),[[1,false],[10,true]]);
 assert.deepEqual(ws.iterations.map(i=>i.id),['now']);assert.deepEqual(Object.keys(ws.capacities),['now']);
 assert.equal(ws.settings.backlogIteration.path,'Project');assert.equal(ws.members[0].id,'ana');assert.deepEqual(ws.completedStates,{Task:'Closed','User Story':'Closed'});
 const queries=calls.filter(c=>c.name==='neo_query_work_items');
 assert.ok(queries.length);for(const {args} of queries){assert.match(args.wiql,/\[System.State\] IN \('Active'\)/);assert.doesNotMatch(args.wiql,/Closed|Discarded|Delivered/);assert.match(args.wiql,/NOT UNDER 'Project\\Old'/);assert.ok(args.fields.includes('System.Parent'));}
 assert.match(queries[0].args.wiql,/\[System.AreaPath\] UNDER 'Project\\Team'/);
 assert.doesNotMatch(queries.find(c=>c.args.wiql.includes('[System.Id] IN')).args.wiql,/AreaPath/);
 assert.ok(!calls.some(c=>c.name==='wit_work_item' || c.args.action==='list_work_items' || c.args.iterationId==='old'));
 assert.ok(calls.findIndex(c=>c.name==='neo_work_item_states')<calls.findIndex(c=>c.name==='neo_query_work_items'));
 assert.equal(progress.at(-1).counts.imported,2);
});
test('unknown state requests a sample decision before the import, stored exclusions prevent another prompt',async()=>{
 const {gateway,calls}=gatewayFor({unknown:true});
 await assert.rejects(()=>gateway.import(config),error=>{assert.equal(error.stateReview.state,'Custom');assert.equal(error.stateReview.item.fields['System.State'],'Custom');return true;});
 assert.deepEqual(calls.filter(c=>c.name==='neo_query_work_items').map(c=>c.args.top),[1]);
 calls.length=0;
 const rules=['Task','User Story'].map(type=>({...config,type,state:'Custom',action:'exclude'}));
 await gateway.import(config,()=>{},rules);
 assert.ok(calls.filter(c=>c.name==='neo_query_work_items').every(c=>!c.args.wiql.includes('Custom')));
});
test('pages beyond the query cap without silently truncating or fetching closed items',async()=>{
 const {gateway,calls}=gatewayFor({page:true});
 const ws=await gateway.import(config);
 assert.deepEqual(ws.items.map(i=>i.id),[1,2,10]);
 assert.ok(calls.some(c=>c.args.wiql?.includes('[System.Id] > 1')));
});
test('state rules respect custom categories, normalization, terminal fallbacks and project scope',()=>{
 assert.equal(stateAction(config,'Task',{name:'Closed',category:' In Progress '}),'include');
 for(const name of [' closed ','Done','Removed','Discarded']) assert.equal(stateAction(config,'Task',{name}),'exclude');
 assert.equal(stateAction(config,'Task',{name:'Delivered',stateCategory:'Completed'}),'exclude');
 assert.equal(stateAction(config,'Task',{name:'Resolved',category:'Resolved'}),'include');
 assert.equal(stateAction(config,'Task',{name:'Custom'}),null);
 assert.equal(stateAction(config,'Task',{name:'Custom'},[{...config,type:'Task',state:'CUSTOM',action:'exclude'}]),'exclude');
 assert.equal(stateAction(config,'Task',{name:'Custom'},[{...config,project:'Other',type:'Task',state:'Custom',action:'exclude'}]),null);
 const q=importWiql(config,{backlogIteration:{path:"Project's"},importIterationPaths:['Project\\Current']},['Project\\Past'],"Task's",["Won't"],5000);
 assert.match(q,/Task''s/);assert.match(q,/Won''t/);assert.match(q,/System.Id\] > 5000/);
});
