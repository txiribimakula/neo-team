import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewsView, publishConfirmation } from '../dist/reviews.js';
import { maintenanceView, filterMaintenance, resetMaintenanceFilters } from '../dist/maintenance.js';

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
  filterMaintenance(snapshot,'state','New');
  assert.match(target.innerHTML,/Mostrar todos los elementos/);
  assert.doesNotMatch(target.innerHTML,/<tbody>/);
  resetMaintenanceFilters();
  const html=maintenanceView(snapshot,{mode:'demo',maintenanceSettings:{type:'Issue',closedStates:['Closed']}},null);
  assert.match(html,/Revisión del área/);
  assert.match(html,/Limpiar filtros/);
});
