import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createDemo } from '../server/demo.js';
import { planningWorkspace, stageChanges, stageCapacity } from '../server/planner.js';

const source = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
// Exercise the browser's selection and drop handlers with the actual local planner.
// The DOM boundary is small: a drop target, rendered task IDs and focusable fields.
function fixture() {
  const workspace = createDemo(), iteration = workspace.iterations.find(i => i.id === 'sprint-24');
  const handlers = {}, calls = [], notices = [];
  const context = vm.createContext({
    state: { workspace: planningWorkspace(workspace) }, activePlanningMember: null,
    backlogQuery: '', noteDrafts: {}, pending: false,
    key: member => member.uniqueName.toLowerCase(), escape: value => String(value ?? ''),
    number: value => String(value), initials: () => '',
    plural: (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`,
    selected: () => iteration, nextIteration: () => null, filtered: items => items,
    taskCard: item => `<article data-id="${item.id}">${item.title}</article>`,
    capacityWarning: () => '', toast: (...args) => notices.push(args),
    document: { addEventListener: (name, handler) => { handlers[name] = handler; } },
    stage: async (id, changes) => {
      calls.push({ id, ...changes });
      stageChanges(workspace, id, changes);
      context.state.workspace = planningWorkspace(workspace);
    },
  });
  vm.runInContext(source.slice(source.indexOf('function planningPersonCard('), source.indexOf('// What is typed in a note')), context);
  vm.runInContext(source.slice(source.indexOf("const outsidePlanningMember="), source.indexOf('const planCount =')), context);
  vm.runInContext(source.slice(source.indexOf("for (const type of ['dragenter','dragover'])"), source.indexOf("document.addEventListener('dragleave'")), context);
  vm.runInContext(source.slice(source.indexOf("document.addEventListener('drop',"), source.indexOf('// Optional WebMCP access')), context);
  const drop = async (id, owner) => handlers.drop({
    preventDefault() {},
    target: { closest: () => ({ dataset: { drop: owner }, classList: { remove() {} } }) },
    dataTransfer: { getData: () => String(id) },
  });
  return { context, workspace, iteration, calls, notices, drop, handlers };
}

test('all person cards stay visible while the detail shows only the selected person', () => {
  const { context, iteration } = fixture();
  const planned = context.state.workspace.effectiveItems.filter(i => i.iterationPath === iteration.path);
  assert.match(context.planLanes(iteration, planned), /Selecciona una persona/);
  context.activePlanningMember = 'ana@example.test';
  const cards = context.planPeople(iteration, planned), detail = context.planLanes(iteration, planned);
  assert.equal((cards.match(/data-action="select-planning-person"/g) ?? []).length, 4);
  assert.equal((cards.match(/aria-pressed="true"/g) ?? []).length, 1);
  assert.match(detail, /data-id="1042"/);
  assert.doesNotMatch(detail, /data-id="1038"/);
  context.activePlanningMember = 'marcos@example.test';
  assert.match(context.planLanes(iteration, planned), /data-id="1038"/);
  assert.doesNotMatch(context.planLanes(iteration, planned), /data-id="1042"/);
});

test('direct assignment moves backlog work into the chosen iteration and avoids offering it twice', async () => {
  const { context, iteration } = fixture();
  const item = context.state.workspace.effectiveItems.find(i => i.id === 1053);
  assert.equal(context.assignActiveButton(item), '');
  context.activePlanningMember = 'ana@example.test';
  assert.match(context.assignActiveButton(item), /Asignar #1053 a Ana García/);
  await context.assignToPlanningPerson(item.id, context.activePlanningPerson().uniqueName);
  const assigned = context.state.workspace.effectiveItems.find(i => i.id === item.id);
  assert.equal(assigned.assignedTo, 'ana@example.test');
  assert.equal(assigned.iterationPath, iteration.path);
  assert.equal(context.activePlanningMember, 'ana@example.test');
  assert.equal(context.assignActiveButton(assigned), '');
});

test('people without available capacity are hidden and their existing work stays accessible', () => {
  const { context, workspace, iteration } = fixture();
  stageCapacity(workspace, iteration.id, { key: 'ana', activities: [{ name: 'Development', capacityPerDay: 0 }] });
  workspace.capacities[iteration.id].teamMembers = workspace.capacities[iteration.id].teamMembers.filter(record => record.teamMember.id !== 'marcos');
  context.state.workspace = planningWorkspace(workspace);
  const planned = context.state.workspace.effectiveItems.filter(i => i.iterationPath === iteration.path);
  const cards = context.planPeople(iteration, planned);
  assert.doesNotMatch(cards, /data-member="ana@example.test"|data-member="marcos@example.test"/);
  assert.match(cards, /data-member="lucia@example.test"/);
  assert.match(cards, /Fuera del reparto/);
  context.activePlanningMember = 'ana@example.test';
  assert.equal(context.activePlanningPerson(), null);
  assert.equal(context.assignActiveButton(context.state.workspace.effectiveItems.find(i => i.id === 1053)), '');
  context.activePlanningMember = '__outside__';
  const detail = context.planLanes(iteration, planned);
  assert.match(detail, /data-id="1042"/);
  assert.match(detail, /data-id="1038"/);
});

test('a drop uses its target person with no active person or a different active person', async () => {
  const { context, iteration, drop } = fixture();
  await drop(1053, 'marcos@example.test');
  assert.equal(context.state.workspace.effectiveItems.find(i => i.id === 1053).assignedTo, 'marcos@example.test');
  context.activePlanningMember = 'ana@example.test';
  await drop(1053, 'david@example.test');
  const assigned = context.state.workspace.effectiveItems.find(i => i.id === 1053);
  assert.equal(assigned.assignedTo, 'david@example.test');
  assert.equal(assigned.iterationPath, iteration.path);
  assert.equal(context.activePlanningMember, 'ana@example.test');
  await drop(1053, 'backlog');
  assert.equal(context.state.workspace.effectiveItems.find(i => i.id === 1053).iterationPath, context.state.workspace.settings.backlogIteration.path);
});

test('entering nested content on a person card accepts a task drop', () => {
  const { handlers } = fixture();
  for (const type of ['dragenter', 'dragover']) {
    let accepted = false, highlighted = false;
    const event = {
      preventDefault: () => { accepted = true; },
      target: { closest: () => ({ classList: { add: () => { highlighted = true; } } }) },
      dataTransfer: { types: ['application/x-neo-task'] },
    };
    handlers[type](event);
    assert.ok(accepted);
    assert.ok(highlighted);
    assert.equal(event.dataTransfer.dropEffect, 'move');
  }
});
