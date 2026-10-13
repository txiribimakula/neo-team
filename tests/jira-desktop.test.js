import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JiraDesktop, desktopStage, desktopTitle, listScreens, screensFrom } from '../server/jira-desktop.js';
import { JiraPipeline, TicketStore, newTicket, CopilotAgent } from '../server/jira-agents.js';
import { jiraView, activityView } from '../dist/jira.js';

test('desktop guard identifies one run, validates PID, streams events and stops', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const events = [];
  let args;
  const guard = new JiraDesktop({ platform: 'win32', launch: (command, input) => { assert.equal(command, 'powershell.exe'); args = input; return child; } });
  const run = { key: 'NEO-1', startedAt: 123 };
  await guard.start(run, e => events.push(e), { web: '\\\\.\\DISPLAY2', app: 'C:\\evil' });
  try {
    assert.equal(args.at(-1), guard.file);
    const config = JSON.parse(await readFile(guard.file));
    assert.equal(config.title, desktopTitle(run));
    assert.deepEqual([config.web, config.app], ['\\\\.\\DISPLAY2', null]);
    await guard.screens({ web: '\\\\.\\DISPLAY1', app: '\\\\.\\DISPLAY2' });
    assert.deepEqual(Object.values(screensFrom(JSON.parse(await readFile(guard.file)))), ['\\\\.\\DISPLAY1', '\\\\.\\DISPLAY2']);
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
      const pipeline = new JiraPipeline({ tickets, settings: async () => ({ buildCommand: 'b' }), worktree: async () => ({ path: root }), build: async () => ({ ok: true, code: 0, log: '' }),
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

test('desktop phases keep the whole board, with escaped live logs', () => {
  const running = { key: 'NEO-1', stage: 'verify', startedAt: Date.now(), activity: [{ at: Date.now(), kind: 'warning', message: '<script>bad()</script>\nResultado' }] };
  const state = { mode: 'demo', jira: {} };
  const board = { settings: { demo: true }, tickets: [{ key: 'NEO-1', summary: 'Comprobar', stage: 'verify', status: 'running' }], pipeline: { running } };
  const html = jiraView(state, { board }, null);
  assert.match(html, /jira-main/);
  assert.doesNotMatch(html, /jira-desktop-focus|jira-other-tickets/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(activityView(running, false), /Registro de la fase/);
  assert.match(activityView(running, false), /&lt;script&gt;/);
});

test('the monitors button chooses where the web and the application are maximized', () => {
  const state = { mode: 'real', jira: {} };
  const board = { settings: { screens: { web: '\\\\.\\DISPLAY2', app: null } }, tickets: [], pipeline: {}, tools: { screens: true } };
  assert.match(jiraView(state, { board }, null), /data-action="jira-screens" aria-pressed="false"/);
  assert.doesNotMatch(jiraView(state, { board }, null), /data-jira-screen/);
  // Open while the list is read: the saved choice shows, the selects wait.
  assert.match(jiraView(state, { board, screens: {} }, null), /data-jira-screen="web" disabled><option value="" >Automático<\/option><option value="[^"]+DISPLAY2" selected>Monitor 2</);
  const list = [{ id: '\\\\.\\DISPLAY1', primary: true, width: 1920, height: 1080 }, { id: '\\\\.\\DISPLAY2', primary: false, width: 2560, height: 1440 }];
  const html = jiraView(state, { board, screens: { list } }, null);
  assert.match(html, /Monitor 1 · 1920×1080 · principal/);
  assert.match(html, /DISPLAY2" selected>Monitor 2 · 2560×1440</);
  assert.match(html, /data-jira-screen="app"><option value="" selected>Automático/);
  assert.doesNotMatch(jiraView(state, { board: { ...board, tools: {} } }, null), /jira-screens/);
});

test('monitors are read from Windows and only device names are kept', async () => {
  assert.deepEqual(await listScreens({ platform: 'darwin', run: () => assert.fail('must not run') }), []);
  const run = (command, args, options, done) => { assert.equal(command, 'powershell.exe'); done(null, JSON.stringify({ id: '\\\\.\\DISPLAY3', primary: true, x: 0, y: 0, width: 1920, height: 1080 })); };
  assert.deepEqual(await listScreens({ platform: 'win32', run }), [{ id: '\\\\.\\DISPLAY3', primary: true, x: 0, y: 0, width: 1920, height: 1080 }]);
  await assert.rejects(listScreens({ platform: 'win32', run: (c, a, o, done) => done(new Error('sin permiso')) }), /monitores/);
  assert.deepEqual(screensFrom({ web: '\\\\.\\DISPLAY12', app: '../DISPLAY1' }), { web: '\\\\.\\DISPLAY12', app: null });
  assert.deepEqual(screensFrom(null), { web: null, app: null });
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
