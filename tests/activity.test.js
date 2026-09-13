import test from 'node:test';
import assert from 'node:assert/strict';
import { activityReader, activityLine, describeCall, seconds } from '../server/activity.js';

test('activity lines are read across chunks while raw stderr logs are ignored', () => {
  const entries = [], read = activityReader(entry => entries.push(entry));
  const line = activityLine('auth', 'Esperando el inicio de sesión');
  read('{"level":"debug","message":"OAuthAuthenticator: Opening browser https://login.example/?code=secret"}\n' + line.slice(0, 10));
  read(Buffer.from(line.slice(10) + 'NEO_ACTIVITY {malformed\n' + activityLine('http', 'GET /org/_apis/projects')));
  assert.deepEqual(entries, [{ kind: 'auth', message: 'Esperando el inicio de sesión' }, { kind: 'http', message: 'GET /org/_apis/projects' }]);
});

test('calls are described by tool, action and scope', () => {
  assert.equal(describeCall('wit_work_item', { action: 'get_batch', ids: [1, 2] }), 'elementos de trabajo (wit_work_item · get_batch · 2 elementos)');
  assert.equal(describeCall('neo_work_item_states', { project: 'P', type: 'Task' }), 'estados del tipo (neo_work_item_states · «Task»)');
  assert.equal(describeCall('custom_tool'), 'custom_tool (custom_tool)');
  assert.equal(seconds(1250), '1,3 s');
});
