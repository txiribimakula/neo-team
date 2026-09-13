import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('security HTTP preserves reports on cancellation, supports recovery and isolates project snapshots', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-security-http-'));
  const patch = `
    import { AzureGateway } from ${JSON.stringify(new URL('../server/azure.js', import.meta.url).href)};
    AzureGateway.prototype.open = async function(config) { this.auth = config.authentication; };
    AzureGateway.prototype.close = async function() {};
    AzureGateway.prototype.call = async function(name, args) {
      if (name === 'neo_security_login') { if (this.auth !== 'interactive') throw new Error('Browser recovery used CLI'); this.browserLogin = true; return { authenticated:true }; }
      if (name !== 'neo_security_read') throw new Error('Unexpected Azure call');
      await new Promise(resolve => setTimeout(resolve, 30));
      if (args.action === 'catalog') return { browserLogin: !!this.browserLogin, project: { id:'project', name:'Project' }, groups:[{descriptor:'group',name:'Group'}], namespaces:[{namespaceId:'namespace',name:'Project',actions:[{bit:1,name:'Read'}]}], coverage:[] };
      if (args.action === 'identity') return [{id:'group-id',descriptor:'legacy-group',name:'Group',members:[],memberOf:[]}];
      if (args.action === 'resources') return [];
      if (args.action === 'acl') return [{token:'project',acesDictionary:{'legacy-group':{allow:1,deny:0}}}];
      throw new Error('Unexpected query');
    };
  `;
  const child = spawn(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(patch)}`, 'server/index.js'], { env: { ...process.env, NEO_TEAM_PORT: '14329', NEO_TEAM_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(directory, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('Neo Team:')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}`)); });
  });
  const url = 'http://127.0.0.1:14329';
  let state = await (await fetch(url + '/api/state')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Neo-CSRF': state.csrf };
  const post = (path, input = {}) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify({ ...input, version: state.version }) });
  const snapshot = async () => (await (await fetch(url + '/api/security', { headers })).json()).security;
  const operation = async id => (await (await fetch(url + '/api/operation?id=' + id, { headers })).json()).operation;
  const waitRunning = async id => {
    for (let i = 0; i < 100; i++) {
      const value = await operation(id);
      if (value?.phase === 'security' && value.status === 'running') return value;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Missing security progress');
  };
  assert.equal((await fetch(url + '/api/security')).status, 403);
  assert.equal((await post('/api/security-groups')).status, 400);
  state = await (await post('/api/config', { config: { organization: 'example', project: 'Project', team: 'Team', authentication: 'azcli' } })).json();
  const version = state.version;
  assert.equal((await post('/api/security-groups', { operationId: 'groups' })).status, 200);
  assert.equal((await snapshot()).catalog.groups.length, 1);
  const audit = post('/api/security-audit', { operationId: 'audit', descriptor: 'group' });
  await waitRunning('audit');
  const during = await (await fetch(url + '/api/state')).json();
  assert.equal(during.busy, true); assert.equal(during.operation.id, 'audit');
  assert.equal(during.operation.path, '/api/security-audit');
  assert.equal((await post('/api/security-groups')).status, 409);
  assert.equal((await audit).status, 200);
  const saved = await snapshot();
  assert.equal(saved.report.rows.length, 1);
  assert.equal((await operation('audit')).status, 'complete');
  const cancel = post('/api/security-audit', { operationId: 'cancel', descriptor: 'group' });
  await waitRunning('cancel');
  assert.equal((await post('/api/cancel-operation', { id: 'cancel' })).status, 200);
  assert.equal((await cancel).status, 400);
  assert.equal((await operation('cancel')).status, 'cancelled');
  assert.deepEqual(await snapshot(), saved, 'cancelled audits preserve the last completed report');
  assert.equal((await post('/api/security-audit', { operationId: 'invalid', descriptor: 'unknown' })).status, 400);
  assert.deepEqual(await snapshot(), saved, 'failed audits preserve the report');
  state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.busy, false); assert.equal(state.version, version, 'security reads never alter planning data');
  assert.equal((await post('/api/security-groups', { operationId:'browser-login', reauthenticate:true })).status, 200);
  assert.equal((await snapshot()).catalog.browserLogin, true, 'reconnect explicitly invokes browser login even when configured to use CLI');
  state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.config.authentication, 'azcli', 'a browser retry does not silently rewrite the saved connection');
  state = await (await post('/api/config', { config: { organization: 'example', project: 'Other', team: 'Team' } })).json();
  assert.equal(await snapshot(), null, 'a different project cannot display the previous security report');
});
