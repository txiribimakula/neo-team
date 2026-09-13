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
  const gateway=new AzureGateway(),calls=[],progress=[];gateway.open=async()=>{};
  gateway.call=async(name,args)=>{
    calls.push({name,args});
    if(name==='work'&&args.action==='get_team_settings')return {backlogIteration:{path:'Project'},areaPaths:[{value:'Project\\Team',includeChildren:true}],workingDays:[1,2,3,4,5]};
    if(name==='work'&&args.action==='list_team_iterations')return [{id:'s1',path:'Project\\Sprint',name:'Sprint'}];
    if(name==='work'&&args.action==='get_team_capacity')return {teamMembers:[]};
    if(name==='neo_team_days_off')return {daysOff:[]};
    if(name==='neo_work_item_states')return [{name:'Active',category:'InProgress'}];
    if(name==='neo_team_members')return [{id:'member',displayName:'Member without work',uniqueName:'member@example.test'}];
    if(name==='wit_backlog'&&args.action==='list')return [{id:'stories'}];
    if(name==='wit_backlog'&&args.action==='list_work_items')return {workItems:[{target:{id:1}}]};
    if(name==='wit_work_item'&&args.action==='list_for_iteration')return {workItemRelations:[{target:{id:2}}]};
    if(name==='wit_work_item'&&args.action==='get'&&args.id===5)throw new Error('Parent not accessible');
    if(name==='wit_work_item'&&args.action==='get')return {id:args.id,rev:1,fields:{'System.Title':`Task ${args.id}`,'System.State':'Active','System.TeamProject':'Project','System.AreaPath':args.id===3?'Project\\Other':'Project\\Team','System.IterationPath':'Project','System.WorkItemType':args.id===4?'User Story':'Task',...(args.id===1?{'System.Parent':4}:args.id===4?{'System.Parent':5}:{})},relations:args.id===1?[{rel:'System.LinkTypes.Hierarchy-Forward',url:'https://dev.azure.com/org/_apis/wit/workItems/2'},{rel:'System.LinkTypes.Hierarchy-Forward',url:'https://dev.azure.com/org/_apis/wit/workItems/3'}]:[]};
    throw new Error(`Unexpected tool ${name}`);
  };
  const result=await gateway.import({organization:'org',project:'Project',team:'Team'}, update=>progress.push(update));
  assert.deepEqual(result.items.map(i=>i.id),[1,2,4]);
  assert.equal(result.items.find(i=>i.id===4).contextOnly,true);
  assert.ok(result.warnings.some(w=>w.includes('#5')));assert.equal(result.members[0].displayName,'Member without work');
  assert.equal(calls.filter(c=>c.name==='wit_work_item'&&c.args.id===2).length,1);
  assert.ok(calls.some(c=>c.name==='neo_team_days_off'));assert.deepEqual(result.drafts,{});
  assert.deepEqual([...new Set(progress.map(p=>p.phase))],['connection','settings','iterations','members','backlogs','capacity','items','parents','saving']);
  assert.deepEqual(progress[0].counts,{},'earlier progress snapshots must not change');
  assert.ok(progress.some(p=>p.phase==='items' && p.counts.discovered===3),'new child discoveries update the total');
  assert.deepEqual(progress.at(-1).counts,{settings:1,iterations:1,iterationsExcluded:0,members:1,backlogs:1,backlogTotal:1,discovered:3,capacities:1,iterationsRead:1,warnings:1,read:3,imported:3,parents:1,excluded:0});
});
test('real bundled MCP initializes and advertises the required schemas without authentication',async t=>{
  const gateway=new AzureGateway();t.after(()=>gateway.close());
  await gateway.open({organization:'example',authentication:'interactive'});
  const {tools}=await gateway.client.listTools();
  for(const name of ['neo_team_members','neo_team_days_off','neo_work_item_states','neo_security_read','neo_security_login','wit_backlog','work'])assert.ok(tools.some(tool=>tool.name===name));
  const write=tools.find(tool=>tool.name==='wit_work_item_write');
  const schema=JSON.stringify(write.inputSchema);assert.match(schema,/test/);assert.match(schema,/number/);assert.match(schema,/updates/);
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

test('import excludes completed and removed custom states while keeping open children and resolved work',async()=>{
  const gateway=backlogGateway(),base=gateway.call,calls=[],progress=[];
  const config={organization:'org',project:'Project',team:'Team'};
  const states=[{name:'Active',category:'InProgress'},{name:'New',category:'Proposed'},{name:'Resolved',category:'Resolved'},{name:'Closed',category:'Completed'},{name:'Done',category:'Completed'},{name:'Entregado',category:'Completed'},{name:'Descartado',category:'Removed'}];
  const specs={1:{state:'Active',parent:20},2:{state:'Closed',children:[3]},3:{state:'New',parent:2},4:{state:'Descartado'},5:{state:'Entregado'},6:{state:'Resolved'},7:{state:'Entregado',type:'User Story'},8:{state:'Active'},9:{state:'Done'},10:{state:'Active',parent:9},20:{state:'Closed'}};
  gateway.call=async(name,args)=>{
    calls.push({name,args});
    if(name==='neo_work_item_states')return states.map(s=>({...s,category:args.type==='User Story' && s.name==='Entregado' ? 'InProgress' : s.category}));
    if(name==='wit_backlog' && args.action==='list')return [{id:'stories'}];
    if(name==='wit_backlog' && args.action==='list_work_items')return {workItems:[1,2,4,5,6,7,8,10].map(id=>({target:{id}}))};
    if(name==='wit_work_item' && args.action==='get'){
      const item=specs[args.id];
      return {id:args.id,rev:1,fields:{'System.Title':`Item ${args.id}`,'System.WorkItemType':item.type || 'Task','System.State':item.state,'System.TeamProject':'Project','System.AreaPath':'Project','System.IterationPath':'Project','System.Parent':item.parent,'Microsoft.VSTS.Scheduling.RemainingWork':0},relations:(item.children || []).map(id=>({rel:'System.LinkTypes.Hierarchy-Forward',url:`https://dev.azure.com/org/_apis/wit/workItems/${id}`}))};
    }
    return base(name,args);
  };
  const result=await gateway.import(config,p=>progress.push(p));
  assert.deepEqual(result.items.map(i=>i.id),[1,6,7,8,10,3]);
  assert.equal(result.items.find(i=>i.id===3).parent,2,'an open child is retained without importing its closed parent');
  assert.equal(progress.at(-1).counts.excluded,5,'closed parents already traversed are counted only once');
  assert.equal(progress.at(-1).counts.imported,6);
  assert.equal(calls.filter(c=>c.name==='neo_work_item_states').length,2,'state categories are cached per work item type');
  specs[8].state='Done';
  const refreshed=await gateway.import(config);
  assert.ok(!refreshed.items.some(i=>i.id===8),'the next import removes newly completed work');
  specs[8].state='Unknown';
  await assert.rejects(()=>gateway.import(config),/categoría del estado «Unknown»/);
  const completeCall=gateway.call;
  gateway.call=async(name,args)=>name==='neo_work_item_states' ? null : completeCall(name,args);
  await assert.rejects(()=>gateway.import(config),/consultar los estados/);
});

test('import skips past iterations before requesting their tasks, capacity or holidays',async()=>{
  const today=new Date().toISOString().slice(0,10);
  const yesterday=new Date(Date.parse(today)-86400000).toISOString();
  const tomorrow=new Date(Date.parse(today)+86400000).toISOString();
  const definitions=[
    ['past-text',{timeFrame:'past'}],['past-number',{timeFrame:0}],
    ['past-date',{finishDate:yesterday}],
    ['current-text',{timeFrame:'current'}],['current-number',{timeFrame:1}],
    ['future-text',{timeFrame:'future'}],['future-number',{timeFrame:2}],
    ['ends-today',{finishDate:today+'T00:00:00Z'}],['future-date',{finishDate:tomorrow}],
    ['undated',{}],
  ];
  const iterations=definitions.map(([id,attributes])=>({id,name:id,path:`Project\\${id}`,attributes}));
  const gateway=backlogGateway({iterations}),base=gateway.call,calls=[],progress=[];
  gateway.call=async(name,args)=>{calls.push({name,args});return base(name,args);};
  const result=await gateway.import({organization:'org',project:'Project',team:'Team'},p=>progress.push(p));
  const expected=definitions.map(([id])=>id).filter(id=>!id.startsWith('past-'));
  assert.deepEqual(result.iterations.map(i=>i.id),expected);
  assert.deepEqual(Object.keys(result.capacities),expected);
  assert.ok(!calls.some(c=>c.args.iterationId?.startsWith('past-')));
  for(const id of expected)assert.equal(calls.filter(c=>c.args.iterationId===id).length,3);
  assert.equal(progress.at(-1).counts.iterationsExcluded,3);
  assert.equal(progress.at(-1).counts.iterations,7);
  assert.equal(progress.at(-1).counts.iterationsRead,7);
});

test('state matching handles casing, whitespace and missing categories on standard closed states',async()=>{
  const gateway=backlogGateway(),base=gateway.call;
  let state=' closed ',metadata=[{name:'Closed',category:'Completed'}];
  gateway.call=async(name,args)=>{
    if(name==='neo_work_item_states')return metadata;
    if(name==='wit_backlog' && args.action==='list')return [{id:'stories'}];
    if(name==='wit_backlog' && args.action==='list_work_items')return {workItems:[{target:{id:1}}]};
    if(name==='wit_work_item' && args.action==='get')return {id:1,rev:1,fields:{'System.Title':'Story','System.WorkItemType':'User Story','System.State':state,'System.TeamProject':'Project','System.AreaPath':'Project','System.IterationPath':'Project'}};
    return base(name,args);
  };
  const config={organization:'org',project:'Project',team:'Team'};
  for(const row of [
    {state:' closed ',metadata:[{name:'Closed',category:'Completed'}]},
    {state:'Closed',metadata:[{name:' closed ',category:' completed '}]},
    {state:'CLOSED',metadata:[{name:'Closed',color:'339933'}]},
    {state:'Done',metadata:[]},
    {state:'Removed',metadata:[{name:'Removed',category:null}]},
    {state:'Entregado',metadata:[{name:'ENTREGADO',stateCategory:'Completed'}]},
  ]){
    ({state,metadata}=row);
    const progress=[];
    const result=await gateway.import(config,p=>progress.push(p));
    assert.deepEqual(result.items,[],`${state} must be excluded`);
    assert.equal(progress.at(-1).counts.excluded,1);
  }
  state='Closed';metadata=[{name:'closed',category:' InProgress '}];
  assert.equal((await gateway.import(config)).items.length,1,'a configured category overrides the standard name');
  state='En curso';metadata=[{name:'EN CURSO ',category:' In Progress '}];
  assert.equal((await gateway.import(config)).items.length,1);
  state='Personalizado';metadata=[{name:'Personalizado',color:'339933'}];
  await assert.rejects(()=>gateway.import(config),/categoría del estado/,'unknown custom states are never silently treated as open');
});
