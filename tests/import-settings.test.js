import test from 'node:test';
import assert from 'node:assert/strict';
import {createDemo,applyDemoImportRules,upgradeDemoImportRules} from '../server/demo.js';
import {availableImportRules} from '../server/import-query.js';
import {configurationView} from '../dist/settings.js';

test('configuration groups all states by project and leaf type and preserves saved decisions',()=>{
 const workspace=createDemo();
 workspace.workItemStates['User Story']=workspace.workItemStates.Task;
 const rules=availableImportRules(workspace,workspace.importRules);
 assert.equal(rules.length,12);
 assert.ok(!rules.some(r=>r.type==='User Story'));
 const html=configurationView({importRules:rules});
 assert.equal((html.match(/data-action="toggle-import-state"/g) ?? []).length,12);
 assert.equal((html.match(/aria-pressed="true"/g) ?? []).length,8);
 assert.match(html,/Closed/);assert.match(html,/Ready for Test/);
 workspace.importRules.find(r=>r.type==='Task' && r.state==='Closed').action='include';
 assert.equal(upgradeDemoImportRules(workspace),false);
 assert.equal(workspace.importRules.find(r=>r.type==='Task' && r.state==='Closed').action,'include');
});

test('demo filtering retains ancestors and pending changes, and excluded items can be restored',()=>{
 const workspace=createDemo(), original=structuredClone(workspace.items);
 const task=workspace.items.find(i=>i.type==='Task');
 workspace.drafts[task.id]={title:'Cambio local pendiente'};
 workspace.importRules.filter(r=>r.type==='Task').forEach(r=>r.action='exclude');
 applyDemoImportRules(workspace,'tasks');
 assert.ok(workspace.items.some(i=>i.id===task.id));
 assert.ok(workspace.items.every(i=>i.type!=='Task' || i.id===task.id));
 for(const item of workspace.items) {
  if(item.parent && original.some(i=>i.id===item.parent)) assert.ok(workspace.items.some(i=>i.id===item.parent));
 }
 assert.equal(workspace.drafts[task.id].title,'Cambio local pendiente');
 workspace.importRules.filter(r=>r.type==='Task').forEach(r=>r.action='include');
 applyDemoImportRules(workspace,'tasks');
 assert.ok(original.filter(i=>i.type==='Task').every(i=>workspace.items.some(item=>item.id===i.id)));
});


test('existing demos with only a Task catalog recover Bug states without replacing saved work',()=>{
 const workspace=createDemo();
 delete workspace.workItemStates.Bug;
 delete workspace.completedStates.Bug;
 workspace.importRules=workspace.importRules.filter(r=>r.type==='Task');
 workspace.importRules.find(r=>r.state==='Active').action='exclude';
 workspace.drafts[1042]={state:'Ready for Test'};
 const items=structuredClone(workspace.items), drafts=structuredClone(workspace.drafts);
 assert.equal(upgradeDemoImportRules(workspace),true);
 assert.equal(workspace.workItemStates.Bug.length,6);
 assert.equal(workspace.completedStates.Bug,'Closed');
 assert.equal(workspace.importRules.filter(r=>r.type==='Bug').length,6);
 assert.equal(workspace.importRules.find(r=>r.type==='Task' && r.state==='Active').action,'exclude');
 assert.deepEqual(workspace.items,items);
 assert.deepEqual(workspace.drafts,drafts);
 assert.equal(upgradeDemoImportRules(workspace),false);
 assert.match(configurationView({importRules:workspace.importRules}),/>Bugs /);
});
