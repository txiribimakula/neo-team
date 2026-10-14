import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewsView, publishConfirmation } from '../dist/reviews.js';
import { maintenanceView, maintenanceHead, maintenanceScope, boardKeys, refreshTargets, filterMaintenance, resetMaintenanceFilters, toggleMaintenanceState, addMaintenanceCondition, removeMaintenanceCondition, setMaintenanceView, setMaintenanceOrigin, setMaintenanceIncludeClosed, selectMaintenance, maintenanceSelection, clearMaintenanceSelection } from '../dist/maintenance.js';
import { jiraItems, filterItems, filtersFrom } from '../dist/maintenance-items.js';

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
  t.after(()=>{resetMaintenanceFilters();setMaintenanceView('board');});
  setMaintenanceView('list');
  const azure={demo:true,type:'Issue',issues:[{id:7,title:'Revisión del área',state:'Active',assignedTo:'Ana García',areaPath:'Equipo',tags:[],priority:2}]};
  const state={mode:'demo',maintenanceSettings:{type:'Issue',closedStates:['Closed']}};
  filterMaintenance('text','  garcia  ');
  assert.match(maintenanceView({azure},state),/Revisión del área/);
  toggleMaintenanceState('New');
  const none=maintenanceView({azure},state);
  assert.match(none,/Mostrar todos los elementos/);
  assert.doesNotMatch(none,/<tbody>/);
  assert.match(none,/<span class="maintenance-count" role="status"[^>]*>0 de 1<\/span>/);
  resetMaintenanceFilters();
  const html=maintenanceView({azure},state);
  assert.match(html,/Revisión del área/);
  assert.match(html,/data-action="maintenance-clear-filters" disabled>Limpiar filtros/,'nothing to clear');
});
test('maintenance colors states by group, filters by any field and groups by person', t => {
  t.after(()=>{resetMaintenanceFilters();setMaintenanceIncludeClosed(false);setMaintenanceView('board');});
  setMaintenanceView('list'); setMaintenanceIncludeClosed(true);
  const states=[{name:'New',category:'proposed'},{name:'Active',category:'inprogress'},{name:'Ready for Test',category:'inprogress'},{name:'Resolved',category:'resolved'},{name:'Closed',category:'completed'}];
  const issue=(id,state,assignedTo,cliente)=>({id,title:`Elemento ${id}`,state,assignedTo,areaPath:'Equipo',tags:[],priority:2,values:{'System.State':state,'Custom.Cliente':cliente}});
  const snapshot={demo:true,type:'Issue',states,closedStates:['Closed'],verifyStates:['Ready for Test','Resolved'],includeClosed:true,fields:[{ref:'System.State',name:'State',type:'string'},{ref:'Custom.Cliente',name:'Cliente',type:'string'}],
    issues:[issue(1,'New','',''),issue(2,'Active','Ana García','Acme'),issue(3,'Ready for Test','Ana García','Globex'),issue(4,'Resolved','Marcos Ruiz','Acme'),issue(5,'Closed','Marcos Ruiz','Acme')]};
  const settings={type:'Issue',states,closedStates:['Closed'],verifyStates:['Ready for Test','Resolved']};
  const state={mode:'demo',maintenanceSettings:settings}, view=()=>maintenanceView({azure:snapshot},state);
  const html=view();
  assert.match(html,/<tr class="st st-closed st-t0"><td class="select-cell"><input type="checkbox" class="task-select" data-maintenance-select="azure:5" [^>]*><\/td><td>#5/);
  assert.match(html,/class="pill st st-verify st-t0"[^>]*>Ready for Test/);
  assert.match(html,/class="pill st st-verify st-t1"[^>]*>Resolved/,'states of a group get different tones');
  assert.match(html,/Verificación<b>2<\/b>/);
  assert.match(html,/data-maintenance-include-closed checked/);
  assert.match(html,/<option value="Custom.Cliente">Cliente<\/option>/);
  const index=addMaintenanceCondition('Custom.Cliente');
  filterMaintenance('condition','Acme',index);
  assert.match(view(),/>3 de 5<\/span>/);
  assert.match(view(),/<th>Cliente<\/th>/,'a filtered field becomes a column');
  filterMaintenance('condition','__empty__',index);
  assert.match(view(),/>1 de 5<\/span>/);
  removeMaintenanceCondition(index);
  setMaintenanceView('people');
  filterMaintenance('text','');
  const people=view();
  assert.ok(people.indexOf('Ana García')<people.indexOf('Sin asignar')&&people.indexOf('Marcos Ruiz')<people.indexOf('Sin asignar'),'unassigned items go last');
  assert.equal((people.match(/class="person-card"/g)||[]).length,3);
});
test('items of Mantenimiento are chosen with their box to comment on all of them', t => {
  t.after(()=>{clearMaintenanceSelection();resetMaintenanceFilters();setMaintenanceView('board');});
  setMaintenanceView('list');
  const states=[{name:'New',category:'proposed'},{name:'Active',category:'inprogress'}];
  const snapshot={demo:true,type:'Issue',states,closedStates:[],verifyStates:[],fields:[],issues:[1,2,3].map(id=>({id,title:`Elemento ${id}`,state:'New',assignedTo:'',tags:[],values:{}}))};
  const state={mode:'demo',maintenanceSettings:{type:'Issue',states,closedStates:[],verifyStates:[]}}, view=(azure=snapshot)=>maintenanceView({azure},state);
  assert.match(view(),/data-maintenance-select-all(?![^>]*(checked|data-partial))/,'nothing chosen: the header box is clear');
  selectMaintenance('azure:2',true);
  const html=view();
  assert.match(html,/<tr class="[^"]* selected"><td class="select-cell"><input type="checkbox" class="task-select" data-maintenance-select="azure:2" checked/);
  assert.match(html,/data-maintenance-select-all\s+data-partial/,'some chosen: the header box is partial');
  filterMaintenance('text','Elemento 1');
  assert.doesNotMatch(view(),/azure:2/);
  assert.deepEqual(maintenanceSelection(),['azure:2'],'filtering keeps what was chosen, to gather it from several searches');
  filterMaintenance('text','');
  setMaintenanceView('people');
  assert.match(view(),/<li class="[^"]* selected"><input type="checkbox" class="task-select" data-maintenance-select="azure:2" checked/,'the people view chooses too');
  view({...snapshot,issues:snapshot.issues.filter(i=>i.id!==2)});
  assert.deepEqual(maintenanceSelection(),[],'an item that is gone is no longer chosen');
  selectMaintenance('azure:1',true);
  maintenanceView({azure:snapshot},{...state,mode:'azure'});
  assert.deepEqual(maintenanceSelection(),[],'changing to real data starts over');
});

