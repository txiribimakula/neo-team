import test from 'node:test';
import assert from 'node:assert/strict';
import { AzureGateway, parseToolResult } from '../server/azure.js';

test('parses official untrusted-content envelopes and rejects errors/non-JSON',()=>{
  const nonce='a'.repeat(32);
  assert.deepEqual(parseToolResult({content:[{type:'text',text:`<<${nonce}>> [UNTRUSTED CONTENT] <<${nonce}>>\n{"id":4}\n<</${nonce}>>`}]}),{id:4});
  assert.throws(()=>parseToolResult({isError:true,content:[{type:'text',text:'Permission denied'}]}),/Permission denied/);
  assert.throws(()=>parseToolResult({content:[{type:'text',text:'not JSON'}]}));
});
test('update emits a numeric atomic revision test before the field patches',async()=>{
  const gateway=new AzureGateway();let call;
  gateway.call=async(name,args)=>{call={name,args};return {id:42,rev:8,fields:{'System.Title':'Task','System.IterationPath':'Project\\Sprint','System.AssignedTo':{uniqueName:'ana@example.test'}}};};
  await gateway.update({project:'Project'},42,7,{assignedTo:'ana@example.test',iterationPath:'Project\\Sprint',remainingWork:0});
  assert.equal(call.name,'wit_work_item_write');
  assert.deepEqual(call.args.updates[0],{op:'test',path:'/rev',value:7});
  assert.deepEqual(call.args.updates.at(-1),{op:'add',path:'/fields/Microsoft.VSTS.Scheduling.RemainingWork',value:0});
});
test('import uses MCP for complete members, hierarchy, capacities and team scope',async()=>{
  const gateway=new AzureGateway(),calls=[];gateway.open=async()=>{};
  gateway.call=async(name,args)=>{
    calls.push({name,args});
    if(name==='work'&&args.action==='get_team_settings')return {backlogIteration:{path:'Project'},areaPaths:[{value:'Project\\Team',includeChildren:true}],workingDays:[1,2,3,4,5]};
    if(name==='work'&&args.action==='list_team_iterations')return [{id:'s1',path:'Project\\Sprint',name:'Sprint'}];
    if(name==='work'&&args.action==='get_team_capacity')return {teamMembers:[]};
    if(name==='neo_team_days_off')return {daysOff:[]};
    if(name==='neo_team_members')return [{id:'member',displayName:'Member without work',uniqueName:'member@example.test'}];
    if(name==='wit_backlog'&&args.action==='list')return [{id:'stories'}];
    if(name==='wit_backlog'&&args.action==='list_work_items')return {workItems:[{target:{id:1}}]};
    if(name==='wit_work_item'&&args.action==='list_for_iteration')return {workItemRelations:[{target:{id:2}}]};
    if(name==='wit_work_item'&&args.action==='get'&&args.id===5)throw new Error('Parent not accessible');
    if(name==='wit_work_item'&&args.action==='get')return {id:args.id,rev:1,fields:{'System.Title':`Task ${args.id}`,'System.TeamProject':'Project','System.AreaPath':args.id===3?'Project\\Other':'Project\\Team','System.IterationPath':'Project','System.WorkItemType':args.id===4?'User Story':'Task',...(args.id===1?{'System.Parent':4}:args.id===4?{'System.Parent':5}:{})},relations:args.id===1?[{rel:'System.LinkTypes.Hierarchy-Forward',url:'https://dev.azure.com/org/_apis/wit/workItems/2'},{rel:'System.LinkTypes.Hierarchy-Forward',url:'https://dev.azure.com/org/_apis/wit/workItems/3'}]:[]};
    throw new Error(`Unexpected tool ${name}`);
  };
  const result=await gateway.import({organization:'org',project:'Project',team:'Team'});
  assert.deepEqual(result.items.map(i=>i.id),[1,2,4]);
  assert.equal(result.items.find(i=>i.id===4).contextOnly,true);
  assert.ok(result.warnings.some(w=>w.includes('#5')));assert.equal(result.members[0].displayName,'Member without work');
  assert.equal(calls.filter(c=>c.name==='wit_work_item'&&c.args.id===2).length,1);
  assert.ok(calls.some(c=>c.name==='neo_team_days_off'));assert.deepEqual(result.drafts,{});
});
test('real bundled MCP initializes and advertises the required schemas without authentication',async t=>{
  const gateway=new AzureGateway();t.after(()=>gateway.close());
  await gateway.open({organization:'example',authentication:'interactive'});
  const {tools}=await gateway.client.listTools();
  for(const name of ['neo_team_members','neo_team_days_off','wit_backlog','work'])assert.ok(tools.some(tool=>tool.name===name));
  const write=tools.find(tool=>tool.name==='wit_work_item_write');
  const schema=JSON.stringify(write.inputSchema);assert.match(schema,/test/);assert.match(schema,/number/);assert.match(schema,/updates/);
});
