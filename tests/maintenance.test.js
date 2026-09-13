import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceSettingsFrom, maintenanceWiql, maintenanceIssue } from '../server/maintenance.js';
import { demoFunctionalIssues, DEMO_STATES } from '../server/demo.js';

const states = [{ name: 'New', category: 'proposed' }, { name: 'Active', category: 'inprogress' }, { name: "Won't fix", category: 'removed' }, { name: 'Closed', category: 'completed' }];

test('closed states must be chosen from the loaded states of the type', () => {
  assert.deepEqual(maintenanceSettingsFrom({ type: ' Functional Issue ', states, closedStates: ['Closed', 'Closed', "Won't fix"] }), { type: 'Functional Issue', states, closedStates: ['Closed', "Won't fix"] });
  assert.throws(() => maintenanceSettingsFrom({ type: '', states, closedStates: [] }), /tipo/);
  assert.throws(() => maintenanceSettingsFrom({ type: 'Functional Issue', states: [], closedStates: [] }), /Carga primero/);
  assert.throws(() => maintenanceSettingsFrom({ type: 'Functional Issue', states, closedStates: ['Done'] }), /de la lista/);
});

test('one WIQL query over the project excludes only the closed states, with quotes escaped', () => {
  const wiql = maintenanceWiql({ type: "Functional Issue", closedStates: ['Closed', "Won't fix"] });
  assert.equal(wiql, "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Functional Issue' AND [System.State] NOT IN ('Closed', 'Won''t fix') ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC");
  assert.doesNotMatch(maintenanceWiql({ type: 'Bug', closedStates: [] }), /NOT IN|AreaPath/);
});

test('issues map identities, tags and the category of their state', () => {
  const issue = maintenanceIssue({ id: 3, fields: { 'System.Title': 'Broken', 'System.State': 'active', 'System.AssignedTo': { displayName: 'Ana García', uniqueName: 'ana@example.test' }, 'System.Tags': 'ui; login' } }, states);
  assert.deepEqual([issue.assignedTo, issue.category, issue.tags], ['Ana García', 'inprogress', ['ui', 'login']]);
  assert.equal(maintenanceIssue({ id: 4, fields: { 'System.AssignedTo': 'Marcos Ruiz <marcos@example.test>' } }).assignedTo, 'Marcos Ruiz');
});

test('the example applies the chosen closed states', () => {
  const settings = { type: 'Functional Issue', states: DEMO_STATES, closedStates: ['Closed', 'Resolved'] };
  const result = demoFunctionalIssues(settings);
  assert.ok(result.issues.length && result.issues.every(i => !settings.closedStates.includes(i.state)));
  assert.ok(demoFunctionalIssues({ ...settings, closedStates: ['Closed'] }).issues.some(i => i.state === 'Resolved'));
});
