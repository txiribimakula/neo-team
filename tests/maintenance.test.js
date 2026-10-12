import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceSettingsFrom, maintenanceWiql, maintenanceIssue, maintenanceFields } from '../server/maintenance.js';
import { demoFunctionalIssues, DEMO_STATES } from '../server/demo.js';

const states = [{ name: 'New', category: 'proposed' }, { name: 'Active', category: 'inprogress' }, { name: "Won't fix", category: 'removed' }, { name: 'Closed', category: 'completed' }];

test('closed states must be chosen from the loaded states of the type', () => {
  assert.deepEqual(maintenanceSettingsFrom({ type: ' Functional Issue ', states, closedStates: ['Closed', 'Closed', "Won't fix"] }), { type: 'Functional Issue', states, closedStates: ['Closed', "Won't fix"], verifyStates: [] });
  assert.deepEqual(maintenanceSettingsFrom({ type: 'Functional Issue', states, closedStates: ['Closed'], verifyStates: ['Active', 'Active'] }).verifyStates, ['Active']);
  assert.throws(() => maintenanceSettingsFrom({ type: 'Functional Issue', states, closedStates: ['Closed'], verifyStates: ['Ready'] }), /verificación de la lista/);
  assert.throws(() => maintenanceSettingsFrom({ type: 'Functional Issue', states, closedStates: ['Closed'], verifyStates: ['Closed'] }), /a la vez/);
  assert.throws(() => maintenanceSettingsFrom({ type: '', states, closedStates: [] }), /tipo/);
  assert.throws(() => maintenanceSettingsFrom({ type: 'Functional Issue', states: [], closedStates: [] }), /Carga primero/);
  assert.throws(() => maintenanceSettingsFrom({ type: 'Functional Issue', states, closedStates: ['Done'] }), /de la lista/);
});

test('one WIQL query over the project excludes only the closed states, with quotes escaped', () => {
  const wiql = maintenanceWiql({ type: "Functional Issue", closedStates: ['Closed', "Won't fix"] });
  assert.equal(wiql, "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = 'Functional Issue' AND [System.State] NOT IN ('Closed', 'Won''t fix') ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC");
  assert.doesNotMatch(maintenanceWiql({ type: 'Bug', closedStates: [] }), /NOT IN|AreaPath/);
  const all = maintenanceWiql({ type: 'Bug', closedStates: ['Closed'] }, { includeClosed: true });
  assert.doesNotMatch(all, /NOT IN/);
  assert.match(all, /ORDER BY \[System.ChangedDate\] DESC$/, 'the limit leaves out the oldest items');
});

test('the filterable fields leave out long texts, bookkeeping fields and duplicates', () => {
  const fields = maintenanceFields([{ referenceName: 'System.State', name: 'State', type: 'string' }, { referenceName: 'System.Description', name: 'Description', type: 'html' }, { referenceName: 'System.Rev', name: 'Rev', type: 'integer' }, { referenceName: 'System.State', name: 'State', type: 'string' }, { referenceName: 'Custom.Cliente', name: '', type: 'picklistString' }]);
  assert.deepEqual(fields, [{ ref: 'System.State', name: 'State', type: 'string' }, { ref: 'Custom.Cliente', name: 'Custom.Cliente', type: 'picklistString' }]);
  assert.deepEqual(maintenanceFields(null), []);
});

test('issues map identities, tags and the category of their state', () => {
  const issue = maintenanceIssue({ id: 3, fields: { 'System.Title': 'Broken', 'System.State': 'active', 'System.AssignedTo': { displayName: 'Ana García', uniqueName: 'ana@example.test' }, 'System.Tags': 'ui; login' } }, states);
  assert.deepEqual([issue.assignedTo, issue.category, issue.tags], ['Ana García', 'inprogress', ['ui', 'login']]);
  assert.equal(maintenanceIssue({ id: 4, fields: { 'System.AssignedTo': 'Marcos Ruiz <marcos@example.test>' } }).assignedTo, 'Marcos Ruiz');
  const fields = [{ ref: 'System.CreatedBy', type: 'identity' }, { ref: 'Custom.Blocked', type: 'boolean' }, { ref: 'Microsoft.VSTS.Common.Priority', type: 'integer' }, { ref: 'Custom.Notes', type: 'plainText' }, { ref: 'Custom.Empty', type: 'string' }];
  const values = maintenanceIssue({ id: 5, fields: { 'System.CreatedBy': { displayName: 'Soporte' }, 'Custom.Blocked': false, 'Microsoft.VSTS.Common.Priority': 2, 'Custom.Notes': 'x'.repeat(400), 'Custom.Empty': '' } }, states, fields).values;
  assert.deepEqual({ ...values, 'Custom.Notes': values['Custom.Notes'].length }, { 'System.CreatedBy': 'Soporte', 'Custom.Blocked': 'No', 'Microsoft.VSTS.Common.Priority': 2, 'Custom.Notes': 300 });
});

test('the example applies the chosen closed states', () => {
  const settings = { type: 'Functional Issue', states: DEMO_STATES, closedStates: ['Closed', 'Resolved'] };
  const result = demoFunctionalIssues(settings);
  assert.ok(result.issues.length && result.issues.every(i => !settings.closedStates.includes(i.state)));
  assert.ok(demoFunctionalIssues({ ...settings, closedStates: ['Closed'] }).issues.some(i => i.state === 'Resolved'));
  const all = demoFunctionalIssues(settings, { includeClosed: true });
  assert.ok(all.includeClosed && all.issues.some(i => i.state === 'Closed') && all.fields.length);
  assert.equal(all.issues[0].values['Custom.Cliente'], 'Acme');
});
