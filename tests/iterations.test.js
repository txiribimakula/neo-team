import test from 'node:test';
import assert from 'node:assert/strict';
import { sprintName, guessTemplate, nextDates, nameProblem, isoWeek, latestIteration, sequence, renamePlan } from '../dist/sprint-name.js';
import { iterationPlan, createIteration, addDemoIteration, iterationRenames, renameIterations, renameLocally } from '../server/iterations.js';
import { mergeProjects } from '../server/multi-project.js';
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
  assert.equal(sprintName(' {año} \\\\ Sprint  {n} ', { startDate: '2026-10-26', number: 7 }), '2026\\Sprint 7', 'a backslash separates folders and empty ones are dropped');
  assert.equal(nameProblem('2026\\Sprint 1'), '');
  assert.equal(guessTemplate('Sprint 14 · S46', 1), 'Sprint {n} · S46');
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

const project = (id, iterations, items = []) => ({ mode: 'azure', config: { organization: 'org', project: id, team: 'Team' }, settings: { backlogIteration: { path: id } }, iterations, members: [], items, drafts: {}, capacities: {} });

test('the counting number is the one that grows by one and does not repeat a date', () => {
  const list = [iteration('a', 'Sprint 24 · S42', '2026-10-12', '2026-10-23'), iteration('b', 'Sprint 25 · S44', '2026-10-26', '2026-11-06'), iteration('c', 'Hardening', '2026-11-09', '2026-11-20')];
  assert.deepEqual([...sequence(list).numbers], [['a', 24], ['b', 25], ['c', 26]], 'an iteration without it follows the previous one');
  assert.equal(sequence([iteration('x', 'Sprint 5 · S19', '2026-05-04', '2026-05-15')]).numbers.get('x'), 5, 'one iteration: the week is not its number');
});

test('renaming keeps each number, moves into folders and orders swaps', () => {
  const list = [iteration('a', 'Sprint 24', '2026-10-12', '2026-10-23'), iteration('b', 'Sprint 25', '2026-10-26', '2026-11-06'), iteration('c', 'Sprint 26', '2026-11-09', '2026-11-20')];
  const kept = renamePlan(list, 'Iteración {n}', '2026-10-25');
  assert.deepEqual(kept.rows.map(r => [r.kind, r.to]), [['past', 'Release\\Iteración 24'], ['current', 'Release\\Iteración 25'], ['next', 'Release\\Iteración 26']], 'without folders each stays in its own');
  assert.deepEqual(renamePlan(list, '{año}\\Sprint {n}', '2026-10-25').renames.map(r => r.to), ['2026\\Sprint 24', '2026\\Sprint 25', '2026\\Sprint 26'], 'with folders the path starts at the project');
  assert.equal(renamePlan(list, '\\Sprint {n}', '2026-10-25').rows[0].to, 'Sprint 24', 'a leading backslash is the root of the project');
  assert.equal(renamePlan(list, 'Sprint {n}', '2026-10-25').renames.length, 0, 'what already follows the criterion is left as it is');
  assert.match(renamePlan(list, 'Sprint', '2026-10-25').problem, /mismo nombre/);
  // Sprint 25 → Sprint 26 needs Sprint 26 to move first.
  const shifted = renamePlan(list, 'Sprint {n+1}', '2026-10-25');
  assert.deepEqual(shifted.renames.map(r => r.id), ['c', 'b', 'a']);
  assert.match(renamePlan([iteration('a', 'Sprint 1', '2026-10-12', '2026-10-23', 'P\\Sprint 2'), iteration('b', 'Sprint 2', '2026-10-26', '2026-11-06', 'P\\Sprint 1')], 'Sprint {n}', '2026-10-25').problem, /dos pasos/);
});

test('existing iterations are renamed one by one in Azure and the local copy follows them', async () => {
  const items = [{ id: 1, iterationPath: 'Project\\Release\\Sprint 25' }, { id: 2, iterationPath: 'Project' }];
  const workspace = project('Project', [iteration('a', 'Sprint 24', '2026-10-12', '2026-10-23'), iteration('b', 'Sprint 25', '2026-10-26', '2026-11-06')], items);
  assert.throws(() => iterationRenames({ ...workspace, drafts: { 1: { title: 'x' } } }, { template: 'S{n}' }), /Sincroniza o descarta/);
  assert.throws(() => iterationRenames(workspace, { template: 'Sprint {n}' }), /ya siguen el criterio/);
  const plan = iterationRenames(workspace, { template: '{año}\\Sprint {n}' }, '2026-10-25'), calls = [];
  const azure = {
    open: async () => {},
    renameIteration: async (config, args) => { calls.push(args); if (calls.length === 2) throw new Error('Sin permiso.'); return { id: args.id }; },
    import: async (config, report, rules, { snapshot }) => ({ ...snapshot, iterations: snapshot.iterations }),
  };
  const { workspace: next, done, failure } = await renameIterations(workspace, plan, azure, []);
  assert.deepEqual(calls[0], { id: 'a', path: 'Release\\Sprint 24', parentPath: '2026', name: 'Sprint 24' });
  assert.equal(done, 1);
  assert.match(failure.message, /Se renombraron 1 de 2\. Sin permiso\. Vuelve a aplicar/);
  assert.equal(next.iterations[0].path, 'Project\\2026\\Sprint 24', 'what was renamed is kept');
  assert.equal(next.iterations[1].path, 'Project\\Release\\Sprint 25');
  const again = iterationRenames(next, { template: '{año}\\Sprint {n}' }, '2026-10-25');
  assert.deepEqual(again.sources[0].renames.map(r => r.id), ['b'], 'applying it again continues with the rest');
  const local = renameLocally(structuredClone(next), again.sources.flatMap(({ source, renames }) => renames.map(rename => ({ source, rename }))));
  assert.equal(local.items[0].iterationPath, 'Project\\2026\\Sprint 25', 'tasks follow their iteration');
  assert.equal(local.items[1].iterationPath, 'Project');
});

test('each project has its own template for new and existing iterations', () => {
  const a = project('A', [iteration('a1', 'Sprint 7', '2026-10-26', '2026-11-06', 'A\\Sprint 7')]), b = project('B', [iteration('b1', 'Iteración 40', '2026-10-26', '2026-11-06', 'B\\2026\\Iteración 40')]);
  const workspace = mergeProjects(a, b), [ia, ib] = workspace.sources.map(s => s.id);
  const plan = iterationPlan(workspace, { templates: { [ia]: 'Sprint {n}', [ib]: '{año}\\It {n}' }, startDate: '2026-11-09', finishDate: '2026-11-20' });
  assert.deepEqual(plan.sources.map(({ name, parentPath }) => ({ name, parentPath })), [{ name: 'Sprint 8', parentPath: '' }, { name: 'It 41', parentPath: '2026' }]);
  const renames = iterationRenames(workspace, { templates: { [ib]: 'Iter {n}' } }, '2026-10-25');
  assert.deepEqual(renames.sources.map(s => [s.source.config.project, s.renames.map(r => r.to)]), [['B', ['2026\\Iter 40']]], 'only the projects given are renamed');
  const local = renameLocally(structuredClone(workspace), renames.sources.flatMap(({ source, renames }) => renames.map(rename => ({ source: { id: source.id }, rename }))));
  assert.equal(local.sources[1].iterations[0].path, 'B\\2026\\Iter 40');
  assert.equal(local.iterations[0].sourceIterations[ib], 'b1', 'the shared calendar goes by identifier and is not touched');
});
