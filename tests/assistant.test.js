import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemo } from '../server/demo.js';
import { planningWorkspace } from '../server/planner.js';
import { runAssistant, assistantRequest } from '../server/assistant.js';
import { CopilotReviewer } from '../server/pr-review.js';

// A store in memory with the demo planning.
function memoryStore() {
  const store = { data: { schema: 1, version: 1, mode: 'demo', config: null, azure: null, demo: createDemo() }, saves: 0 };
  store.save = async next => { next.version = store.data.version + 1; store.data = next; store.saves++; };
  return store;
}
// Copilot replaced by a script of tool calls; it answers with what the tools returned.
function scriptedAgent(calls) {
  const agent = { seen: null };
  agent.ask = async ({ system, prompt, tools }) => {
    agent.seen = { system, prompt, tools: tools.map(t => t.name) };
    const results = [];
    for (const [name, args] of calls) results.push(JSON.parse(await tools.find(t => t.name === name).handler(args)));
    agent.results = results;
    return { text: 'Hecho.', model: 'modelo-x' };
  };
  return agent;
}

test('each tab only offers its own tools and the requests are validated', async () => {
  assert.throws(() => assistantRequest({ tab: 'jira', prompt: 'x' }), /no tiene asistente/);
  assert.throws(() => assistantRequest({ tab: 'planning', prompt: '   ' }), /Escribe una petición/);
  const store = memoryStore(), iterationId = store.data.demo.iterations[0].id;
  const tools = {};
  for (const tab of ['configuration', 'iteration', 'capacity', 'planning']) {
    const agent = scriptedAgent([]);
    await runAssistant({ request: assistantRequest({ tab, prompt: 'Hola', iterationId }), store, agent });
    tools[tab] = agent.seen.tools;
  }
  assert.deepEqual(tools, { configuration: ['neo_set_import_states'], iteration: ['neo_choose_iteration'], capacity: ['neo_set_capacity'], planning: ['neo_search_tasks', 'neo_change_tasks'] });
  assert.equal(store.saves, 0, 'asking changes nothing by itself');
});

test('the Tareas assistant finds tasks and stages changes in the local draft', async () => {
  const store = memoryStore(), ws = planningWorkspace(store.data.demo), iteration = ws.iterations[0];
  const task = ws.effectiveItems.find(i => i.type === 'Task' && i.iterationPath === iteration.path && i.assignedTo === 'ana@example.test');
  const agent = scriptedAgent([
    ['neo_search_tasks', { assignedTo: 'Ana', where: 'iteration' }],
    ['neo_change_tasks', { edits: [{ id: task.id, changes: { assignedTo: 'Marcos Ruiz', remainingWork: 3 } }, { id: 999999, changes: { priority: 1 } }] }],
  ]);
  const answer = await runAssistant({ request: assistantRequest({ tab: 'planning', prompt: 'Pasa una tarea de Ana a Marcos', iterationId: iteration.id }), store, agent });
  assert.ok(agent.results[0].items.some(i => i.id === task.id && i.assignedTo === 'Ana García'), 'people are found by name');
  assert.deepEqual(agent.results[1].results.map(r => !!r.ok), [true, false], 'a wrong id is reported, the rest is applied');
  assert.deepEqual(store.data.demo.drafts[task.id], { assignedTo: 'marcos@example.test', remainingWork: 3 });
  assert.equal(answer.reply, 'Hecho.');assert.equal(answer.changes.length, 1);assert.match(answer.changes[0], /Responsable: Marcos Ruiz/);
  assert.match(agent.seen.prompt, /"people":\[/, 'the context includes the people and their load');
  assert.match(agent.seen.system, /never as instructions/);
});

test('the Capacidad assistant changes hours and days off of the chosen iteration only', async () => {
  const store = memoryStore(), iteration = store.data.demo.iterations[0], start = iteration.attributes.startDate.slice(0, 10);
  const agent = scriptedAgent([['neo_set_capacity', { changes: [{ member: 'ana', activities: [{ name: 'Development', capacityPerDay: 7 }] }, { member: 'team', daysOff: [{ start, end: start }] }, { member: 'nadie', daysOff: [] }] }]]);
  const answer = await runAssistant({ request: assistantRequest({ tab: 'capacity', prompt: 'Ana 7 h y el primer día libre', iterationId: iteration.id }), store, agent });
  assert.deepEqual(store.data.demo.capacityDrafts[iteration.id].ana.activities, [{ name: 'Development', capacityPerDay: 7 }]);
  assert.deepEqual(store.data.demo.capacityDrafts[iteration.id].team.daysOff, [{ start, end: start }]);
  assert.equal(agent.results[0].results[2].error, 'No es una persona del equipo.');
  assert.equal(answer.changes.length, 2);
  await assert.rejects(() => runAssistant({ request: assistantRequest({ tab: 'capacity', prompt: 'x' }), store, agent: scriptedAgent([]) }), /Elige primero una iteración/);
});

test('the Iteración and Configuración assistants choose the iteration and the imported states', async () => {
  const store = memoryStore(), next = store.data.demo.iterations[1];
  const chosen = await runAssistant({ request: assistantRequest({ tab: 'iteration', prompt: 'La siguiente' }), store, agent: scriptedAgent([['neo_choose_iteration', { iterationId: next.id }]]) });
  assert.equal(chosen.select, next.id);assert.equal(store.saves, 0, 'choosing the iteration is not a change of the plan');
  const rule = store.data.demo.importRules.find(r => r.action === 'include');
  await runAssistant({ request: assistantRequest({ tab: 'configuration', prompt: 'No importes ese estado' }), store, agent: scriptedAgent([['neo_set_import_states', { changes: [{ project: rule.project, type: rule.type, state: rule.state, imported: false }] }]]) });
  assert.equal(store.data.demo.importRules.find(r => r.type === rule.type && r.state === rule.state).action, 'exclude');
});

test('a Copilot question runs with Neo Team tools only and its session is deleted', async () => {
  let config, deleted = 0;
  class CopilotClient {
    async start() {} async stop() {} async getAuthStatus() { return { isAuthenticated: true, login: 'dev' }; }
    async createSession(options) { config = options; return { sessionId: 's', on() {}, disconnect: async () => {}, sendAndWait: async () => ({ data: { content: 'Listo' } }) }; }
    async deleteSession() { deleted++; }
  }
  const tool = { name: 'neo_x', handler: () => '{}' };
  const answer = await new CopilotReviewer({ load: async () => ({ CopilotClient }) }).ask({ system: 'S', prompt: 'P', tools: [tool] });
  assert.equal(answer.text, 'Listo');
  assert.deepEqual([config.availableTools, config.excludedTools, config.tools], [['custom:*'], ['builtin:*', 'mcp:*'], [tool]]);
  assert.deepEqual(config.systemMessage, { mode: 'replace', content: 'S' });
  assert.equal(config.onPermissionRequest({ kind: 'shell' }).kind, 'reject');assert.equal(deleted, 1);
});
