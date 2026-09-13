import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {describeError,isInternalError} from '../server/diagnostics.js';

test('only failures of the application itself are internal, with their project location',()=>{
 assert.equal(isInternalError(new Error('HTTP 403 al leer los días libres')),false);
 assert.equal(isInternalError(Object.assign(new TypeError('x'),{status:400})),false);
 let error;try{null.items;}catch(caught){error=caught;}
 assert.equal(isInternalError(error),true);
 assert.equal(describeError(Object.assign(new Error('Denied'),{statusCode:403})).statusCode,403);
});
test('HTTP reports the local step, location and a saved report when merging a project fails internally',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'neo-diagnostics-'));
 const patch=`import {AzureGateway} from ${JSON.stringify(new URL('../server/azure.js',import.meta.url).href)};
 AzureGateway.prototype.import=async function(config,report){
  report({phase:'capacity',message:'Consultando capacidad de «Sprint 1»…',counts:{}});
  return {mode:'azure',config,settings:{backlogIteration:{path:config.project},workingDays:[1,2,3,4,5]},iterations:[],members:[],capacities:{},items:config.project==='A' ? [] : null,drafts:{},conflicts:{},participants:{},warnings:[]};
 };`;
 const child=spawn(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(patch)}`,'server/index.js'],{env:{...process.env,NEO_TEAM_PORT:'14397',NEO_TEAM_DATA_DIR:directory},stdio:['ignore','pipe','pipe']});
 t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}await rm(directory,{recursive:true,force:true});});
 await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('No server')),10000);child.stdout.on('data',c=>{if(String(c).includes('Neo Team:')){clearTimeout(timeout);resolve();}});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Exited'));});});
 const base='http://127.0.0.1:14397';let state=await (await fetch(base+'/api/state')).json();
 const post=async(path,input={})=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Neo-CSRF':state.csrf},body:JSON.stringify({...input,version:state.version})});const data=await response.json();if(response.ok)state=data.state ?? data;return {response,data};};
 const config=project=>({organization:'org',project,team:'Team'});
 await post('/api/config',{config:config('A')});assert.equal((await post('/api/import')).response.status,200);
 await post('/api/config',{config:config('B')});
 const failure=await post('/api/import');
 assert.equal(failure.response.status,400);
 assert.match(failure.data.error,/^Error interno durante «B \(1\/1\) · Uniendo con la planificación existente…» \(multi-project\.js:\d+\): /);
 assert.equal(failure.data.diagnostics,join(directory,'last-error.json'));
 const report=JSON.parse(await readFile(failure.data.diagnostics,'utf8'));
 assert.equal(report.error.name,'TypeError');assert.equal(report.operation.path,'/api/import');
 assert.deepEqual(report.operation.activity.map(e=>e.message).slice(-1),['B (1/1) · Uniendo con la planificación existente…']);
});
