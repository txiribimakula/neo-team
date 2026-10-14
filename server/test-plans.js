// Test plans: the plans of the project and, for the chosen one, its suites and
// test points. A point is a test case in a suite with one configuration; its
// tester is the person assigned to run it and its outcome the last result.
import { localDay } from '../dist/hierarchy.js';

export const TEST_POINT_LIMIT = 5000;
export const TEST_CASE_FIELDS = ['Microsoft.VSTS.Common.Priority', 'System.State'];
// Azure answers outcomes as names, or as the numbers of the Outcome enumeration.
const OUTCOME_NAMES = ['unspecified', 'none', 'passed', 'failed', 'inconclusive', 'timeout', 'aborted', 'blocked', 'notExecuted', 'warning', 'error', 'notApplicable', 'paused', 'inProgress', 'notImpacted'];
const SUITE_TYPES = ['none', 'dynamicTestSuite', 'staticTestSuite', 'requirementTestSuite'];
const identity = value => typeof value === 'object' && value ? String(value.displayName ?? value.uniqueName ?? '') : String(value ?? '').replace(/\s*<[^<>]*>$/, '');
// Azure fills dates of points never run with year 1.
const date = value => value && new Date(value).getUTCFullYear() > 2000 ? new Date(value).toISOString() : null;

export function outcomeGroup(value) {
  const name = (typeof value === 'number' ? OUTCOME_NAMES[value] ?? '' : String(value ?? '')).toLowerCase();
  if (name === 'passed') return 'passed';
  if (['failed', 'error', 'timeout', 'aborted'].includes(name)) return 'failed';
  if (name === 'blocked') return 'blocked';
  if (['inconclusive', 'warning'].includes(name)) return 'inconclusive';
  if (name === 'notapplicable') return 'notApplicable';
  if (['inprogress', 'paused'].includes(name)) return 'inProgress';
  return 'notRun';
}

export function testPlan(raw) {
  return {
    id: raw.id, name: raw.name || `Plan ${raw.id}`, state: raw.state ?? '', iteration: raw.iteration ?? '', areaPath: raw.areaPath ?? '',
    startDate: date(raw.startDate), endDate: date(raw.endDate), owner: identity(raw.owner),
    rootSuiteId: raw.rootSuite?.id ?? null, updatedAt: date(raw.updatedDate),
  };
}
const isActive = plan => String(plan.state).toLowerCase() !== 'inactive';
// Active plans first, the most recently changed on top.
export const sortPlans = plans => [...plans].sort((a, b) => isActive(b) - isActive(a) || String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || b.id - a.id);
// The plan shown when none was chosen: an active one whose dates include today,
// or else the active one changed most recently.
export function defaultPlan(plans, today = localDay()) {
  const sorted = sortPlans(plans), active = sorted.filter(isActive);
  return active.find(p => p.startDate && p.endDate && p.startDate.slice(0, 10) <= today && today <= p.endDate.slice(0, 10)) ?? active[0] ?? sorted[0] ?? null;
}

export function testSuite(raw) {
  const type = typeof raw.suiteType === 'number' ? SUITE_TYPES[raw.suiteType] : raw.suiteType;
  return { id: raw.id, name: raw.name || `Suite ${raw.id}`, parentId: raw.parentSuite?.id ?? null, type: type ?? '', requirementId: raw.requirementId ?? null };
}

// The test case work item adds what the point does not carry: its priority and state.
export function testPoint(raw, cases = new Map()) {
  const result = raw.results ?? {}, details = result.lastResultDetails ?? {}, caseId = raw.testCaseReference?.id ?? null, item = cases.get(caseId)?.fields ?? {};
  return {
    id: raw.id, suiteId: raw.testSuite?.id ?? null, caseId, title: raw.testCaseReference?.name || `Caso ${caseId ?? raw.id}`,
    configuration: raw.configuration?.name ?? '', tester: identity(raw.tester), outcome: outcomeGroup(result.outcome),
    runBy: identity(details.runBy), runAt: date(details.dateCompleted), automated: raw.isAutomated === true,
    priority: item['Microsoft.VSTS.Common.Priority'] ?? null, caseState: item['System.State'] ?? raw.testCaseReference?.state ?? '',
    active: raw.isActive !== false,
  };
}

// Inactive points (of removed or closed test cases) are left out, as in the
// Execute tab of Azure Test Plans.
export function testPlanSnapshot({ organization, project, plans, plan, suites = [], points = [], cases = new Map(), limited = false, demo = false }) {
  const all = points.map(raw => testPoint(raw, cases)), active = all.filter(p => p.active);
  return {
    organization, project, fetchedAt: new Date().toISOString(), demo, plans, plan,
    suites: suites.map(testSuite), points: active, inactive: all.length - active.length, limited,
  };
}
