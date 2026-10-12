import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewsView, publishConfirmation } from '../dist/reviews.js';
import { maintenanceView, filterMaintenance, resetMaintenanceFilters, toggleMaintenanceState, addMaintenanceCondition, removeMaintenanceCondition, setMaintenanceView } from '../dist/maintenance.js';

const review = () => ({
  id:'review-1', mode:'demo', repository:{name:'web'},
  pullRequest:{id:12, title:'Mejorar el acceso', status:'active', sourceRefName:'refs/heads/fix', targetRefName:'refs/heads/main'},
  notes:{}, verdict:'comment', summary:'Resumen de prueba',
  findings:[{id:'f1',title:'Comprobar el resultado',body:'Comentario de prueba',severity:'minor',selected:false}],
});
const detail = (r, includeSummary) => reviewsView({mode:'demo',prReviews:[r]}, {reviewId:r.id,includeSummary});
const publicationButton = html => html.match(/<button[^>]*data-action="pr-publish"[^>]*>[^<]*<\/button>/)?.[0];

test('publication is available only with an unpublished selection on an active PR', () => {
  const r=review();
  assert.match(publicationButton(detail(r,false)), /disabled/);
  assert.doesNotMatch(publicationButton(detail(r,true)), /disabled/);
  r.findings[0].selected=true;
  assert.doesNotMatch(publicationButton(detail(r,false)), /disabled/);
  assert.equal(publishConfirmation(r,true).count,2);
  assert.match(publicationButton(detail(r,true)), /\(2\)/);
  r.pullRequest.status='completed';
  assert.match(publicationButton(detail(r,true)), /disabled/);
  r.pullRequest.status='active';r.findings[0].published={id:1};r.summaryPublished={id:2};
  assert.match(publicationButton(detail(r,true)), /disabled/);
  assert.equal(publishConfirmation(r,true).count,0);
});

test('the review picker explains the active mode and exposes list refresh', () => {
  const ui={repositories:[{name:'web'}],repository:'web',pullRequests:[]};
  const demo=reviewsView({mode:'demo'},ui);
  assert.match(demo,/no se envía código a Copilot/);
  assert.match(demo,/Actualizar pull requests/);
  assert.match(demo,/type="url"/);
  const azure=reviewsView({mode:'azure',config:{project:'Equipo'}},ui);
  assert.match(azure,/El diff del pull request se envía a GitHub Copilot/);
  assert.doesNotMatch(azure,/Estás usando datos de ejemplo/);
});

test('maintenance searches ignore accents, report empty filters and can reset', t => {
  const target={innerHTML:''};
  const original=globalThis.document;
  globalThis.document={querySelector:()=>target};
  t.after(()=>{globalThis.document=original;resetMaintenanceFilters();});
  const snapshot={demo:true,type:'Issue',issues:[{id:7,title:'Revisión del área',state:'Active',assignedTo:'Ana García',areaPath:'Equipo',tags:[],priority:2}]};
  filterMaintenance(snapshot,'text','  garcia  ');
  assert.match(target.innerHTML,/Revisión del área/);
  toggleMaintenanceState(snapshot,'New');
  assert.match(target.innerHTML,/Mostrar todos los elementos/);
  assert.doesNotMatch(target.innerHTML,/<tbody>/);
  resetMaintenanceFilters();
  const html=maintenanceView(snapshot,{mode:'demo',maintenanceSettings:{type:'Issue',closedStates:['Closed']}},null);
  assert.match(html,/Revisión del área/);
  assert.match(html,/Limpiar filtros/);
});
test('maintenance colors states by group, filters by any field and groups by person', t => {
  const target={innerHTML:''};
  const original=globalThis.document;
  globalThis.document={querySelector:()=>target};
  t.after(()=>{globalThis.document=original;resetMaintenanceFilters();setMaintenanceView('list');});
  const states=[{name:'New',category:'proposed'},{name:'Active',category:'inprogress'},{name:'Ready for Test',category:'inprogress'},{name:'Resolved',category:'resolved'},{name:'Closed',category:'completed'}];
  const issue=(id,state,assignedTo,cliente)=>({id,title:`Elemento ${id}`,state,assignedTo,areaPath:'Equipo',tags:[],priority:2,values:{'System.State':state,'Custom.Cliente':cliente}});
  const snapshot={demo:true,type:'Issue',states,closedStates:['Closed'],verifyStates:['Ready for Test','Resolved'],includeClosed:true,fields:[{ref:'System.State',name:'State',type:'string'},{ref:'Custom.Cliente',name:'Cliente',type:'string'}],
    issues:[issue(1,'New','',''),issue(2,'Active','Ana García','Acme'),issue(3,'Ready for Test','Ana García','Globex'),issue(4,'Resolved','Marcos Ruiz','Acme'),issue(5,'Closed','Marcos Ruiz','Acme')]};
  const settings={type:'Issue',states,closedStates:['Closed'],verifyStates:['Ready for Test','Resolved']};
  const html=maintenanceView(snapshot,{mode:'demo',maintenanceSettings:settings},null);
  assert.match(html,/<tr class="st st-closed st-t0"><td>#5/);
  assert.match(html,/class="pill st st-verify st-t0"[^>]*>Ready for Test/);
  assert.match(html,/class="pill st st-verify st-t1"[^>]*>Resolved/,'states of a group get different tones');
  assert.match(html,/Verificación<b>2<\/b>/);
  assert.match(html,/data-maintenance-include-closed checked/);
  assert.match(html,/<option value="Custom.Cliente">Cliente<\/option>/);
  const index=addMaintenanceCondition('Custom.Cliente');
  filterMaintenance(snapshot,'condition','Acme',index);
  assert.match(target.innerHTML,/3 de 5 elementos/);
  assert.match(maintenanceView(snapshot,{mode:'demo',maintenanceSettings:settings},null),/<th>Cliente<\/th>/,'a filtered field becomes a column');
  filterMaintenance(snapshot,'condition','__empty__',index);
  assert.match(target.innerHTML,/1 de 5 elementos/);
  removeMaintenanceCondition(index);
  setMaintenanceView('people');
  filterMaintenance(snapshot,'text','');
  const people=target.innerHTML;
  assert.ok(people.indexOf('Ana García')<people.indexOf('Sin asignar')&&people.indexOf('Marcos Ruiz')<people.indexOf('Sin asignar'),'unassigned items go last');
  assert.equal((people.match(/class="person-card"/g)||[]).length,3);
});

