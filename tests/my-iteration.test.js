import test from 'node:test';
import assert from 'node:assert/strict';
import { currentIteration, myIterationWiql, myIterationBoard, boardItem } from '../server/my-iteration.js';
import { AzureGateway } from '../server/azure.js';
import { myIterationView, workDaysLeft } from '../dist/my-iteration.js';

const states = [{ name: 'To Do', category: 'proposed' }, { name: 'In Progress', category: 'inprogress' }, { name: 'Done', category: 'completed' }, { name: 'Removed', category: 'removed' }];
const raw = (id, type, state, parent = null, extra = {}) => ({ id, fields: { 'System.Title': `Item ${id}`, 'System.WorkItemType': type, 'System.State': state, 'System.Parent': parent, 'System.AssignedTo': { displayName: 'Ana García' }, ...extra } });

test('the current iteration is the one Azure marks or the one whose dates contain today', () => {
  const iterations = [{ id: 'a', attributes: { startDate: '2026-09-21T00:00:00Z', finishDate: '2026-10-02T00:00:00Z' } }, { id: 'b', attributes: { startDate: '2026-10-05T00:00:00Z', finishDate: '2026-10-16T00:00:00Z' } }];
  assert.equal(currentIteration(iterations, '2026-10-16').id, 'b', 'the end date is included');
  assert.equal(currentIteration(iterations, '2026-10-03'), null);
  assert.equal(currentIteration([...iterations, { id: 'c', attributes: { timeFrame: 'current' } }], '2026-10-06').id, 'c');
  assert.match(myIterationWiql("P\\Sprint 'A'"), /\[System\.IterationPath\] = 'P\\Sprint ''A''' AND \[System\.AssignedTo\] = @Me/);
});

test('the board groups my tasks by parent and state, like the taskboard', () => {
  const mine = [raw(11, 'Task', 'In Progress', 1, { 'Microsoft.VSTS.Scheduling.RemainingWork': 3 }), raw(12, 'Task', 'To Do', 1), raw(13, 'Bug', 'Active', 2), raw(14, 'Task', 'Removed', 1), raw(15, 'Task', 'To Do'), raw(2, 'User Story', 'Active'), raw(3, 'User Story', 'New')].map(boardItem);
  const parents = [raw(1, 'User Story', 'Active', null, { 'System.AssignedTo': { displayName: 'Marcos Ruiz' }, 'Microsoft.VSTS.Common.StackRank': 5 })].map(boardItem);
  const board = myIterationBoard(mine, parents, { Task: states, Bug: [{ name: 'Active', category: 'inprogress' }] });
  assert.deepEqual(board.columns.map(c => c.name), ['To Do', 'In Progress', 'Done']);
  assert.deepEqual(board.lanes.map(l => [l.parent?.id ?? null, l.parent?.mine ?? null, l.cards.map(c => [c.id, c.column])]), [
    [1, false, [[11, 'In Progress'], [12, 'To Do']]],
    [2, true, [[13, 'In Progress']]],
    [3, true, []],
    [null, null, [[15, 'To Do']]],
  ], 'removed items are hidden, a bug is placed by category and unparented cards go last');
});

test('my iteration reads the current iteration, my items, their parents and the states', async () => {
  const gateway = new AzureGateway(), calls = [];
  gateway.call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'work') return [{ id: 'i1', name: 'Sprint 7', path: '\\Sprint 7', attributes: { timeFrame: 'current', startDate: '2026-10-05T00:00:00Z', finishDate: '2026-10-16T00:00:00Z' } }];
    if (name === 'neo_work_item_states') return states;
    if (/@Me/.test(args.wiql)) return { ids: [11], limited: false, workItems: [raw(11, 'Task', 'To Do', 1)] };
    return { ids: [1], workItems: [raw(1, 'User Story', 'Active')] };
  };
  const result = await gateway.myIteration({ organization: 'org', project: 'P', team: 'T' });
  assert.deepEqual(calls.map(c => c.name), ['work', 'neo_query_work_items', 'neo_query_work_items', 'neo_work_item_states']);
  assert.match(calls[1].args.wiql, /\[System\.IterationPath\] = 'P\\Sprint 7'/);
  assert.match(calls[2].args.wiql, /\[System\.Id\] IN \(1\)/);
  assert.deepEqual([result.iteration.name, result.me, result.lanes[0].parent.id, result.lanes[0].cards[0].column], ['Sprint 7', 'Ana García', 1, 'To Do']);
  gateway.call = async name => name === 'work' ? [] : assert.fail('no queries without a current iteration');
  assert.equal((await gateway.myIteration({ organization: 'org', project: 'P', team: 'T' })).iteration, null);
});

test('the view shows the board and links to Azure DevOps outside the example', () => {
  const board = { organization: 'org', project: 'P', team: 'Equipo A', iteration: { name: 'Sprint 7', path: 'P\\Sprint 7', startDate: '2026-10-05T00:00:00Z', finishDate: '2026-10-16T00:00:00Z' }, me: 'Ana García', limited: false,
    columns: [{ name: 'To Do', category: 'proposed' }], lanes: [{ parent: null, cards: [{ id: 11, type: 'Task', title: 'Hacer <algo>', column: 'To Do', remainingWork: 2, tags: [] }] }] };
  const html = myIterationView({ demo: false, boards: [board] }, { mode: 'azure', config: { team: 'Equipo A' } });
  assert.match(html, /Hacer &lt;algo&gt;/);
  assert.match(html, /_workitems\/edit\/11/);
  assert.match(html, /_sprints\/taskboard\/Equipo%20A\/P\/Sprint%207/);
  assert.match(myIterationView({ demo: false, boards: [{ ...board, lanes: [] }] }, { mode: 'azure', config: { team: 'T' } }), /No tienes elementos asignados/);
  assert.match(myIterationView(null, { mode: 'azure', config: {} }), /Conectar Azure DevOps/);
  assert.equal(workDaysLeft('2026-10-16T00:00:00Z', '2026-10-09'), 6);
});
