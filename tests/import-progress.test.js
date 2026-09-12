import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

// Exercise the real HTTP server while replacing only the external Azure import.
test('import progress is readable during work, isolated by id, and retained on failure',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'neo-progress-'));
  const patch=`
    import { AzureGateway } from ${JSON.stringify(new URL('../server/azure.js',import.meta.url).href)};
    import { createDemo } from ${JSON.stringify(new URL('../server/demo.js',import.meta.url).href)};
    let run=0;
    AzureGateway.prototype.import=async function(config, report) {
      const current=++run;
      report({phase:'members',message:'Leyendo integrantes…',counts:{members:3}});
      await new Promise(resolve=>setTimeout(resolve,350));
      report({phase:'items',message:'Leyendo elementos…',counts:{members:3,imported:2}});
      await new Promise(resolve=>setTimeout(resolve,350));
      if (current===2) throw new Error('Fallo de prueba al leer elementos');
      report({phase:'saving',message:'Guardando…',counts:{members:3,imported:2}});
      await new Promise(resolve=>setTimeout(resolve,150));
      return {...createDemo(),mode:'azure',config};
    };
  `;
  const child=spawn(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(patch)}`,'server/index.js'],{env:{...process.env,NEO_TEAM_PORT:'14320',NEO_TEAM_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null){child.kill('SIGTERM');await once(child,'exit');}await rm(directory,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Server did not start')),10000);
    child.stdout.on('data',chunk=>{if(chunk.toString().includes('Neo Team:')){clearTimeout(timer);resolve();}});
    child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}`));});
  });
  const url='http://127.0.0.1:14320';
  let state=await (await fetch(url+'/api/state')).json();
  const headers={'Content-Type':'application/json','X-Neo-CSRF':state.csrf};
  const post=(path,input={})=>fetch(url+path,{method:'POST',headers,body:JSON.stringify({...input,version:state.version})});
  const progress=async id=>(await (await fetch(url+'/api/import-progress?id='+id,{headers})).json()).progress;
  assert.equal((await fetch(url+'/api/import-progress?id=first')).status,403);
  assert.equal(await progress('first'),null);
  state=await (await post('/api/config',{config:{organization:'example',project:'Project',team:'Team'}})).json();
  const waitForProgress=async(id,phase)=>{
    for(let i=0;i<100;i++){
      const value=await progress(id);
      if(value?.phase===phase)return value;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail(`Missing progress phase ${phase}`);
  };
  const importing=post('/api/import',{importId:'first'});
  assert.equal((await waitForProgress('first','members')).status,'running');
  const during=await (await fetch(url+'/api/state')).json();
  assert.equal(during.busy,true);assert.equal(during.operation.id,'first');
  assert.equal(during.operation.path,'/api/import');assert.equal(during.operation.cancellable,true);
  assert.ok(during.operation.startedAt);assert.ok(during.operation.updatedAt);
  const resumed=await (await fetch(url+'/api/operation?id=first',{headers})).json();
  assert.equal(resumed.operation.id,'first');
  assert.equal(await progress('other'),null);
  assert.equal((await post('/api/import',{importId:'other'})).status,409);
  assert.equal((await waitForProgress('first','items')).counts.imported,2);
  const result=await importing;assert.equal(result.status,200);state=await result.json();
  assert.equal((await progress('first')).status,'complete');
  const savedVersion=state.version;
  const failing=post('/api/import',{importId:'second'});
  await waitForProgress('second','members');
  assert.equal(await progress('first'),null,'a retry must not display the previous import');
  assert.equal((await failing).status,400);
  const failed=await progress('second');
  assert.equal(failed.status,'failed');assert.equal(failed.phase,'items');assert.equal(failed.counts.imported,2);
  assert.match(failed.message,/Fallo de prueba/);
  state=await (await fetch(url+'/api/state')).json();
  assert.equal(state.busy,false);assert.equal(state.version,savedVersion,'a failed import does not replace saved data');
  const cancelled=post('/api/import',{importId:'third'});
  await waitForProgress('third','members');
  assert.equal((await post('/api/cancel-operation',{id:'wrong'})).status,409);
  assert.equal((await post('/api/cancel-operation',{id:'third'})).status,200);
  const cancelResult=await cancelled;
  assert.equal(cancelResult.status,400);assert.match((await cancelResult.json()).error,/cancelada/);
  assert.equal((await progress('third')).status,'cancelled');
  state=await (await fetch(url+'/api/state')).json();
  assert.equal(state.busy,false);assert.equal(state.version,savedVersion);assert.equal(state.operation,null);
  const retry=post('/api/import',{importId:'fourth'});
  await waitForProgress('fourth','saving');
  assert.equal((await post('/api/cancel-operation',{id:'fourth'})).status,409,'saving cannot be cancelled');
  assert.equal((await retry).status,200,'a cancelled operation does not keep the server locked');
});
