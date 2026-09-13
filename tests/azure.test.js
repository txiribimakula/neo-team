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
  await gateway.update({project:'Project'},42,8,{state:'Closed'});
  assert.deepEqual(call.args.updates,[{op:'test',path:'/rev',value:8},{op:'add',path:'/fields/System.State',value:'Closed'}]);
});
test('maintenance reads the open items of the project in a single MCP call, without team areas',async()=>{
  const gateway=new AzureGateway(),calls=[],progress=[];
  const settings={type:'Functional Issue',states:[{name:'New',category:'proposed'},{name:'Active',category:'inprogress'},{name:'Closed',category:'completed'}],closedStates:['Closed']};
  gateway.call=async(name,args)=>{
    calls.push({name,args});
    return {ids:[9,4],limited:true,workItems:[{id:4,fields:{'System.Title':'Second','System.State':'New'}},{id:9,fields:{'System.Title':'First','System.State':'Active','System.AssignedTo':{displayName:'Ana García'}}}]};
  };
  const result=await gateway.functionalIssues({organization:'org',project:'Project'},settings,p=>progress.push(p));
  assert.deepEqual(calls.map(c=>c.name),['neo_query_work_items']);
  assert.match(calls[0].args.wiql,/NOT IN \('Closed'\)/);assert.doesNotMatch(calls[0].args.wiql,/AreaPath/);
  assert.equal(calls[0].args.top,1000);assert.ok(calls[0].args.fields.includes('System.State'));
  assert.deepEqual(result.issues.map(i=>[i.id,i.category,i.assignedTo]),[[9,'inprogress','Ana García'],[4,'proposed','']],'the query order is kept');
  assert.deepEqual([result.limited,result.closedStates,result.project],[true,['Closed'],'Project']);
  assert.deepEqual(progress.at(-1).counts,{issuesFound:2,issuesRead:2});
  gateway.call=async()=>({});
  await assert.rejects(()=>gateway.functionalIssues({project:'Project'},settings),/lista válida/);
});
test('work item states are read on demand with normalized custom categories',async()=>{
  const gateway=new AzureGateway();
  gateway.call=async(name,args)=>{assert.deepEqual([name,args],['neo_work_item_states',{project:'Project',type:'Task'}]);return [{name:'Active',category:'InProgress'},{name:'Entregado',stateCategory:' Completed '}];};
  assert.deepEqual(await gateway.workItemStates({project:'Project'},'Task'),[{name:'Active',category:'inprogress'},{name:'Entregado',category:'completed'}]);
  gateway.call=async()=>({});
  await assert.rejects(()=>gateway.workItemStates({project:'Project'},'Task'),/estados/);
});

test('real bundled MCP initializes and advertises the required schemas without authentication',async t=>{
  const gateway=new AzureGateway();t.after(()=>gateway.close());
  await gateway.open({organization:'example',authentication:'interactive'});
  const {tools}=await gateway.client.listTools();
  for(const name of ['neo_team_members','neo_team_days_off','neo_work_item_states','neo_security_read','neo_security_login','neo_query_work_items','wit_backlog','work'])assert.ok(tools.some(tool=>tool.name===name));
  const write=tools.find(tool=>tool.name==='wit_work_item_write');
  const schema=JSON.stringify(write.inputSchema);assert.match(schema,/test/);assert.match(schema,/number/);assert.match(schema,/updates/);
});
test('each MCP call reports what it waits for, how long it took and why it failed',async()=>{
  const gateway=new AzureGateway(),events=[];gateway.onActivity=event=>events.push(event);
  gateway.client={callTool:async({name})=>name==='neo_denied' ? {isError:true,content:[{type:'text',text:'Denied'}]} : {content:[{type:'text',text:'{"ok":true}'}]}};
  assert.deepEqual(await gateway.call('wit_work_item',{action:'get',id:7}),{ok:true});
  assert.equal(events[0].kind,'call');assert.match(events[0].message,/Esperando respuesta: elementos de trabajo \(wit_work_item · get · #7\)/);
  assert.match(events[0].pending.label,/#7/);
  assert.equal(events[1].pending,null);assert.match(events[1].message,/respondió en \d+,\d s/);
  await assert.rejects(()=>gateway.call('neo_denied',{}),/Denied/);
  assert.equal(events.at(-1).kind,'error');assert.match(events.at(-1).message,/falló tras .*Denied/);assert.equal(gateway.pendingCall,null);
});
test('closing the gateway also closes a client that is still connecting',async()=>{
  const gateway=new AzureGateway();
  let closed=0;
  gateway.openingClient={close:async()=>{closed++;}};
  await gateway.close();
  assert.equal(closed,1);assert.equal(gateway.openingClient,null);assert.equal(gateway.client,null);
});

function backlogGateway({backlog = {id:'root',name:'Iteration',path:''}, iterations = [], members = [], levels = []} = {}) {
  const gateway = new AzureGateway();
  gateway.open = async () => {};
  gateway.call = async (name, args) => {
    if (name === 'work' && args.action === 'get_team_settings') return {backlogIteration:backlog, defaultIteration:{id:'s1',path:'\\Release\\Sprint'}, workingDays:[1,2,3,4,5]};
    if (name === 'work' && args.action === 'list_team_iterations') return iterations;
    if (name === 'neo_team_members') return members;
    if (name === 'neo_work_item_types') return [];
    if (name === 'wit_backlog' && args.action === 'list') return levels;
    if (name === 'wit_work_item' && args.action === 'list_for_iteration') return {workItemRelations:[]};
    if (name === 'work' && args.action === 'get_team_capacity') return {teamMembers:[]};
    if (name === 'neo_team_days_off') return {daysOff:[]};
    throw new Error(`Unexpected tool ${name}: ${args.action}`);
  };
  return gateway;
}
test('import accepts the documented empty root backlog path and qualifies relative iteration paths',async()=>{
  const config = {organization:'org',project:'Project',team:'Team'};
  const gateway = backlogGateway({iterations:[{id:'s1',name:'Sprint',path:'\\Release\\Sprint'}]});
  const result = await gateway.import(config);
  assert.equal(result.settings.backlogIteration.path,'Project');
  assert.equal(result.settings.backlogIteration.id,'root');
  assert.equal(result.settings.defaultIteration.path,'Project\\Release\\Sprint');
  assert.equal(result.iterations[0].path,'Project\\Release\\Sprint');
  assert.deepEqual(result.items,[]);
  for (const [path, expected] of [['\\Release','Project\\Release'],['Project\\Release','Project\\Release'],['Project','Project']]) {
    const imported = await backlogGateway({backlog:{id:'backlog',path}}).import(config);
    assert.equal(imported.settings.backlogIteration.path,expected);
  }
});
test('import distinguishes a missing backlog from malformed iterations, members and backlog levels',async()=>{
  const config = {organization:'org',project:'Project',team:'Team'};
  for (const backlog of [null, {}, {path:null}, {path:42}]) {
    await assert.rejects(()=>backlogGateway({backlog}).import(config),/ruta válida para el backlog/);
  }
  for (const [field, message] of [['iterations',/lista válida de iteraciones/],['members',/lista válida de integrantes/],['levels',/lista válida de niveles de backlog/]]) {
    await assert.rejects(()=>backlogGateway({[field]:{value:[]}}).import(config),message);
  }
});
test('creation MCP includes a recovery marker and parent, validates first and rejects ambiguous recovery matches',async()=>{
  const gateway=new AzureGateway(),calls=[];
  gateway.call=async(name,args)=>{calls.push({name,args});return name==='wit_query' ? {workItems:[{id:1},{id:2}]} : {id:123,rev:1,fields:{'System.Title':'New','System.WorkItemType':'Task','System.Parent':1001}};};
  const item={title:'New',type:'Task',parent:1001,areaPath:'Project',iterationPath:'Project',priority:2,remainingWork:0,creationKey:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'};
  await gateway.create({project:'Project'},item,true);
  const result=await gateway.create({project:'Project'},item,false);
  assert.equal(result.parent,1001);assert.equal(calls[0].args.validateOnly,true);assert.equal(calls[1].args.validateOnly,false);
  assert.equal(calls[1].name,'neo_create_item');assert.equal(calls[1].args.fields['Microsoft.VSTS.Scheduling.RemainingWork'],0);
  assert.equal(calls[1].args.fields['System.Tags'],'neo-create-'+item.creationKey);
  await assert.rejects(()=>gateway.findCreation({project:'Project'},item.creationKey),/varios/);
});




test('MCP preserves source-denial classification for partial security reports',async()=>{
  const gateway=new AzureGateway();
  gateway.client={callTool:async()=>({content:[{type:'text',text:JSON.stringify({securityError:{code:'AZURE_SECURITY_SOURCE_DENIED',message:'Azure HTTP 401 en distributedtask/environments',diagnostics:{documentedScope:'vso.environment_manage'}}})}]})};
  await assert.rejects(gateway.call('neo_security_read',{action:'resources',kind:'environments'}),error=>{
    assert.equal(error.code,'AZURE_SECURITY_SOURCE_DENIED');
    assert.match(error.message,/environments/);
    assert.equal(error.diagnostics.documentedScope,'vso.environment_manage');return true;
  });
  assert.equal(gateway.pendingCall,null);
});
