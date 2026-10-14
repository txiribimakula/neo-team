import test from 'node:test';
import assert from 'node:assert/strict';
import { outcomeGroup, testPlan, testPoint, defaultPlan, sortPlans, testPlanSnapshot } from '../server/test-plans.js';
import { demoTestPlans } from '../server/demo.js';
import { AzureGateway } from '../server/azure.js';
import { testPlansView, filterTestPlans, toggleTestPlanOutcome, setTestPlansView, resetTestPlanFilters, focusTestPlans, chooseTestPlan, rememberedTestPlan } from '../dist/test-plans.js';

test('outcomes are grouped from names or from the numbers of the enumeration', () => {
  assert.deepEqual(['passed', 'Failed', 'timeout', 'blocked', 'warning', 'notApplicable', 'paused', 'unspecified', 'notExecuted', undefined].map(outcomeGroup),
    ['passed', 'failed', 'failed', 'blocked', 'inconclusive', 'notApplicable', 'inProgress', 'notRun', 'notRun', 'notRun']);
  assert.deepEqual([2, 3, 7, 13, 0].map(outcomeGroup), ['passed', 'failed', 'blocked', 'inProgress', 'notRun']);
});

test('the default plan is an active one whose dates include today, or the latest active one', () => {
  const plan = (id, state, start, end, updated) => testPlan({ id, name: `P${id}`, state, startDate: start, endDate: end, rootSuite: { id: id * 10 }, updatedDate: updated });
  const plans = [plan(1, 'Inactive', '2026-10-01', '2026-10-30', '2026-10-12'), plan(2, 'Active', '2026-09-01', '2026-09-20', '2026-10-11'), plan(3, 'Active', '2026-10-05', '2026-10-20', '2026-10-01')];
  assert.equal(defaultPlan(plans, '2026-10-13').id, 3);
  assert.equal(defaultPlan(plans, '2026-12-01').id, 2, 'the active plan changed most recently');
  assert.deepEqual(sortPlans(plans).map(p => p.id), [2, 3, 1], 'inactive plans go last');
  assert.equal(defaultPlan([]), null);
});

test('points carry their tester, last run and the priority of their test case; inactive ones are left out', () => {
  const raw = { id: 7, tester: { displayName: 'Ana García' }, configuration: { name: 'Chrome' }, isActive: true, testSuite: { id: 12 }, testCaseReference: { id: 40, name: 'Login' }, results: { outcome: 'failed', lastResultDetails: { dateCompleted: '2026-10-10T10:00:00Z', runBy: { displayName: 'Marcos Ruiz' } } } };
  const point = testPoint(raw, new Map([[40, { fields: { 'Microsoft.VSTS.Common.Priority': 1, 'System.State': 'Ready' } }]]));
  assert.deepEqual([point.tester, point.outcome, point.runBy, point.priority, point.caseState, point.suiteId, point.configuration], ['Ana García', 'failed', 'Marcos Ruiz', 1, 'Ready', 12, 'Chrome']);
  const never = testPoint({ id: 8, results: { outcome: 'unspecified', lastResultDetails: { dateCompleted: '0001-01-01T00:00:00' } } });
  assert.deepEqual([never.tester, never.runAt, never.outcome, never.title], ['', null, 'notRun', 'Caso 8']);
  const snapshot = testPlanSnapshot({ plans: [], plan: null, points: [raw, { ...raw, id: 9, isActive: false }] });
  assert.deepEqual([snapshot.points.map(p => p.id), snapshot.inactive], [[7], 1]);
});

test('a plan is read with its points and the priority of its test cases', async () => {
  const gateway = new AzureGateway(), calls = [];
  gateway.call = async (name, args) => {
    calls.push({ name, args });
    if (name === 'neo_test_plans') return [{ id: 5, name: 'Old', state: 'Inactive', rootSuite: { id: 50 } }, { id: 6, name: 'Regresión', state: 'Active', rootSuite: { id: 60 }, owner: { displayName: 'Lucía' } }];
    if (name === 'neo_test_plan_points') return { suites: [{ id: 60, name: 'Regresión' }, { id: 61, name: 'Login', parentSuite: { id: 60 }, suiteType: 'staticTestSuite' }], points: [{ id: 1, testSuite: { id: 61 }, testCaseReference: { id: 900, name: 'Entrar' }, tester: { displayName: 'Ana' }, results: { outcome: 'passed' } }], limited: false };
    if (name === 'neo_work_items_batch') return [{ id: 900, fields: { 'Microsoft.VSTS.Common.Priority': 2, 'System.State': 'Ready', 'System.Title': 'x' } }];
  };
  const snapshot = await gateway.testPlans({ organization: 'org', project: 'P' }, null);
  assert.deepEqual(calls.map(c => c.name), ['neo_test_plans', 'neo_test_plan_points', 'neo_work_items_batch']);
  assert.deepEqual(calls[1].args, { project: 'P', planId: 6, rootSuiteId: 60 });
  assert.deepEqual([snapshot.plan.id, snapshot.plans.map(p => p.id), snapshot.points[0].priority, snapshot.suites[1].parentId], [6, [6, 5], 2, 60]);
  calls.length = 0;
  assert.equal((await gateway.testPlans({ project: 'P' }, 5)).plan.id, 5, 'the chosen plan is kept');
  gateway.call = async () => [];
  const empty = await gateway.testPlans({ project: 'P' }, null);
  assert.deepEqual([empty.plan, empty.points], [null, []]);
});

test('the example has plans, nested suites, several testers and points without anybody', () => {
  const snapshot = demoTestPlans();
  assert.equal(snapshot.plan.name, 'Regresión 24');
  assert.ok(snapshot.suites.some(s => s.parentId && s.parentId !== snapshot.plan.rootSuiteId), 'suites in two levels');
  assert.ok(new Set(snapshot.points.map(p => p.tester)).size > 4);
  assert.ok(snapshot.points.some(p => !p.tester));
  assert.deepEqual(demoTestPlans(298).points.filter(p => p.outcome === 'notRun'), [], 'the finished plan was run completely');
  assert.deepEqual(demoTestPlans().points.map(p => p.outcome), demoTestPlans().points.map(p => p.outcome), 'stable outcomes');
});

test('the view sums up the plan, filters by person, suite and outcome and changes views', t => {
  const target = { innerHTML: '' }, original = globalThis.document;
  globalThis.document = { querySelector: () => target };
  t.after(() => { globalThis.document = original; resetTestPlanFilters(); setTestPlansView('people'); });
  const state = { mode: 'demo' }, snapshot = demoTestPlans();
  resetTestPlanFilters(); setTestPlansView('people');
  const html = testPlansView(snapshot, state);
  assert.match(html, /Regresión 24/);
  assert.match(html, /<span class="tp-kpi-label">Ejecutado<\/span>/);
  assert.match(html, /data-action="test-plans-focus" data-tester="__none__"/, 'the unassigned points can be shown');
  assert.match(html, /<optgroup label="Inactivos"><option value="298"/);
  assert.match(html, /tp-person[^>]*>Marcos Ruiz</);
  filterTestPlans(snapshot, 'tester', 'Ana García');
  assert.doesNotMatch(target.innerHTML, /Marcos Ruiz/);
  const login = snapshot.suites.find(s => s.name === 'Inicio de sesión').id, auth = snapshot.suites.find(s => s.name === 'Autenticación').id;
  focusTestPlans({ tester: '', suite: String(auth), view: 'list' });
  const total = snapshot.points.filter(p => [auth, login, auth + 1, auth + 2].includes(p.suiteId)).length;
  assert.match(testPlansView(snapshot, state), new RegExp(`${total} de ${snapshot.points.length} puntos`), 'a suite includes its children');
  toggleTestPlanOutcome(snapshot, 'notApplicable');
  assert.match(target.innerHTML, /Ningún punto coincide/);
  resetTestPlanFilters(); setTestPlansView('matrix');
  const matrix = testPlansView(snapshot, state);
  assert.match(matrix, /<th title="Autenticación">Autenticación<\/th>/);
  assert.match(matrix, /class="tp-cell" data-action="test-plans-focus" data-tester="Ana García" data-suite="\d+" data-view="list"/);
  setTestPlansView('suites');
  assert.match(testPlansView(snapshot, state), /padding-left:48px">[^]*?Inicio de sesión/, 'nested suites are indented');
  chooseTestPlan(305);
  assert.equal(rememberedTestPlan(), 305);
  assert.match(testPlansView(null, state), /Consultar Azure DevOps/);
  assert.match(testPlansView(null, { mode: 'azure', config: null }), /Conectar Azure DevOps/);
});
