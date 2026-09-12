import { hierarchy, ancestors, participantSources, eligibleTasks, filterHierarchy, isExecutable, typeRank, selectionSummary, capacityStatus } from './hierarchy.js';
const $ = (selector, parent = document) => parent.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const key = member => (member.uniqueName || member.id || member.displayName || '').toLowerCase();
const number = value => new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(value);
const initials = name => name.trim().split(/\s+/).slice(0,2).map(s => s[0]).join('').toUpperCase();
const date = value => value ? new Date(value).toLocaleDateString('es', { day:'numeric', month:'short', timeZone:'UTC' }) : 'Sin fecha';
let state, selectedIteration = '', tab = 'hierarchy', query = '', pending = false, review, toastTimer;
let focusedMember='', pickerMember='', pickerQuery='', onlyAvailable=true, backlogFilter='all';
let peopleItem=null,peopleAnchor=null,peopleRect=null,peopleQuery='';
const peoplePopover=$('#people-popover');
const collapsed = new Set();
const modal = $('#modal');
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function errorInModal(error) {
  const target = $('#modal-error');
  if (modal.open && target) { target.textContent = error.message; target.hidden = false; }
  else toast(error.message);
}
async function request(path, input = {}) {
  if (pending) throw new Error('Espera a que termine la operación en curso.');
  pending = true;
  const enabled = [...document.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
  enabled.forEach(el => el.disabled = true);
  $('#save-status').textContent = 'Procesando…';
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type':'application/json', 'X-Neo-CSRF': state.csrf }, body: JSON.stringify({ ...input, version: state.version }) });
    const data = await response.json();
    if (!response.ok) {
      // Refresh version after partial success, restarts or edits in another tab.
      await loadState(false).catch(() => {});
      if (state) render();
      throw new Error(data.error || 'No se pudo completar la operación.');
    }
    if (data.state) state = data.state;
    else if (data.csrf) state = data;
    return data;
  } finally {
    pending = false; enabled.forEach(el => el.disabled = false);
    $('#save-status').textContent = state?.workspace ? 'Guardado en este equipo' : 'Almacenamiento local';
  }
}
async function loadState(renderNow = true) {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('No se pudo abrir el espacio local.');
  state = await response.json();
  if (renderNow) render();
}
function showModal(title, subtitle, body, actions = '') {
  modal.classList.remove('wide-modal');
  $('#modal-content').innerHTML = `<div class="modal-head"><div><h2 id="modal-title">${escape(title)}</h2><p>${escape(subtitle)}</p></div><button class="close" data-action="close" aria-label="Cerrar">×</button></div><div class="modal-body"><div class="inline-error" id="modal-error" role="alert" hidden></div>${body}</div><div class="modal-footer">${actions || '<button class="button" data-action="close">Cerrar</button>'}</div>`;
  if (!modal.open) modal.showModal();
}
function connection() {
  const c = state.config || {};
  showModal('Conecta tu equipo', 'Configura Azure DevOps desde aquí. Los datos se guardan en este equipo.', `
    <form id="connection-form">
      <label class="form-field">Organización<input name="organization" required maxlength="150" placeholder="mi-organizacion o https://dev.azure.com/mi-organizacion" value="${escape(c.organization)}" autocomplete="off"></label>
      <label class="form-field">Acceso<select name="authentication"><option value="interactive">Iniciar sesión con Microsoft</option><option value="azcli" ${c.authentication === 'azcli' ? 'selected' : ''}>Usar mi sesión de Azure CLI</option></select><small>Con Microsoft se abrirá tu navegador para iniciar sesión. La aplicación no solicita tu contraseña.</small></label>
      <div class="form-field"><label for="project">Proyecto</label><div class="actions"><input id="project" name="project" required maxlength="200" list="projects" placeholder="Nombre del proyecto" value="${escape(c.project)}" autocomplete="off"><button class="button small" type="button" data-action="projects">Buscar proyectos</button></div><datalist id="projects"></datalist></div>
      <div class="form-field"><label for="team">Equipo</label><div class="actions"><input id="team" name="team" required maxlength="200" list="teams" placeholder="Nombre del equipo" value="${escape(c.team)}" autocomplete="off"><button class="button small" type="button" data-action="teams">Buscar equipos</button></div><datalist id="teams"></datalist></div>
      <details><summary class="text-muted" style="font-size:14px;cursor:pointer;margin-bottom:14px">Opciones avanzadas</summary><label class="form-field">Tenant de Microsoft Entra (opcional)<input name="tenant" placeholder="Identificador del directorio" value="${escape(c.tenant)}"><small>Déjalo vacío para detectar el directorio de tu organización.</small></label></details>
      <p id="connection-progress" class="busy-note" role="status" hidden></p>
      <div class="notice">Se importarán integrantes, iteraciones, backlog y capacidad. Podrás preparar cambios en local y revisarlos antes de sincronizarlos.</div>
    </form>`, '<button class="button" data-action="save-config">Guardar configuración</button><button class="button primary" type="submit" form="connection-form">Conectar e importar ↙</button>');
}
const getConfig = () => Object.fromEntries(new FormData($('#connection-form')));
async function lookup(kind) {
  const config = getConfig();
  const note = $('#connection-progress'); note.hidden = false; note.textContent = 'Conectando… Completa el acceso de Microsoft en el navegador si se solicita.';
  try {
    const data = await request(`/api/${kind}`, { config });
    $(`#${kind}`).innerHTML = data[kind].map(item => `<option value="${escape(item.name)}"></option>`).join('');
    note.textContent = `${data[kind].length} ${kind === 'projects' ? 'proyectos' : 'equipos'} disponibles. Elige uno en el campo.`;
    const input = $(`#${kind === 'projects' ? 'project' : 'team'}`);
    if (!input.value && data[kind].length === 1) input.value = data[kind][0].name;
    input.focus();
  } catch (error) { note.hidden = true; throw error; }
}
async function saveConfig(importNow) {
  const form = $('#connection-form'); if (!form.reportValidity()) return;
  const config = getConfig();
  await request('/api/config', { config }); render();
  if (!importNow) { modal.close(); toast('Configuración guardada. Puedes importar los datos cuando quieras.'); return; }
  $('#connection-progress').hidden = false;
  $('#connection-progress').textContent = 'Importando el equipo y sus tareas… Completa el acceso de Microsoft si se abre el navegador. En backlogs grandes puede tardar varios minutos.';
  await request('/api/import');
  modal.close(); selectedIteration = ''; render(); toast('Equipo importado. Ya puedes preparar la iteración.');
}
function selected() {
  const ws = state.workspace;
  if (!ws) return null;
  if (!ws.iterations.some(i => i.id === selectedIteration)) selectedIteration = (ws.iterations.find(i => i.attributes?.timeFrame === 1 || i.attributes?.timeFrame === 'current') || ws.iterations[0])?.id || '';
  return ws.iterations.find(i => i.id === selectedIteration);
}
function filtered(items) {
  const search = query.trim().toLowerCase();
  return items.filter(i => !search || `${i.id} ${i.title} ${i.tags.join(' ')} ${i.assigneeName} ${i.assignedTo} ${i.state}`.toLowerCase().includes(search)).sort((a,b) => (a.priority ?? 5) - (b.priority ?? 5) || a.id - b.id);
}
const memberName = value => state.workspace?.members.find(m => key(m) === value)?.displayName || (value || 'Sin asignar');
const iterationName = value => state.workspace?.iterations.find(i => i.path === value)?.name || (value === state.workspace?.settings.backlogIteration.path ? 'Backlog' : value);
const pretty = (field,value) => field === 'assignedTo' ? memberName(value) : field === 'iterationPath' ? iterationName(value) : value === null || value === undefined ? 'Sin definir' : field === 'remainingWork' ? `${number(value)} h` : String(value);
function planningTree() { return hierarchy(state.workspace.effectiveItems); }
function matchesText(item, text) {
  return `${item.id} ${item.title} ${(item.tags || []).join(' ')} ${item.type}`.toLowerCase().includes(text.trim().toLowerCase());
}
function treeView({ availableOnly = false, picker = false, member = focusedMember, search = query } = {}) {
  const ws=state.workspace, tree=planningTree(), iteration=selected();
  const eligible=new Set(member ? eligibleTasks(ws,member).map(i=>i.id) : []);
  const matches=new Set();
  // Searching an Epic/Feature/Story includes all matching descendants.
  for (const item of ws.effectiveItems) {
    if (matchesText(item,search) || ancestors(item.id,tree).some(parent=>matchesText(parent,search))) matches.add(item.id);
  }
  const include=item=>{
    if (!matches.has(item.id)) return false;
    if (picker) return (!isExecutable(item) ? participantSources(item,ws,tree).has(member) : (eligible.has(item.id) || (item.assignedTo===member && item.iterationPath===iteration?.path)) && (!onlyAvailable || !item.assignedTo || item.assignedTo===member));
    if (!availableOnly && backlogFilter==='unshared') return isExecutable(item) && !ws.members.some(m=>participantSources(item,ws,tree).has(key(m)));
    if (availableOnly) return isExecutable(item) && (!iteration || item.iterationPath !== iteration.path) && (!member || eligible.has(item.id));
    if (member) return isExecutable(item) ? eligible.has(item.id) : participantSources(item,ws,tree).has(member);
    return true;
  };
  const roots=filterHierarchy(tree.roots,include);
  function nodeHtml(node,depth) {
    const sources=participantSources(node,ws,tree);
    const participants=ws.members.filter(m=>sources.has(key(m)));
    const peopleButton=`<button class="people-button" type="button" data-action="participants" data-task="${node.id}" aria-controls="people-popover" aria-expanded="${peopleItem===node.id}" aria-label="Repartir ${escape(node.title)} entre personas">${participants.slice(0,3).map((m,index)=>`<span class="avatar c${index%4}" title="${escape(m.displayName)}">${escape(initials(m.displayName))}</span>`).join('')}<span>${participants.length ? `${participants.length} personas` : '+ Repartir'}</span></button>`;
    const type=`<span class="node-type kind-${typeRank(node)}">${escape(node.type)}</span>`;
    if (!isExecutable(node)) {
      return `<details class="hierarchy-branch" data-node="${node.id}" ${picker || search || !collapsed.has(node.id) ? 'open' : ''}><summary><span class="branch-chevron">›</span>${type}<span class="branch-title">${escape(node.title)} <small>#${node.id}${node.contextOnly ? ' · contexto' : ''}</small></span>${picker ? `<button class="remove-branch" type="button" data-action="remove-branch" data-task="${node.id}" aria-label="Quitar ${escape(node.title)} de ${escape(memberName(member))}" title="Quita la rama y desmarca sus tareas de esta iteración">Quitar rama ×</button>` : peopleButton}</summary><div class="hierarchy-children">${node.children.map(child=>nodeHtml(child,depth+1)).join('') || '<p class="branch-empty">Sin tareas o bugs disponibles en esta rama.</p>'}</div></details>`;
    }
    const already=node.iterationPath === iteration?.path && node.assignedTo === member;
    const other=!!node.assignedTo && node.assignedTo !== member;
    const disabled=other;
    const effort=node.remainingWork !== null ? `${number(node.remainingWork)} h` : node.points !== null ? `${number(node.points)} pts` : 'Sin estimar';
    const controls=picker ? `<input type="checkbox" name="taskIds" value="${node.id}" aria-label="Seleccionar ${escape(node.title)}" ${disabled ? 'disabled' : ''} ${already ? 'checked' : ''}>` : '';
    const status=picker && other ? `Responsable: ${memberName(node.assignedTo)}` : already ? 'Seleccionada' : iterationName(node.iterationPath);
    const contents=`${controls}<div class="leaf-copy"><div class="leaf-meta">${type}<span>#${node.id}</span>${node.modified ? '<span class="pill changed">Editada</span>' : ''}</div>${picker ? `<span class="leaf-title">${escape(node.title)}</span>` : `<button class="leaf-title" data-action="edit" data-task="${node.id}">${escape(node.title)}</button>`}<span class="leaf-status">${escape(status)}${!picker && node.assignedTo ? ` · ${escape(memberName(node.assignedTo))}` : ''}</span></div><span class="effort">${effort}</span>${picker ? '' : peopleButton}`;
    const leaf=picker ? `<label class="hierarchy-leaf ${disabled ? 'unavailable' : ''}">${contents}</label>` : `<div class="hierarchy-leaf" draggable="true" data-drag-task="${node.id}">${contents}</div>`;
    return leaf + (node.children.length ? `<div class="hierarchy-children">${node.children.map(child=>nodeHtml(child,depth+1)).join('')}</div>` : '');
  }
  return roots.map(node=>nodeHtml(node,0)).join('') || `<div class="empty-result">${picker ? 'Sin tareas para esta persona. Reparte una rama en el paso 1.' : 'No hay tareas para esta selección. Cambia el filtro o reparte una rama entre personas.'}</div>`;
}
function hierarchyView() {
  return `<section class="hierarchy-surface"><div class="hierarchy-toolbar"><input class="search" id="search" aria-label="Buscar en el backlog" placeholder="Buscar rama o tarea" value="${escape(query)}"><select id="backlog-filter" aria-label="Filtrar backlog"><option value="all" ${backlogFilter==='all' ? 'selected' : ''}>Todo el backlog</option><option value="unshared" ${backlogFilter==='unshared' ? 'selected' : ''}>Sin personas</option></select><button class="button small" data-action="expand-tree">Expandir</button><button class="button small" data-action="collapse-tree">Plegar</button></div><div id="hierarchy-content">${treeView()}</div></section>`;
}
function editParticipants(id,anchor) {
  if(peopleItem===id && peoplePopover.matches(':popover-open')) {peoplePopover.hidePopover();return;}
  peopleItem=id;peopleQuery='';
  peopleAnchor=anchor || document.querySelector(`.people-button[data-task="${id}"]`) || $('#connection-button');
  document.querySelectorAll('[aria-controls="people-popover"]').forEach(el=>el.setAttribute('aria-expanded',String(el===peopleAnchor)));
  peopleRect=peopleAnchor.getBoundingClientRect();
  peoplePopover.innerHTML='<input id="people-search" aria-label="Buscar personas" placeholder="Buscar persona…" autocomplete="off"><div id="people-options"></div>';
  refreshPeople();
  peoplePopover.showPopover();positionPeople();$('#people-search').focus();
}
function positionPeople() {
  if(!peopleItem)return;
  const anchor=document.querySelector(`.people-button[data-task="${peopleItem}"]`);
  if(anchor)peopleRect=anchor.getBoundingClientRect();
  const width=Math.min(310,window.innerWidth-24), maxHeight=Math.min(350,window.innerHeight-24);
  peoplePopover.style.width=`${width}px`;peoplePopover.style.maxHeight=`${maxHeight}px`;
  peoplePopover.style.left=`${Math.max(12,Math.min(peopleRect.right-width,window.innerWidth-width-12))}px`;
  const height=Math.min(peoplePopover.scrollHeight,maxHeight);
  peoplePopover.style.top=`${Math.max(12,Math.min(peopleRect.bottom+6,window.innerHeight-height-12))}px`;
}
function refreshPeople() {
  if(!peopleItem)return;
  const ws=state.workspace,item=ws.effectiveItems.find(i=>i.id===peopleItem);
  if(!item){peoplePopover.hidePopover();return;}
  const sources=participantSources(item,ws,planningTree());
  const members=ws.members.filter(m=>`${m.displayName} ${key(m)}`.toLowerCase().includes(peopleQuery.toLowerCase()));
  $('#people-options').innerHTML=members.map(m=>{
    const inherited=(sources.get(key(m)) || []).find(s=>s.inherited);
    return `<label class="person-option"><input type="checkbox" data-participant="${escape(key(m))}" ${sources.has(key(m)) ? 'checked' : ''}><span class="avatar">${escape(initials(m.displayName))}</span><span>${escape(m.displayName)}${inherited ? `<small>Heredado de #${inherited.id}</small>` : ''}</span></label>`;
  }).join('') || '<p class="empty-result">Sin coincidencias</p>';
}
function ensureSelection() {
  const ws=state.workspace;
  if(!ws.members.some(m=>key(m)===pickerMember))pickerMember=ws.members[0] ? key(ws.members[0]) : '';
}
function choosePerson(member) {
  if(!state.workspace.members.some(m=>key(m)===member))return;
  pickerMember=member;focusedMember=member;pickerQuery='';tab='planning';render();
}
function pickTasks(member) {
  modal.close();
  pickerMember=state.workspace.members.some(m=>key(m)===member) ? member : focusedMember || pickerMember;
  tab='planning';ensureSelection();render();
}
function personMeter(member) {
  const summary=selectionSummary(state.workspace,key(member),selectedIteration);
  const meter=capacityStatus(summary);
  const label=meter.status==='over' ? `Exceso: ${number(meter.hours-meter.capacity)} h` : meter.status==='full' ? 'Horas cubiertas' : meter.status==='zero' ? 'Sin capacidad' : meter.status==='unknown' ? (meter.capacity===null ? 'Capacidad sin definir' : `${meter.unknown} sin estimar`) : `${number(meter.capacity-meter.hours)} h libres`;
  return `<span class="person-hours">${number(meter.hours)} h${meter.capacity===null ? '' : ` / ${number(meter.capacity)} h`}</span><span class="person-meter meter-${meter.status}" role="meter" aria-label="Carga de ${escape(member.displayName)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(meter.percent)}" aria-valuetext="${escape(label)}"><span style="width:${meter.percent}%"></span></span><span class="person-load-label meter-text-${meter.status}">${escape(label)}</span>`;
}
function plannerView() {
  ensureSelection();const ws=state.workspace,iteration=selected();
  if(!iteration || !ws.members.length)return '<div class="empty-result">Importa un equipo con integrantes e iteraciones para planificar.</div>';
  return `<div class="continuous-planner"><div class="planning-people" aria-label="Personas del equipo">${ws.members.map((m,index)=>`<button class="planning-person ${key(m)===pickerMember ? 'active' : ''}" data-action="choose-person" data-member="${escape(key(m))}" aria-pressed="${key(m)===pickerMember}"><span class="person-name"><span class="avatar c${index%4}">${escape(initials(m.displayName))}</span><strong>${escape(m.displayName)}</strong></span>${personMeter(m)}</button>`).join('')}</div><section class="planning-work"><div class="planning-work-heading"><h2>${escape(memberName(pickerMember))}</h2><input id="picker-search" placeholder="Buscar tarea o rama" aria-label="Buscar tareas de esta persona" value="${escape(pickerQuery)}"><label class="show-unavailable"><input id="show-unavailable" type="checkbox" ${onlyAvailable ? '' : 'checked'}>Con otro responsable</label></div><div class="picker-toolbar"><label class="bulk-selection"><input id="toggle-visible" type="checkbox">Marcar visibles</label><span class="local-note">Guardado automático en local</span></div><div id="picker-tree">${treeView({picker:true,member:pickerMember,search:pickerQuery})}</div></section></div>`;
}
function updateBulkCheckbox() {
  const boxes=[...document.querySelectorAll('#picker-tree input[name="taskIds"]:not(:disabled)')], toggle=$('#toggle-visible');
  if(!toggle)return;
  const count=boxes.filter(el=>el.checked).length;
  toggle.checked=boxes.length>0 && count===boxes.length;toggle.indeterminate=count>0 && count<boxes.length;toggle.disabled=!boxes.length;
}
function refreshPicker() {
  $('#picker-tree').innerHTML=treeView({picker:true,member:pickerMember,search:pickerQuery});updateBulkCheckbox();
}
function renderSaved(focusId) {
  const scroll=$('#picker-tree')?.scrollTop || 0;
  render();
  if($('#picker-tree'))$('#picker-tree').scrollTop=scroll;
  if(focusId)document.querySelector(`input[name="taskIds"][value="${focusId}"]`)?.focus({preventScroll:true});
  if(peopleItem){refreshPeople();positionPeople();}
}
async function saveTaskSelection(ids,selected) {
  await request('/api/task-selection',{member:pickerMember,iterationId:selectedIteration,ids,selected});
  renderSaved(ids.length===1 ? ids[0] : null);
}
async function saveParticipation(id,member,selected) {
  await request('/api/participation',{id,member,selected,iterationId:selectedIteration || undefined});renderSaved();
}
function updatePlanningView() {
  const iteration=selected();
  $('#planning-view').innerHTML=tab==='planning' ? plannerView() : tab==='hierarchy' ? hierarchyView() : tab==='list' ? table() : iteration ? board(iteration,state.workspace.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath===iteration.path)) : hierarchyView();
  updateBulkCheckbox();
}

function taskCard(item, inBacklog = false) {
  const effort = item.remainingWork !== null ? `${number(item.remainingWork)} h` : item.points !== null ? `${number(item.points)} pts` : 'Sin estimar';
  return `<article class="task-card ${item.modified ? 'modified' : ''}" draggable="true" data-task="${item.id}" data-action="edit" tabindex="0" role="button" aria-label="Editar #${item.id}: ${escape(item.title)}">
    <div class="task-meta"><span class="type-icon ${item.type === 'Bug' ? 'bug' : ''}">${item.type === 'Bug' ? '◆' : '▣'}</span><span>#${item.id}</span><span>· ${escape(item.type)}</span>${item.modified ? '<span class="pill changed">Editada</span>' : ''}</div>
    <p class="task-title">${escape(item.title)}</p>
    <div class="task-footer"><div class="task-tags">${item.tags.slice(0,2).map(t=>`<span class="tag">${escape(t)}</span>`).join('')}${item.priority === 1 ? '<span class="tag" style="background:#fceee3;color:#a6743e">P1</span>' : ''}</div><span class="effort">${effort}</span></div>
    ${inBacklog && item.iterationPath !== state.workspace.settings.backlogIteration.path ? `<div class="local-note">${escape(iterationName(item.iterationPath))}</div>` : ''}
  </article>`;
}
function lane(member, allItems, index, iteration) {
  const owned = allItems.filter(i => i.assignedTo === key(member));
  const hours = owned.reduce((sum,i) => sum + (i.remainingWork || 0),0);
  const capacity = state.workspace.capacityHours[iteration.id]?.[member.id] ?? null;
  const unknown = owned.filter(i=>i.canEstimateHours && i.remainingWork === null).length;
  const percent = capacity === null ? 0 : capacity === 0 ? (hours > 0 ? 100 : 0) : Math.min(100, Math.round(hours / capacity * 100));
  return `<section class="member" data-drop="${escape(key(member))}"><div class="member-header"><div class="person"><span class="avatar c${index % 4}">${escape(initials(member.displayName))}</span><div class="person-detail"><h3>${escape(member.displayName)}</h3><p>${owned.length} ${owned.length === 1 ? 'tarea' : 'tareas'} en la iteración</p></div></div><div class="capacity-line ${capacity !== null && hours > capacity ? 'over' : ''}"><span>${number(hours)} h ${unknown ? `+ ${unknown} sin estimar` : 'planificadas'}</span><span>${capacity === null ? 'Capacidad sin definir' : `${number(capacity)} h disponibles`}</span></div><div class="capacity-track" role="meter" aria-label="Carga de ${escape(member.displayName)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${number(hours)} horas planificadas; capacidad ${capacity === null ? 'desconocida' : number(capacity)}"><div class="capacity-fill" style="--load:${percent}%"></div></div></div><div class="lane-picker"><button class="button small" data-action="pick-tasks" data-member="${escape(key(member))}">+ Elegir sus tareas y bugs</button></div><div class="member-items">${filtered(owned).map(i=>taskCard(i)).join('') || '<div class="drop-hint">Arrastra una tarea aquí<br>o ábrela para asignarla</div>'}</div></section>`;
}
function board(iteration, planned) {
  const ws = state.workspace, backlog = ws.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath !== iteration.path);
  const eligible = new Set(focusedMember ? eligibleTasks(ws,focusedMember).map(i=>i.id) : []);
  const unassigned = planned.filter(i=>!i.assignedTo && (!focusedMember || eligible.has(i.id)));
  const outside = planned.filter(i=>(!focusedMember || eligible.has(i.id)) && i.assignedTo && !ws.members.some(m=>key(m) === i.assignedTo));
  return `<div class="board"><section class="backlog" data-drop="backlog"><div class="section-heading"><h2>Backlog disponible</h2><span class="count">${backlog.length}</span></div><p class="section-meta">Pendientes y tareas de otras iteraciones</p>${treeView({availableOnly:true})}</section><section><div class="section-heading"><h2>Plan de la iteración</h2><span class="count">${planned.length} tareas</span></div><p class="section-meta">Reparte el trabajo según la capacidad del equipo</p><div class="members-grid">${ws.members.filter(m=>!focusedMember || key(m)===focusedMember).map((m,index)=>lane(m,planned,index,iteration)).join('')}<section class="member" data-drop=""><div class="member-header"><div class="section-heading"><h3>Sin asignar</h3><span class="count">${unassigned.length}</span></div><p class="section-meta" style="margin:0">Dentro de esta iteración</p></div><div class="member-items">${filtered(unassigned).map(i=>taskCard(i)).join('') || '<div class="drop-hint">Reserva trabajo para esta iteración</div>'}</div></section>${outside.length ? `<section class="member"><div class="member-header"><h3>Otras personas</h3><p class="section-meta" style="margin:0">Responsables que no figuran en este equipo</p></div><div class="member-items">${filtered(outside).map(i=>taskCard(i)).join('')}</div></section>` : ''}</div></section></div><p class="bottom-note">Arrastra tareas para planificar. Pulsa una tarjeta para editar con teclado o en móvil. Las horas y los puntos se mantienen separados.</p>`;
}
function table() {
  const eligible = new Set(focusedMember ? eligibleTasks(state.workspace,focusedMember).map(i=>i.id) : []);
  const items = filtered(state.workspace.effectiveItems.filter(i=>!focusedMember || eligible.has(i.id)));
  return `<div class="table-wrap"><table><thead><tr><th>TAREA</th><th>RESPONSABLE</th><th>ITERACIÓN</th><th>ESTADO</th><th>ESFUERZO</th><th></th></tr></thead><tbody>${items.map(item=>`<tr><td><span class="text-muted">#${item.id} · ${escape(item.type)}</span>${item.modified ? ' <span class="pill changed">Editada</span>' : ''}<span class="table-title">${escape(item.title)}</span></td><td>${escape(memberName(item.assignedTo))}</td><td>${escape(iterationName(item.iterationPath))}</td><td>${escape(item.state)}</td><td>${item.remainingWork !== null ? `${number(item.remainingWork)} h` : item.points !== null ? `${number(item.points)} pts` : '—'}</td><td><button class="button small" data-action="edit" data-task="${item.id}" aria-label="Editar tarea ${item.id}">Editar</button></td></tr>`).join('')}</tbody></table>${!items.length ? '<div class="empty-result">No hay tareas con estos filtros.</div>' : ''}</div>`;
}
function render() {
  const ws=state.workspace;
  $('#connection-button').textContent=state.config ? 'Configuración' : 'Conectar Azure DevOps';
  $('#save-status').textContent=ws ? 'Guardado en local' : '';
  if(!ws){
    $('#app').innerHTML=`<div class="empty-panel"><h1>Planifica tu iteración</h1><button class="button primary" data-action="${state.config ? 'import' : 'connect'}">${state.config ? 'Importar equipo' : 'Conectar Azure DevOps'}</button><button class="button" data-action="demo">Probar con un ejemplo</button></div>`;return;
  }
  if(focusedMember && !ws.members.some(m=>key(m)===focusedMember))focusedMember='';
  const iteration=selected();ensureSelection();
  const changes=Object.keys(ws.drafts).length;
  $('#app').innerHTML=`<div class="workspace-controls"><span class="team-label">${escape(ws.config.project)} / ${escape(ws.config.team)}</span>${ws.mode==='demo' ? '<span class="pill demo">Ejemplo</span>' : ''}<select id="iteration-select" class="iteration-select" aria-label="Iteración">${ws.iterations.map(i=>`<option value="${escape(i.id)}" ${i.id===selectedIteration ? 'selected' : ''}>${escape(i.name)}</option>`).join('')}</select><details class="workspace-menu"><summary aria-label="Más opciones">···</summary><div>${ws.mode==='demo' ? '<button data-action="azure">Salir del ejemplo</button>' : `<button data-action="import" ${changes ? 'disabled' : ''}>Actualizar datos</button>`}<button data-action="tab" data-tab="board">Vista del equipo</button><button data-action="tab" data-tab="list">Todas las tareas</button><a href="/api/export" download>Exportar</a>${changes ? '<button data-action="discard-all">Descartar cambios</button>' : ''}</div></details></div>
  <nav class="step-tabs" aria-label="Pasos de planificación"><button class="step-tab ${tab==='hierarchy' ? 'active' : ''}" data-action="tab" data-tab="hierarchy" ${tab==='hierarchy' ? 'aria-current="step"' : ''}><span>1</span>Repartir ramas</button><button class="step-tab ${tab==='planning' ? 'active' : ''}" data-action="tab" data-tab="planning" ${tab==='planning' ? 'aria-current="step"' : ''}><span>2</span>Elegir tareas</button><button class="step-tab" data-action="review" ${changes ? '' : 'disabled'}><span>3</span>Revisar${changes ? ` <small>${changes}</small>` : ''}</button></nav>
  <div id="planning-view">${tab==='planning' ? plannerView() : tab==='hierarchy' ? hierarchyView() : tab==='list' ? table() : iteration ? board(iteration,ws.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath===iteration.path)) : hierarchyView()}</div>
  ${ws.warnings.length ? `<details class="import-notices"><summary>${ws.warnings.length} avisos de importación</summary>${ws.warnings.map(w=>`<p>${escape(w)}</p>`).join('')}</details>` : ''}`;
  updateBulkCheckbox();
}
function editTask(id) {
  const ws = state.workspace, item = ws.effectiveItems.find(i=>i.id === id);
  if (!item) throw new Error('La tarea ya no está disponible.');
  if (!isExecutable(item)) { editParticipants(id); return; }
  const paths = [{ path:ws.settings.backlogIteration.path, name:'Backlog' },...ws.iterations];
  if (!paths.some(i=>i.path === item.iterationPath)) paths.push({ path:item.iterationPath, name:item.iterationPath });
  showModal(`#${id} · ${item.type}`, item.title, `<form id="task-form" data-task="${id}"><label class="form-field">Responsable<select name="assignedTo"><option value="">Sin asignar</option>${ws.members.map(m=>`<option value="${escape(key(m))}" ${key(m) === item.assignedTo ? 'selected' : ''}>${escape(m.displayName)}</option>`).join('')}${item.assignedTo && !ws.members.some(m=>key(m) === item.assignedTo) ? `<option value="${escape(item.assignedTo)}" selected>${escape(item.assigneeName || item.assignedTo)} (fuera del equipo)</option>` : ''}</select></label><label class="form-field">Iteración<select name="iterationPath">${paths.map(i=>`<option value="${escape(i.path)}" ${item.iterationPath === i.path ? 'selected' : ''}>${escape(i.name)}</option>`).join('')}</select></label><div class="grid2">${item.canPrioritize ? `<label class="form-field">Prioridad<select name="priority">${[1,2,3,4].map(p=>`<option value="${p}" ${item.priority === p ? 'selected' : ''}>P${p} · ${['Crítica','Alta','Media','Baja'][p-1]}</option>`).join('')}</select></label>` : ''}${item.canEstimateHours ? `<label class="form-field">Horas pendientes<input name="remainingWork" type="number" min="0" max="100000" step="0.25" value="${item.remainingWork ?? ''}" placeholder="Sin estimar"><small>Se guardan como trabajo restante.</small></label>` : `<div class="form-field">Estimación<span class="text-muted">${item.points !== null ? `${number(item.points)} puntos` : 'Sin estimar'} · consulta</span></div>`}</div><div class="notice">${ws.mode === 'demo' ? 'Datos de ejemplo. Puedes probar los cambios sin afectar a Azure DevOps.' : 'Este cambio se guarda en local. Se enviará cuando revises y confirmes la sincronización.'}</div></form>`, `${item.modified ? `<button class="button danger" data-action="discard-one" data-task="${id}">Deshacer cambios</button>` : '<button class="button" data-action="close">Cancelar</button>'}<button class="button primary" type="submit" form="task-form">Guardar en local</button>`);
}
async function stage(id, changes) {
  await request('/api/stage', { edits:[{ id, changes }] }); review = null; render();
}
async function reviewChanges() {
  showModal('Revisar cambios', 'Comprobando la última versión de cada tarea.', '<p class="busy-note"><span class="spinner"></span> Consultando las tareas… Completa el acceso de Microsoft si se solicita.</p>');
  const result = await request('/api/review'); review = result.review; render(); renderReview();
}
function renderReview() {
  const conflicts = review.plans.filter(p=>p.conflicts.length);
  showModal(state.mode === 'demo' ? 'Simular sincronización' : 'Revisar y sincronizar', `${review.plans.length} tareas · ${state.mode === 'demo' ? 'datos de ejemplo' : 'comparadas con la versión actual de Azure DevOps'}`, `${conflicts.length ? '<div class="notice warning" style="margin-bottom:20px">Algunas tareas han cambiado en Azure DevOps. Elige qué versión conservar y vuelve a revisar antes de sincronizar.</div>' : ''}${review.plans.map(p=>`<section class="review-item"><h3>#${p.id} · ${escape(p.title)}</h3>${p.changes.map(c=>`<div class="change-row"><span class="change-label">${escape(c.label)}</span><span class="change-old">${escape(pretty(c.field,c.before))}</span><span>→</span><span class="change-new">${escape(pretty(c.field,c.after))}${c.conflict ? ' ⚠' : ''}</span></div>`).join('')}${p.conflicts.length ? `<p class="local-note">La versión remota ha cambiado desde tu importación.</p><div class="conflict-actions"><button class="button small" data-action="resolve-remote" data-task="${p.id}">Conservar versión de Azure</button><button class="button small" data-action="resolve-local" data-task="${p.id}">Mantener mis cambios</button></div>` : ''}${!Object.keys(p.updates).length ? '<p class="local-note">Estos valores ya están aplicados. Se actualizará la copia local.</p>' : ''}</section>`).join('')}`, `<button class="button" data-action="close">Seguir planificando</button>${review.token ? `<button class="button primary" data-action="sync">${state.mode === 'demo' ? 'Confirmar simulación' : 'Sincronizar con Azure DevOps'} ↗</button>` : ''}`);
}
async function synchronize() {
  const data = await request('/api/sync', { token:review.token }); review = null; render();
  const result = data.result;
  showModal(result.failures.length ? 'Sincronización parcial' : result.demo ? 'Simulación completada' : 'Cambios sincronizados', `${result.successes.length} tareas confirmadas${result.demo ? ' en el ejemplo local' : ' en Azure DevOps'}.`, `${result.failures.length ? `<div class="notice warning">Los cambios pendientes se conservan en local. Vuelve a revisarlos para reintentar solo lo que falta.</div>${result.failures.map(f=>`<p class="inline-error" style="margin-top:15px">#${f.id}: ${escape(f.error)}</p>`).join('')}` : `<div class="notice">${result.demo ? 'La simulación solo ha actualizado los datos de ejemplo de este equipo.' : 'La copia local refleja los cambios confirmados por Azure DevOps.'}</div>`}`, `${result.failures.length ? '<button class="button primary" data-action="review">Revisar pendientes</button>' : '<button class="button primary" data-action="close">Volver a la planificación</button>'}`);
}
async function importData() {
  showModal('Actualizar desde Azure DevOps', 'Leyendo el equipo y sus tareas.', '<p class="busy-note"><span class="spinner"></span> Importando integrantes, backlog, iteraciones y capacidad… En equipos grandes puede tardar varios minutos.</p>');
  await request('/api/import'); modal.close(); render(); toast('Datos actualizados desde Azure DevOps.');
}
const actions = {
  connect: connection, close: () => modal.close(), projects:()=>lookup('projects'), teams:()=>lookup('teams'), 'save-config':()=>saveConfig(false),
  demo: async()=>{ await request('/api/mode',{ mode:'demo' }); selectedIteration=''; render(); },
  azure: async()=>{ await request('/api/mode',{ mode:'azure' }); selectedIteration=''; render(); },
  import: importData,
  edit: el=>editTask(Number(el.dataset.task)),
  participants: el=>editParticipants(Number(el.dataset.task),el),
  'remove-branch': el=>saveParticipation(Number(el.dataset.task),pickerMember,false),
  'pick-tasks': el=>pickTasks(el.dataset.member),
  'choose-person': el=>choosePerson(el.dataset.member),
  'go-sharing': ()=>{tab='hierarchy';focusedMember='';query='';backlogFilter='all';render();},
  'expand-tree': ()=>{collapsed.clear();updatePlanningView();},
  'collapse-tree': ()=>{state.workspace.items.filter(i=>!isExecutable(i)).forEach(i=>collapsed.add(i.id));updatePlanningView();},
  tab: el=>{tab=el.dataset.tab;if(tab==='planning' && focusedMember)pickerMember=focusedMember;render();},
  review: reviewChanges, sync:synchronize,
  'discard-all':()=>showModal('Descartar cambios locales', 'Esta acción afecta al borrador de la planificación actual.', '<p>Se recuperarán los valores de la última importación o sincronización. Azure DevOps no se modificará.</p>','<button class="button" data-action="close">Cancelar</button><button class="button danger" data-action="confirm-discard">Descartar borrador</button>'),
  'confirm-discard':async()=>{await request('/api/discard');modal.close();render();toast('Borrador descartado.');},
  'discard-one':async el=>{await request('/api/discard',{id:Number(el.dataset.task)});modal.close();render();toast('Cambios de la tarea deshechos.');},
  'resolve-local':el=>resolveTask(Number(el.dataset.task),'local'),
  'resolve-remote':el=>resolveTask(Number(el.dataset.task),'remote'),
};
async function resolveTask(id,choice) {
  await request('/api/resolve',{id,choice}); render();
  if (Object.keys(state.workspace.drafts).length) await reviewChanges();
  else { modal.close(); toast('Se ha conservado la versión de Azure DevOps.'); }
}
$('#connection-button').onclick = () => { if (state && !pending) connection(); };
modal.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
document.addEventListener('click', async event => {
  const target = event.target.closest('[data-action]');
  if (!target || pending || target.disabled) return;
  if (target.closest('summary')) event.preventDefault();
  const action = actions[target.dataset.action];
  if (!action) return;
  try { await action(target); } catch (error) { errorInModal(error); }
});
document.addEventListener('keydown', event => {
  const card = event.target.closest('.task-card');
  if (card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (!pending) editTask(Number(card.dataset.task)); }
  const tabButton = event.target.closest('[role="tab"]');
  if (tabButton && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const tabs=['hierarchy','planning','board','list']; tab=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:3))%4]; render(); $(`[data-tab="${tab}"]`).focus(); }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return;
  try {
    if (event.target.id === 'connection-form') await saveConfig(true);
    if (event.target.id === 'task-form') {
      const values = Object.fromEntries(new FormData(event.target));
      if ('priority' in values) values.priority = Number(values.priority);
      if ('remainingWork' in values) { if (values.remainingWork === '') delete values.remainingWork; else values.remainingWork = Number(values.remainingWork); }
      await stage(Number(event.target.dataset.task),values); modal.close(); toast('Tarea guardada en local.');
    }
  } catch (error) { errorInModal(error); }
});
document.addEventListener('change',async event=>{
  const el=event.target;
  try {
    if(el.dataset.participant){const member=el.dataset.participant;await saveParticipation(peopleItem,member,el.checked);[...peoplePopover.querySelectorAll('input[data-participant]')].find(box=>box.dataset.participant===member)?.focus({preventScroll:true});return;}
    if(el.name==='taskIds'){await saveTaskSelection([Number(el.value)],el.checked);return;}
    if(el.id==='toggle-visible'){
      const ids=[...document.querySelectorAll('#picker-tree input[name="taskIds"]:not(:disabled)')].filter(box=>box.checked!==el.checked).map(box=>Number(box.value));
      if(ids.length>200)throw new Error('Selecciona un máximo de 200 tareas por operación.');
      if(ids.length)await saveTaskSelection(ids,el.checked);return;
    }
    if(el.id==='show-unavailable'){onlyAvailable=!el.checked;refreshPicker();}
    if(el.id==='backlog-filter'){backlogFilter=el.value;focusedMember='';render();}
    if(el.id==='iteration-select'){selectedIteration=el.value;render();}
  }catch(error){renderSaved();errorInModal(error);}
});
document.addEventListener('input',event=>{
  if(event.target.id==='people-search'){peopleQuery=event.target.value;refreshPeople();positionPeople();}
  if(event.target.id==='picker-search'){pickerQuery=event.target.value;refreshPicker();}
  if(event.target.id==='search'){query=event.target.value;updatePlanningView();}
});
peoplePopover.addEventListener('toggle',event=>{if(event.newState==='closed'){peopleItem=null;document.querySelectorAll('[aria-controls="people-popover"]').forEach(el=>el.setAttribute('aria-expanded','false'));}});
window.addEventListener('resize',()=>{if(peopleItem)positionPeople();});
document.addEventListener('toggle',event=>{
  const element=event.target;
  if (!element.matches?.('details[data-node]') || element.closest('#picker-tree')) return;
  if(element.open)collapsed.delete(Number(element.dataset.node));else collapsed.add(Number(element.dataset.node));
},true);
document.addEventListener('dragstart', event => {
  const card=event.target.closest('.task-card, [data-drag-task]'); if (!card || pending) return event.preventDefault();
  event.dataTransfer.setData('application/x-neo-task',card.dataset.task || card.dataset.dragTask); event.dataTransfer.effectAllowed='move';
});
document.addEventListener('dragover', event => {
  const zone=event.target.closest('[data-drop]'); if (!zone || pending || !event.dataTransfer.types.includes('application/x-neo-task')) return;
  event.preventDefault(); event.dataTransfer.dropEffect='move'; zone.classList.add('drop-active');
});
document.addEventListener('dragleave', event => { const zone=event.target.closest('[data-drop]'); if (zone && !zone.contains(event.relatedTarget)) zone.classList.remove('drop-active'); });
document.addEventListener('dragend',()=>document.querySelectorAll('.drop-active').forEach(el=>el.classList.remove('drop-active')));
document.addEventListener('drop',async event => {
  const zone=event.target.closest('[data-drop]'); if (!zone || pending) return;
  event.preventDefault();zone.classList.remove('drop-active');
  const id=Number(event.dataTransfer.getData('application/x-neo-task')); if (!id) return;
  const target=zone.dataset.drop, iteration=selected();
  if (!iteration) return;
  try { await stage(id,target === 'backlog' ? {iterationPath:state.workspace.settings.backlogIteration.path} : {assignedTo:target,iterationPath:iteration.path});toast('Planificación guardada en local.'); } catch(error){toast(error.message);}
});

// Optional WebMCP access shares the same local staging path as the UI.
const lifecycle=new AbortController();
async function registerTools() {
  if (!document.modelContext?.registerTool) return;
  const tools=[{
    name:'neo_read_plan',title:'Leer planificación local',description:'Read imported work items, team members, iterations and local drafts. Does not contact Azure DevOps.',
    inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},
    execute:async input=>{if (input && Object.keys(input).length) throw new Error('No se aceptan parámetros.');await loadState();return {mode:state.mode,workspace:state.workspace};},
  },{
    name:'neo_stage_tasks',title:'Preparar cambios locales',description:'Stage assignments, iteration paths, priorities or remaining hours in the local draft. Does not synchronize with Azure DevOps; use the visible review to confirm synchronization.',
    inputSchema:{type:'object',properties:{edits:{type:'array',minItems:1,maxItems:200,items:{type:'object',properties:{id:{type:'integer',minimum:1},changes:{type:'object',minProperties:1,properties:{assignedTo:{type:'string'},iterationPath:{type:'string'},priority:{type:'integer',minimum:1,maximum:4},remainingWork:{type:'number',minimum:0}},additionalProperties:false}},required:['id','changes'],additionalProperties:false}}},required:['edits'],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:true},
    execute:async input=>{if (!input || Object.keys(input).some(k=>k!=='edits')) throw new Error('Formato no válido.');await request('/api/stage',{edits:input.edits});render();return {pendingTasks:Object.keys(state.workspace.drafts).length};},
  }];
  for (const tool of tools) { try { await document.modelContext.registerTool(tool,{signal:lifecycle.signal}); } catch { /* Browsers without stable WebMCP still use the complete UI. */ } }
}
window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
loadState().then(registerTools).catch(error=>{
  $('#app').innerHTML=`<div class="notice error">${escape(error.message)} Recarga esta página cuando el servidor local esté disponible.</div>`;
});
