import test from 'node:test';
import assert from 'node:assert/strict';
import { sprintName, guessTemplate, nextDates, nameProblem, isoWeek, latestIteration } from '../dist/sprint-name.js';
import { iterationPlan, createIteration, addDemoIteration } from '../server/iterations.js';
import { createDemo } from '../server/demo.js';

const iteration = (id, name, startDate, finishDate, path = `Project\\Release\\${name}`) => ({ id, name, path, attributes: { startDate: `${startDate}T00:00:00Z`, finishDate: `${finishDate}T00:00:00Z` } });

test('the name template combines the number, the week, the month, the year and the day with offsets', () => {
  assert.equal(sprintName('Sprint {n}', { startDate: '2026-10-26', previousName: 'Sprint 24' }), 'Sprint 25');
  assert.equal(sprintName('Semana {semana}-{semana+1} {año}', { startDate: '2026-10-26' }), 'Semana 44-45 2026');
  assert.equal(sprintName('S{semana} {SEMANA + 1}', { startDate: '2026-12-28' }), 'S53 01', 'the week after the last one of the year is the first');
  assert.equal(sprintName('{día}-{mes} → {mes+3} {anio-1} {n-1}', { startDate: '2026-10-31', previousName: 'R2 Sprint 7' }), '31-10 → 01 2025 7');
  assert.equal(sprintName('Sprint {n}', { startDate: '2026-10-26' }), 'Sprint 1', 'without a previous number the count starts at one');
  assert.equal(isoWeek('2027-01-04'), 1);
  assert.equal(guessTemplate('Iteración 24'), 'Iteración {n}');
  assert.equal(guessTemplate('Release 2 - Sprint 14'), 'Release 2 - Sprint {n}');
  assert.equal(guessTemplate(''), 'Sprint {n}');
  assert.match(nameProblem('Sprint 1/2'), /no puede contener/);
  assert.equal(nameProblem('Semana 44-45'), '');
});

test('the next dates keep the length of the last iteration and the cadence of the last two', () => {
  assert.deepEqual(nextDates([iteration('a', 'S1', '2026-10-12', '2026-10-23'), iteration('b', 'S2', '2026-10-26', '2026-11-06')]), { startDate: '2026-11-09', finishDate: '2026-11-20' });
  assert.deepEqual(nextDates([iteration('b', 'S2', '2026-10-26', '2026-11-08')]), { startDate: '2026-11-09', finishDate: '2026-11-22' });
  assert.deepEqual(nextDates([], '2026-10-23'), { startDate: '2026-10-26', finishDate: '2026-11-06' }, 'two weeks from next Monday');
});

test('a new iteration is created next to the last one of each project and the calendar is read again', async () => {
  const workspace = { mode: 'azure', config: { organization: 'org', project: 'Project', team: 'Team' }, settings: { backlogIteration: { path: 'Project' } }, iterations: [iteration('a', 'Sprint 24', '2026-10-12', '2026-10-23'), iteration('b', 'Sprint 25', '2026-10-26', '2026-11-06')], members: [], items: [], drafts: {}, capacities: {} };
  const plan = iterationPlan(workspace, { template: 'Sprint {n} · S{semana}', startDate: '2026-11-09', finishDate: '2026-11-20' });
  assert.deepEqual(plan.sources.map(({ name, parentPath }) => ({ name, parentPath })), [{ name: 'Sprint 26 · S46', parentPath: 'Release' }]);
  assert.throws(() => iterationPlan(workspace, { template: 'Sprint {n}', startDate: '2026-11-02', finishDate: '2026-11-13' }), /se solapan con «Sprint 25»/);
  assert.throws(() => iterationPlan(workspace, { template: 'Sprint 25', startDate: '2026-11-09', finishDate: '2026-11-20' }), /ya existe/);
  assert.throws(() => iterationPlan(workspace, { template: 'Sprint {n}', startDate: '2026-11-20', finishDate: '2026-11-09' }), /anterior a la de inicio/);
  const calls = [], created = iteration('c', 'Sprint 26 · S46', '2026-11-09', '2026-11-20');
  const azure = {
    open: async () => {},
    createIteration: async (config, args) => { calls.push(args); return { id: 'c' }; },
    import: async (config, report, rules, { snapshot }) => ({ ...snapshot, iterations: [...snapshot.iterations, created] }),
  };
  const next = await createIteration(workspace, plan, azure, []);
  assert.deepEqual(calls, [{ parentPath: 'Release', name: 'Sprint 26 · S46', startDate: '2026-11-09', finishDate: '2026-11-20' }]);
  assert.ok(next.iterations.some(i => i.id === 'c'));
  // Repeating it once Azure has it, with the same dates, does not create it again.
  const again = iterationPlan(next, { template: 'Sprint 26 · S46', startDate: '2026-11-09', finishDate: '2026-11-20' });
  assert.equal(again.sources[0].exists, true);
});

test('a team without iterations creates the first one under its backlog iteration', () => {
  const workspace = { mode: 'azure', config: { organization: 'org', project: 'Project', team: 'Team' }, settings: { backlogIteration: { path: 'Project\\Team' } }, iterations: [], members: [], items: [] };
  assert.deepEqual(iterationPlan(workspace, { template: 'Sprint {n}', startDate: '2026-11-09', finishDate: '2026-11-20' }).sources.map(({ name, parentPath }) => ({ name, parentPath })), [{ name: 'Sprint 1', parentPath: 'Team' }]);
});

test('the example data adds the iteration to the local copy', () => {
  const demo = createDemo(), last = latestIteration(demo.iterations), start = new Date(Date.parse(last.attributes.finishDate) + 3 * 86400000).toISOString().slice(0, 10);
  const plan = iterationPlan(demo, { template: 'Iteración {n}', startDate: start, finishDate: start });
  const added = addDemoIteration(demo, plan);
  assert.equal(added.name, 'Iteración 26');
  assert.equal(added.path, 'Neo Platform\\Iteración 26');
  assert.equal(latestIteration(demo.iterations).id, added.id);
});
