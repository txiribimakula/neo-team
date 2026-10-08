import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JiraDesktop, desktopStage, desktopTitle } from '../server/jira-desktop.js';
import { JiraPipeline, TicketStore, newTicket, CopilotAgent } from '../server/jira-agents.js';
import { jiraView, activityView } from '../dist/jira.js';

test('desktop guard identifies one run, validates PID, streams events and stops', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const events = [];
  let args;
  const guard = new JiraDesktop({ platform: 'win32', launch: (command, input) => { assert.equal(command, 'powershell.exe'); args = input; return child; } });
  const run = { key: 'NEO-1', startedAt: 123 };
  await guard.start(run, e => events.push(e));
  try {
    assert.equal(args.at(-1), guard.file);
    assert.equal(JSON.parse(await readFile(guard.file)).title, desktopTitle(run));
    await assert.rejects(guard.select('42'));
    await guard.select(42);
    assert.equal(JSON.parse(await readFile(guard.file)).application, 42);
    child.stdout.write('{"kind":"info","message":"Reajuste"}\n');
    assert.ok(events.some(e => e.message === 'Reajuste'));
  } finally {
    child.emit('exit', 0);
    await guard.stop();
  }
  await assert.rejects(readFile(guard.file), { code: 'ENOENT' });
});

test('unsupported desktops report the limitation without launching anything', async () => {
  const events = [];
  const guard = new JiraDesktop({ platform: 'darwin', launch: () => assert.fail('must not launch') });
  await guard.start({}, e => events.push(e));
  assert.match(events[0].message, /Windows/);
  assert.match(await guard.select(42), /no disponible/);
  await guard.stop();
});

test('only reproduce and verify own the guard; every outcome releases it and retains logs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'neo-desktop-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const stage of ['reproduce', 'verify', 'fix', 'collect']) {
    for (const failure of [false, true]) {
      const tickets = new TicketStore(root);
      await tickets.update('NEO-1', () => ({ ...newTicket({ key: 'NEO-1' }), stage }));
      const calls = [];
      const pipeline = new JiraPipeline({ tickets, settings: async () => ({}), worktree: async () => null,
        desktop: () => ({ start: async run => calls.push(['start', run.desktopTitle]), stop: async () => calls.push(['stop']) }),
        agent: { run: async ({ desktop, onActivity }) => {
          assert.equal(!!desktop, desktopStage(stage));
          onActivity({ message: 'Acción\nResultado token=super-secret' });
          if (failure) throw new Error('Fallo al comprobar');
          return { outcome: stage === 'verify' ? 'verified' : stage === 'fix' ? 'fixed' : 'reproduced', report: 'Informe' };
        } },
      });
      await pipeline.runStage('NEO-1');
      assert.equal(calls.length, desktopStage(stage) ? 2 : 0);
      if (calls.length) { assert.match(calls[0][1], /^Neo Team \[NEO-1:/); assert.equal(calls.at(-1)[0], 'stop'); }
      assert.equal(pipeline.running, null);
      const entry = (await tickets.get('NEO-1')).history.at(-1);
      assert.ok(entry.activity.length);
      assert.ok(!JSON.stringify(entry.activity).includes('super-secret'));
      if (failure && stage !== 'collect') assert.equal(entry.outcome, 'error');
    }
  }
});

test('Copilot live activity includes tool progress, duration, results and assistant explanations', async () => {
  const handlers = new Map(), activity = [];
  let config;
  const session = {
    sessionId: 'test', on: (type, fn) => handlers.set(type, fn), disconnect: async () => {},
    sendAndWait: async () => {
      const emit = (type, data) => handlers.get(type)?.({ data });
      emit('assistant.message', { content: 'Voy a abrir la factura.' });
      emit('tool.execution_start', { toolCallId: 'one', toolName: 'powershell', arguments: { command: 'winapp ui inspect -a App' } });
      emit('tool.execution_progress', { toolCallId: 'one', progressMessage: 'Esperando ventana' });
      emit('tool.execution_complete', { toolCallId: 'one', success: false, error: { message: 'Ventana no encontrada' } });
      config.tools.find(t => t.name === 'neo_report').handler({ outcome: 'blocked', report: 'Necesita aplicación' });
    },
  };
  class Client {
    async start() {} async getAuthStatus() { return { isAuthenticated: true }; }
    async createSession(input) { config = input; return session; }
    async deleteSession() {} async stop() {}
  }
  const agent = new CopilotAgent({ load: async () => ({ CopilotClient: Client }) });
  await agent.run({ stage: 'reproduce', workingDirectory: tmpdir(), writable: [], onLearn: async () => {}, onActivity: e => activity.push(e), desktop: { select: async () => {} } });
  assert.ok(config.tools.some(t => t.name === 'neo_desktop'));
  assert.ok(activity.some(e => e.message === 'Voy a abrir la factura.'));
  assert.ok(activity.some(e => e.message === 'Esperando ventana'));
  assert.ok(activity.some(e => e.kind === 'warning' && /Falló powershell.* · \d+\.\d s\nVentana no encontrada/.test(e.message)));
});

test('the active ticket and escaped live logs precede the board in desktop phases', () => {
  const running = { key: 'NEO-1', stage: 'verify', startedAt: Date.now(), activity: [{ at: Date.now(), kind: 'warning', message: '<script>bad()</script>\nResultado' }] };
  const state = { mode: 'demo', jira: {} };
  const board = { settings: { demo: true }, tickets: [{ key: 'NEO-1', summary: 'Comprobar', stage: 'verify', status: 'running' }], pipeline: { running } };
  const html = jiraView(state, { board }, null);
  assert.ok(html.indexOf('jira-desktop-focus') < html.indexOf('jira-board'));
  assert.ok(html.indexOf('Logs en vivo') < html.indexOf('jira-board'));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(activityView(running, false), /Registro de la fase/);
  board.pipeline.running = null;
  assert.doesNotMatch(jiraView(state, { board }, null), /jira-desktop-focus/);
});


test('stopping during desktop preparation releases the guard without launching an agent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'neo-desktop-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tickets = new TicketStore(root);
  await tickets.update('NEO-1', () => ({ ...newTicket({}), stage: 'reproduce' }));
  let prepared, release, stopped = false;
  const ready = new Promise(resolve => { prepared = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const pipeline = new JiraPipeline({ tickets, settings: async () => ({}),
    desktop: () => ({ start: async () => { prepared(); await gate; }, stop: async () => { stopped = true; } }),
    agent: { run: async () => assert.fail('must not launch'), abort: async () => {} },
  });
  const run = pipeline.runStage('NEO-1');
  await ready;
  await pipeline.stop();
  release();
  assert.equal((await run).outcome, 'stopped');
  assert.equal(stopped, true);
  assert.equal((await tickets.get('NEO-1')).status, 'pending');
});
