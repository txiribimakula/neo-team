import { permissionsView, filterPermissions, filterGroups, resetPermissionFilters } from './permissions.js';
import { maintenanceView, filterMaintenance } from './maintenance.js';
import { hierarchy, ancestors, participantSources, eligibleTasks, filterHierarchy, isExecutable, typeRank, selectionSummary, capacityStatus, orderedPlanningMembers, hasPlanningCapacity, previousIteration, completedState, isCompleted } from './hierarchy.js';
const $ = (selector, parent = document) => parent.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const key = member => (member.uniqueName || member.id || member.displayName || '').toLowerCase();
const number = value => new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(value);
const initials = name => name.trim().split(/\s+/).slice(0,2).map(s => s[0]).join('').toUpperCase();
const date = value => value ? new Date(value).toLocaleDateString('es', { day:'numeric', month:'short', timeZone:'UTC' }) : 'Sin fecha';
let securitySnapshot = null, maintenanceSnapshot = null, maintenanceSetup = null;
let state, selectedIteration = '', tab = 'home', query = '', pending = false, review, toastTimer;
let focusedMember='', pickerMember='', pickerQuery='', onlyAvailable=true, backlogFilter='all';
let peopleItem=null,peopleAnchor=null,peopleRect=null,peopleQuery='';
const peoplePopover=$('#people-popover');
const collapsed = new Set();
const modal = $('#modal');
// Measure real row heights so wrapped parent titles never overlap.
let stickyFrame;
function layoutStickyHierarchy() {
  cancelAnimationFrame(stickyFrame);
  stickyFrame=requestAnimationFrame(()=>{
    const assigneeHeight=$('.active-assignee')?.getBoundingClientRect().height || 0;
    const offsets=new Map();
    document.querySelectorAll('.hierarchy-branch').forEach(branch=>{
      const summary=branch.querySelector(':scope > summary');
      const parent=branch.parentElement.closest('.hierarchy-branch');
      const previous=offsets.get(parent);
      const top=previous?.bottom ?? (branch.closest('.planning-work') ? assigneeHeight : 0);
      const depth=previous ? previous.depth+1 : 0;
      const bottom=top+summary.getBoundingClientRect().height;
      summary.style.top=`${top}px`;
      summary.style.zIndex=String(Math.max(3,30-depth));
      branch.style.setProperty('--sticky-path-height',`${bottom+10}px`);
      offsets.set(branch,{bottom,depth});
    });
  });
}
const stickySizes=new ResizeObserver(layoutStickyHierarchy);
new MutationObserver(()=>{
  stickySizes.disconnect();
  document.querySelectorAll('.hierarchy-branch > summary, .planning-people, .active-assignee').forEach(el=>stickySizes.observe(el));
  layoutStickyHierarchy();
}).observe($('#app'),{childList:true,subtree:true});
document.addEventListener('toggle',layoutStickyHierarchy,true);
window.addEventListener('resize',layoutStickyHierarchy);
function pendingLabel(item) {return item.localOnly ? 'Nuevo · pendiente de sincronizar' : 'Pendiente de sincronizar';}
function savedStatus() {
  const count=Object.keys(state?.workspace?.drafts || {}).length+capacityDraftCount();
  return count ? `${count} pendiente${count===1 ? '' : 's'} de sincronizar` : 'Sin cambios pendientes';
}
function createItem(parentId) {
  const ws=state.workspace,parent=ws.effectiveItems.find(i=>i.id===parentId);
  const type=parent ? ({Epic:'Feature',Feature:'User Story','User Story':'Task','Product Backlog Item':'Task',Requirement:'Task'})[parent.type] || 'Task' : 'Epic';
  showModal('Crear elemento','Se guardará en local hasta revisar y sincronizar.',`<form id="create-form">${ws.sources && !parent ? `<label class="form-field">Proyecto<select name="sourceId" required>${ws.sources.map(s=>`<option value="${escape(s.id)}">${escape(s.config.project)}</option>`).join('')}</select></label>` : ''}<label class="form-field">Tipo<select name="type" id="create-type">${['Epic','Feature','User Story','Task','Bug'].map(t=>`<option ${t===type ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label class="form-field">Título<input name="title" required maxlength="255" autofocus></label><label class="form-field">Padre<select name="parent" id="create-parent"></select></label><label class="form-field">Responsable<select name="assignedTo"><option value="">Sin asignar</option>${ws.members.map(m=>`<option value="${escape(key(m))}" ${tab==='planning' && key(m)===pickerMember ? 'selected' : ''}>${escape(m.displayName)}</option>`).join('')}</select></label><label class="form-field">Iteración<select name="iterationPath">${[{path:ws.settings.backlogIteration.path,name:'Backlog'},...planningIterations()].map(i=>`<option value="${escape(i.path)}" ${tab==='planning' && i.id===selectedIteration ? 'selected' : ''}>${escape(i.name)}</option>`).join('')}</select></label><label class="form-field" id="create-hours">Horas pendientes<input name="remainingWork" type="number" min="0" max="100000" step="0.25" placeholder="Sin estimar"></label></form>`,'<button class="button" data-action="close">Cancelar</button><button class="button primary" form="create-form" type="submit">Crear en local</button>');
  restrictAssignees($('#create-form [name="assignedTo"]'));
  updateCreationParents(parentId);
}
function updateCreationParents(parentId) {
  const type=$('#create-type').value,allowed={Epic:[],Feature:['Epic'],'User Story':['Feature'],Task:['User Story','Product Backlog Item','Requirement'],Bug:['User Story','Product Backlog Item','Requirement']}[type];
  $('#create-parent').innerHTML='<option value="">'+(type==='Epic' ? 'Sin padre' : 'Selecciona el padre')+'</option>'+state.workspace.effectiveItems.filter(i=>allowed.includes(i.type)).map(i=>`<option value="${i.id}" ${i.id===parentId ? 'selected' : ''}>${i.project ? escape(i.project)+' · ' : ''}${escape(i.title)} · ${i.localOnly ? 'nuevo' : '#'+i.id}</option>`).join('');
  $('#create-parent').required=type!=='Epic';$('#create-parent').disabled=type==='Epic';
  $('#create-hours').hidden=!['Task','Bug'].includes(type);
  $('#create-hours input').disabled=$('#create-hours').hidden;
}
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function errorInModal(error) {
  if (error.stateReview) { showStateReview(error.stateReview); return; }
  const target = $('#modal-error');
  if (modal.open && target) { target.textContent = error.message; target.hidden = false; }
  else toast(error.message);
}
async function request(path, input = {}) {
  if (pending) throw new Error('Espera a que termine la operación en curso.');
  pending = true;
  let recover = false;
  const enabled = [...document.querySelectorAll('button:not(:disabled):not([data-cancel-operation]), input:not(:disabled), select:not(:disabled)')];
  enabled.forEach(el => el.disabled = true);
  $('#save-status').textContent = 'Procesando…';
  try {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type':'application/json', 'X-Neo-CSRF': state.csrf }, body: JSON.stringify({ ...input, version: state.version }) })
      .catch(() => { throw new Error('Se perdió la conexión con el servidor local de Neo Team antes de recibir la respuesta. Si se ha detenido, revisa la terminal donde se ejecuta y el archivo .neo-team/last-error.json.'); });
    const data = await response.json().catch(() => { throw new Error(`El servidor local respondió sin datos válidos (HTTP ${response.status}).`); });
    if (!response.ok) {
      throw Object.assign(new Error(data.error || 'No se pudo completar la operación.'), { stateReview: data.stateReview, diagnostics: data.diagnostics });
    }
    if (data.state) state = data.state;
    else if (data.csrf) state = data;
    return data;
  } catch (error) {
    // Recover a server operation after a reload, another tab, or a lost response.
    await loadState(false).catch(() => {});
    recover = !!(state?.busy && state?.operation);
    if (state) render();
    throw error;
  } finally {
    pending = false; enabled.forEach(el => el.disabled = false);
    $('#save-status').textContent = savedStatus();
    if (recover) setTimeout(() => resumeOperation(), 0);
  }
}
async function loadState(renderNow = true) {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('No se pudo abrir el espacio local.');
  state = await response.json();
  if (renderNow) render();
}
function showModal(title, subtitle, body, actions = '') {
  modal.classList.remove('wide-modal', 'connection-modal', 'capacity-editor-modal');
  $('#modal-content').innerHTML = `<div class="modal-head"><div><h2 id="modal-title">${escape(title)}</h2><p>${escape(subtitle)}</p></div><button class="close" data-action="close" aria-label="Cerrar">×</button></div><div class="modal-body"><div class="inline-error" id="modal-error" role="alert" hidden></div>${body}</div><div class="modal-footer">${actions || '<button class="button" data-action="close">Cerrar</button>'}</div>`;
  if (!modal.open) modal.showModal();
}
let connectionPickerEvents = new AbortController();
function connection() {
  connectionPickerEvents.abort();
  connectionPickerEvents = new AbortController();
  const c = state.config || {};
  showModal('Importar proyecto', 'Añade un proyecto a la planificación conjunta. Los ya importados se conservan.', `
    <form id="connection-form">
      <label class="form-field">Organización<input name="organization" required maxlength="150" placeholder="mi-organizacion o https://dev.azure.com/mi-organizacion" value="${escape(c.organization)}" autocomplete="off"></label>
      <label class="form-field">Acceso<select name="authentication"><option value="interactive">Iniciar sesión con Microsoft</option><option value="azcli" ${c.authentication === 'azcli' ? 'selected' : ''}>Usar mi sesión de Azure CLI</option></select><small>Con Microsoft se abrirá tu navegador para iniciar sesión. La aplicación no solicita tu contraseña.</small></label>
      ${connectionField('project', 'Proyecto', c.project)}
      ${connectionField('team', 'Equipo', c.team)}
      <details><summary class="text-muted" style="font-size:14px;cursor:pointer;margin-bottom:14px">Opciones avanzadas</summary><label class="form-field">Tenant de Microsoft Entra (opcional)<input name="tenant" placeholder="Identificador del directorio" value="${escape(c.tenant)}"><small>Déjalo vacío para detectar el directorio de tu organización.</small></label></details>
      <div id="connection-progress" hidden></div>
      <div class="notice">Se importan tareas abiertas e iteraciones actuales y futuras. Los estados personalizados sin categoría se revisan antes de descargar las tareas. Las capacidades se definen una sola vez para todos los proyectos. Podrás preparar cambios en local y revisarlos antes de sincronizarlos.</div>
    </form>`, '<button class="button" data-action="save-config">Guardar configuración</button><button class="button primary" type="submit" form="connection-form">Conectar e importar ↙</button>');
  modal.classList.add('connection-modal');
  setupConnectionPickers();
}
function connectionField(name, label, value) {
  return `<div class="form-field connection-field" data-picker="${name}">
    <label for="${name}">${label}</label>
    <div class="connection-picker">
      <div class="connection-control">
        <input id="${name}" name="${name}" required maxlength="200" placeholder="Buscar o escribir ${label.toLowerCase()}…" value="${escape(value)}" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="${name}-options" aria-describedby="${name}-status">
        <span class="spinner" aria-hidden="true" hidden></span>
        <button class="connection-toggle" type="button" aria-label="Mostrar ${name === 'project' ? 'proyectos' : 'equipos'}" aria-controls="${name}-options" tabindex="-1">⌄</button>
      </div>
      <div class="connection-dropdown" hidden>
        <div id="${name}-options" class="connection-options" role="listbox" aria-label="${label}"></div>
        <p class="connection-empty" hidden></p>
        <button type="button" class="connection-refresh">Actualizar lista</button>
      </div>
    </div>
    <small id="${name}-status" class="connection-status" role="status" aria-live="polite"></small>
  </div>`;
}
const getConfig = () => Object.fromEntries(new FormData($('#connection-form')));
function setupConnectionPickers() {
  const form = $('#connection-form');
  const pickers = {};
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
  for (const name of ['project', 'team']) {
    const field = $(`[data-picker="${name}"]`, form), input = $('input', field);
    const dropdown = $('.connection-dropdown', field), list = $('[role="listbox"]', field);
    const note = $('.connection-status', field), toggle = $('.connection-toggle', field);
    const empty = $('.connection-empty', field), spinner = $('.spinner', field);
    const kind = name === 'project' ? 'projects' : 'teams';
    const plural = name === 'project' ? 'proyectos' : 'equipos';
    let items = null, visible = [], active = -1, loading = false;
    const message = (text, error = false) => {
      note.textContent = text;
      note.classList.toggle('error', error);
    };
    const close = () => {
      dropdown.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
      active = -1;
    };
    const highlight = index => {
      active = index;
      [...list.children].forEach((option, i) => option.classList.toggle('active', i === active));
      if (active < 0) input.removeAttribute('aria-activedescendant');
      else {
        input.setAttribute('aria-activedescendant', list.children[active].id);
        list.children[active].scrollIntoView({ block: 'nearest' });
      }
    };
    const open = (filter = '') => {
      Object.values(pickers).forEach(picker => picker.close());
      visible = (items || []).filter(item => normalize(item).includes(normalize(filter.trim())));
      list.innerHTML = visible.map((item, i) => `<div id="${name}-option-${i}" class="connection-option" role="option" aria-selected="${item === input.value}" data-index="${i}"><span>${escape(item)}</span>${item === input.value ? '<span aria-hidden="true">✓</span>' : ''}</div>`).join('');
      empty.hidden = visible.length > 0;
      empty.textContent = items?.length ? 'Sin coincidencias. Prueba otra búsqueda o escribe el nombre completo.' : `No se encontraron ${plural}. Puedes actualizar la lista o escribir el nombre completo.`;
      dropdown.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    const lookup = async () => {
      if (pending || loading) return;
      const organization = form.elements.organization;
      if (!organization.reportValidity()) return;
      if (name === 'team' && !pickers.project.input.reportValidity()) return;
      const config = getConfig();
      Object.values(pickers).forEach(picker => picker.close());
      loading = true;
      field.setAttribute('aria-busy', 'true');
      spinner.hidden = false;
      toggle.hidden = true;
      message(`Cargando ${plural}…`);
      const operationId = crypto.randomUUID();
      const stopFollowing = followOperation(operationId, progress => { if (loading) message(`Cargando ${plural}… ${activitySummary(progress)}`); });
      try {
        const data = await request(`/api/${kind}`, { config, operationId });
        items = [...new Set(data[kind].map(item => item.name))].sort((a, b) => a.localeCompare(b, 'es'));
        message(items.length ? `${items.length} ${plural} disponibles. Escribe para filtrar y selecciona uno.` : `No hay ${plural} disponibles. Comprueba el acceso o introduce el nombre manualmente.`);
        input.focus();
        open();
      } catch (error) {
        items = null;
        message(`No se pudieron cargar los ${plural}: ${error.message} Abre el desplegable para reintentar.`, true);
        input.focus();
      } finally {
        stopFollowing();
        loading = false;
        field.setAttribute('aria-busy', 'false');
        spinner.hidden = true;
        toggle.hidden = false;
        updateAvailability();
      }
    };
    const show = () => {
      if (pending || input.disabled) return;
      if (items === null) void lookup();
      else open();
    };
    const select = index => {
      if (visible[index] === undefined) return;
      const changed = input.value !== visible[index];
      input.value = visible[index];
      close();
      if (changed && name === 'project') pickers.team.reset();
      updateAvailability();
      input.focus();
    };
    pickers[name] = { input, toggle, close, reset() {
      items = null;
      input.value = '';
      close();
      message('');
    } };
    input.addEventListener('click', show);
    toggle.addEventListener('click', () => {
      if (dropdown.hidden) { input.focus(); show(); }
      else { close(); input.focus(); }
    });
    input.addEventListener('input', () => {
      if (name === 'project') pickers.team.reset();
      updateAvailability();
      if (items !== null) open(input.value);
    });
    input.addEventListener('keydown', event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        if (dropdown.hidden) { show(); return; }
        if (visible.length) highlight(active < 0 ? (event.key === 'ArrowDown' ? 0 : visible.length - 1) : (active + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length);
      } else if (event.key === 'Enter' && !dropdown.hidden) {
        event.preventDefault();
        if (active >= 0) select(active);
        else close();
      } else if (event.key === 'Escape' && !dropdown.hidden) {
        event.preventDefault(); event.stopPropagation(); close();
      }
    });
    list.addEventListener('mousedown', event => event.preventDefault());
    list.addEventListener('click', event => {
      const option = event.target.closest('[data-index]');
      if (option && !pending) select(Number(option.dataset.index));
    });
    $('.connection-refresh', field).addEventListener('click', lookup);
    field.addEventListener('focusout', event => { if (!field.contains(event.relatedTarget)) close(); });
  }
  function updateAvailability() {
    for (const [name, picker] of Object.entries(pickers)) {
      const ready = !!form.elements.organization.value.trim() && (name === 'project' || !!pickers.project.input.value.trim());
      picker.input.disabled = picker.toggle.disabled = pending || !ready;
      if (!ready) {
        picker.close();
        $(`#${name}-status`, form).textContent = name === 'project' ? 'Indica primero la organización.' : 'Indica primero el proyecto.';
      } else {
        const note = $(`#${name}-status`, form);
        if (!note.textContent || note.textContent.startsWith('Indica primero')) note.textContent = 'Abre el desplegable para buscar o escribe el nombre completo.';
      }
    }
  }
  for (const name of ['organization', 'authentication', 'tenant']) {
    form.elements[name].addEventListener(name === 'authentication' ? 'change' : 'input', () => {
      Object.values(pickers).forEach(picker => picker.reset());
      updateAvailability();
    });
  }
  // Close on pointer clicks outside a picker, including non-focusable modal text.
  modal.addEventListener('click', event => {
    Object.entries(pickers).forEach(([name, picker]) => {
      if (!event.target.closest(`[data-picker="${name}"]`)) picker.close();
    });
  }, { signal: connectionPickerEvents.signal });
  updateAvailability();
}
async function importWithProgress(target, existing = null, start = null) {
  const importId = existing?.id || crypto.randomUUID();
  const isImport = start?.path==='/api/import' || !start && (!existing || existing.path === '/api/import');
  let finish, fail;
  const completion = existing ? new Promise((resolve, reject) => { finish = resolve; fail = reject; }) : null;
  const controller = new AbortController();
  let stopped = false, timer;
  $('#modal-error').hidden = true;
  target.hidden = false;
  target.className = 'import-progress';
  target.innerHTML = `<div class="import-progress-heading"><span class="spinner" aria-hidden="true"></span><strong>Importando equipo</strong></div><p class="import-progress-phase" role="status" aria-live="polite">Conectando con Azure DevOps. Completa el acceso de Microsoft si se solicita.</p><p class="operation-now"></p><ul class="import-progress-counts" aria-label="Datos obtenidos"></ul><small class="import-progress-note">Los elementos detectados pueden aumentar al encontrar tareas hijas.</small><small class="import-progress-connection" role="status"></small><small class="import-progress-time"></small><details class="operation-activity" hidden><summary>Qué está pasando</summary><ol></ol></details><button type="button" class="button small" data-cancel-operation>Cancelar consulta</button>`;
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const cancelButton = $('[data-cancel-operation]', target);
  if (start) $('.import-progress-heading strong', target).textContent = start.title || 'Consultando permisos';
  if (!isImport) $('.import-progress-note', target).textContent = 'La sesión de Azure puede reutilizarse sin pedir autenticación de nuevo.';
  cancelButton.addEventListener('click', async () => {
    cancelButton.disabled = true;
    try {
      const response = await fetch('/api/cancel-operation', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Neo-CSRF': state.csrf }, body: JSON.stringify({ id: importId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      $('.import-progress-connection', target).textContent = 'Cancelando la consulta…';
    } catch (error) {
      $('.import-progress-connection', target).textContent = error.message;
    }
  });
  const renderProgress = progress => {
    if (progress.title) $('.import-progress-heading strong', target).textContent = progress.title;
    cancelButton.hidden = existing ? !['/api/refresh-section', '/api/import', '/api/projects', '/api/teams', '/api/security-groups', '/api/security-audit', '/api/maintenance', '/api/maintenance-states', '/api/work-item-states'].includes(existing.path) : progress.cancellable === false && !progress.cancelRequested;
    cancelButton.disabled = progress.cancellable === false || !!progress.cancelRequested;
    const elapsed = progress.startedAt ? Math.floor((Date.now() - progress.startedAt) / 1000) : 0;
    const last = Math.max(progress.updatedAt || 0, progress.activityAt || 0), idle = last ? Math.floor((Date.now() - last) / 1000) : 0;
    $('.import-progress-time', target).textContent = progress.startedAt ? `${Math.floor(elapsed / 60)} min ${elapsed % 60} s en curso${idle >= 15 ? ` · ${idle} s sin actividad nueva` : ''}` : '';
    renderActivity(target, progress);
    $('.import-progress-phase', target).textContent = progress.message;
    const c = progress.counts || {};
    const entries = [
      c.namespacesRead !== undefined && `${c.namespacesRead} / ${c.namespaceTotal} ámbitos consultados`,
      c.resources !== undefined && `${c.resources} recursos encontrados`,
      c.grants !== undefined && `${c.grants} entradas de permisos encontradas`,
      c.issuesFound !== undefined && `${c.issuesFound} functional issues encontrados · ${c.issuesRead} leídos`,
      c.settings !== undefined && 'Configuración obtenida',
      c.members !== undefined && `${c.members} integrantes`,
      c.iterations !== undefined && `${c.iterations} iteraciones`,
      c.iterationsExcluded !== undefined && `${c.iterationsExcluded} iteraciones anteriores excluidas`,
      c.backlogs !== undefined && `${c.backlogs} / ${c.backlogTotal} backlogs leídos`,
      c.iterationsRead !== undefined && `${c.iterationsRead} / ${c.iterations} iteraciones consultadas · ${c.capacities} capacidades obtenidas`,
      c.discovered !== undefined && `${c.discovered} elementos detectados`,
      c.read !== undefined && `${c.read} elementos leídos`,
      c.imported !== undefined && `${c.imported} elementos para importar`,
      c.excluded !== undefined && `${c.excluded} completados o retirados excluidos`,
      c.parents !== undefined && `${c.parents} padres de contexto obtenidos`,
      c.warnings > 0 && `${c.warnings} avisos · algunos datos no se pudieron consultar`,
    ].filter(Boolean);
    $('.import-progress-counts', target).innerHTML = entries.map(text => `<li>${escape(text)}</li>`).join('');
  };
  if (existing) renderProgress(existing);
  const poll = async () => {
    try {
      const response = await fetch(`/api/${existing || start ? 'operation' : 'import-progress'}?id=${encodeURIComponent(importId)}`, { headers: { 'X-Neo-CSRF': state.csrf }, signal: controller.signal });
      if (!response.ok) throw new Error('Progress unavailable');
      const data = await response.json();
      if (stopped) return;
      const progress = existing || start ? data.operation : data.progress;
      if (progress) renderProgress(progress);
      if (existing) {
        if (!progress) fail(new Error('La operación ya no está disponible. Actualiza los datos para comprobar el resultado.'));
        else if (progress.status === 'complete') finish();
        else if (['failed', 'cancelled'].includes(progress.status)) fail(Object.assign(new Error(progress.error || progress.message), { stateReview: progress.stateReview, diagnostics: progress.diagnostics }));
      }
      $('.import-progress-connection', target).textContent = '';
    } catch {
      if (!stopped) $('.import-progress-connection', target).textContent = 'No se pudo actualizar el progreso. Reintentando…';
    } finally {
      if (!stopped) timer = setTimeout(poll, 700);
    }
  };
  const operation = completion || (start ? request(start.path, { ...start.input, operationId: importId }) : request('/api/import', { importId }));
  void poll();
  try {
    const data = await operation;
    $('.import-progress-phase', target).textContent = isImport ? 'Importación completada. Copia local guardada.' : 'Consulta completada.';
    return data;
  } catch (error) {
    target.classList.add('failed');
    $('.import-progress-heading strong', target).textContent = isImport ? 'Importación detenida' : 'Operación detenida';
    $('.import-progress-phase', target).textContent = error.message;
    $('.import-progress-note', target).textContent = `La operación no se ha completado. Puedes volver a intentarlo.${error.diagnostics ? ` Detalle técnico guardado en ${error.diagnostics}.` : ''}`;
    throw error;
  } finally {
    stopped = true;
    clearTimeout(timer);
    controller.abort();
    $('.spinner', target).hidden = true;
    cancelButton.hidden = true;
    $('.import-progress-time', target).textContent = $('.import-progress-time', target).textContent.replace('en curso', 'transcurridos');
    $('.import-progress-connection', target).textContent = '';
  }
}
// What an operation is doing right now: the call it waits for, sign-in steps and
// the requests sent, so a slow query can be told apart from a stuck one.
const clock = at => new Date(at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
function activitySummary(progress) {
  const pending = progress?.pendingCall, entries = progress?.activity ?? [], last = entries.at(-1);
  if (pending) {
    const auth = [...entries].reverse().find(entry => entry.at >= pending.startedAt && entry.kind === 'auth');
    return `${auth ? auth.message : `Esperando respuesta de Azure DevOps: ${pending.label}`} · ${Math.floor((Date.now() - pending.startedAt) / 1000)} s`;
  }
  return last ? `${last.message} · hace ${Math.floor((Date.now() - last.at) / 1000)} s` : '';
}
function renderActivity(target, progress) {
  const summary = activitySummary(progress), list = $('.operation-activity ol', target), entries = progress.activity ?? [];
  $('.operation-now', target).textContent = summary ? `Ahora: ${summary}` : '';
  $('.operation-activity', target).hidden = !entries.length;
  $('.operation-activity summary', target).textContent = `Qué está pasando · ${entries.length} paso${entries.length === 1 ? '' : 's'}`;
  const atEnd = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
  list.innerHTML = entries.map(entry => `<li class="activity-${escape(entry.kind)}"><time>${clock(entry.at)}</time><span>${escape(entry.message)}</span></li>`).join('');
  if (atEnd) list.scrollTop = list.scrollHeight;
}
// Lightweight progress for requests without a progress panel.
function followOperation(id, onProgress) {
  let stopped = false, timer;
  const poll = async () => {
    try {
      const response = await fetch(`/api/operation?id=${encodeURIComponent(id)}`, { headers: { 'X-Neo-CSRF': state.csrf } });
      const data = response.ok ? await response.json() : null;
      if (!stopped && data?.operation) onProgress(data.operation);
    } catch { /* The request itself reports failures. */ }
    if (!stopped) timer = setTimeout(poll, 800);
  };
  timer = setTimeout(poll, 400);
  return () => { stopped = true; clearTimeout(timer); };
}
let recoveringOperation = false;
function showStateReview(review) {
  const normalize = value => value.trim().toLowerCase();
  const states = new Map(review.states.map(item => [normalize(item.name), item]));
  if (!states.has(normalize(review.state))) states.set(normalize(review.state), { name: review.state, category: '' });
  showModal('Revisar estados de importación', `Proyecto ${review.project} · ${review.type}. Indica qué estados deben entrar en la planificación.`, `
    <p>No se ha podido clasificar <strong>${escape(review.state)}</strong>. Tus decisiones se guardarán para este proyecto y tipo de elemento.</p>
    <form id="state-rules-form" data-refresh-all="${review.refreshAll===true}" data-section="${escape(review.section || '')}">${[...states.values()].map((item, index) => {
      const required = normalize(item.name) === normalize(review.state);
      return `<label class="form-field">${escape(item.name)}${required ? ' · pendiente de decidir' : ''}<select name="rule-${index}" data-state="${escape(item.name)}" ${required ? 'required' : ''}><option value="">${required ? 'Elige cómo tratar este estado' : item.category ? `Según Azure (${escape(item.category)})` : normalize(item.name) === 'discarded' ? 'Excluir descartados' : 'Sin decisión guardada'}</option><option value="exclude">Excluir: cerrado o descartado</option><option value="include">Importar: sigue abierto</option></select></label>`;
    }).join('')}</form>
    <details class="state-review-fields" open><summary>Campos del elemento #${escape(review.item.id)} ${azureLink(review.item,'↗',review)}</summary><div class="table-wrap"><table><thead><tr><th>Campo</th><th>Valor</th></tr></thead><tbody>${Object.entries(review.item.fields).map(([name, value]) => `<tr><td>${escape(name)}</td><td><pre>${escape(typeof value === 'object' ? JSON.stringify(value, null, 2) : value)}</pre></td></tr>`).join('')}</tbody></table></div></details>`,
    '<button class="button" data-action="close">Decidir más tarde</button><button class="button primary" type="submit" form="state-rules-form">Guardar y reintentar importación</button>');
  modal.classList.add('connection-modal');
}
async function resumeOperation() {
  if (recoveringOperation || pending || !state?.operation || !state.busy) return;
  recoveringOperation = true;
  const current = state.operation;
  showModal(current.title || 'Operación en curso', 'Recuperando el estado de la operación que sigue ejecutándose en el servidor.', '<div id="connection-progress"></div>');
  pending = true;
  const enabled = [...document.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')];
  enabled.forEach(el => el.disabled = true);
  $('#save-status').textContent = current.title || 'Operación en curso';
  try {
    await importWithProgress($('#connection-progress'), current);
    await loadState();
    if (current.path.startsWith('/api/security-')) { await loadSecurity(); tab = 'permissions'; render(); }
    if (current.path === '/api/maintenance') { await loadMaintenance(); tab = 'maintenance'; render(); }
    modal.close();
    toast('Operación completada. Datos actualizados.');
  } catch (error) {
    await loadState().catch(() => {});
    errorInModal(error);
  } finally {
    pending = false;
    recoveringOperation = false;
    enabled.forEach(el => el.disabled = false);
    $('#save-status').textContent = savedStatus();
  }
}
async function saveConfig(importNow) {
  const form = $('#connection-form'); if (!form.reportValidity()) return;
  const config = getConfig();
  await request('/api/config', { config }); render();
  if (!importNow) { modal.close(); toast('Configuración guardada. Puedes importar los datos cuando quieras.'); return; }
  await importWithProgress($('#connection-progress'));
  modal.close(); selectedIteration = ''; tab = 'iteration'; render(); toast('Equipo importado. Ya puedes preparar la iteración.');
}
function selected() {
  const ws = state.workspace;
  if (!ws) return null;
  const options = planningIterations();
  if (!options.some(i => i.id === selectedIteration)) selectedIteration = (options.find(i => i.attributes?.timeFrame === 1 || i.attributes?.timeFrame === 'current') || options[0])?.id || '';
  return options.find(i => i.id === selectedIteration);
}
// The previous iteration is imported only to be reviewed, never planned.
function planningIterations() { return state.workspace?.iterations.filter(i => !i.past) ?? []; }
function filtered(items) {
  const search = query.trim().toLowerCase();
  return items.filter(i => !search || `${i.id} ${i.title} ${i.tags.join(' ')} ${i.assigneeName} ${i.assignedTo} ${i.state}`.toLowerCase().includes(search)).sort((a,b) => (a.priority ?? 5) - (b.priority ?? 5) || a.id - b.id);
}
const memberName = value => state.workspace?.members.find(m => key(m) === value)?.displayName || (value || 'Sin asignar');
const iterationName = value => state.workspace?.iterations.find(i => i.path === value)?.name || (value === state.workspace?.settings.backlogIteration.path ? 'Backlog' : value);
const pretty = (field,value) => field === 'assignedTo' ? memberName(value) : field === 'iterationPath' ? iterationName(value) : value === null || value === undefined ? 'Sin definir' : field === 'remainingWork' ? `${number(value)} h` : String(value);
function planningTree() { return hierarchy(state.workspace.effectiveItems); }
function planningMembers(iterationId=selectedIteration) {
  const ws=state.workspace;
  return ws?.members.filter(member=>hasPlanningCapacity(ws,key(member),iterationId)) ?? [];
}
function restrictAssignees(select,current='') {
  const allowed=new Set(planningMembers().map(key));
  for(const option of [...select.options]) {
    if(!option.value || allowed.has(option.value)) continue;
    if(option.value===current) option.textContent+=' · capacidad 0';
    else option.remove();
  }
}
function matchesText(item, text) {
  return `${item.id} ${item.title} ${(item.tags || []).join(' ')} ${item.type}`.toLowerCase().includes(text.trim().toLowerCase());
}
// Opens the real work item in Azure DevOps, in the project it belongs to.
function azureLink(item, label='↗', config=null) {
  const ws=state.workspace;
  if (!(item?.id>0) || !config && ws?.mode!=='azure') return '';
  config ??= ws.sources?.find(s=>s.id===item.sourceId)?.config ?? ws.config;
  if (!config?.organization || !config.project) return '';
  const url=`https://dev.azure.com/${encodeURIComponent(config.organization)}/${encodeURIComponent(config.project)}/_workitems/edit/${item.id}`;
  return `<a class="azure-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer" title="Abrir #${item.id} en Azure DevOps" aria-label="Abrir #${item.id} en Azure DevOps">${escape(label)}</a>`;
}
function treeView({ availableOnly = false, picker = false, member = focusedMember, search = query } = {}) {
  const ws=state.workspace, tree=planningTree(), iteration=selected();
  const eligible=new Set(member ? eligibleTasks(ws,member,iteration?.id).map(i=>i.id) : []);
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
    const participants=planningMembers(iteration?.id).filter(m=>sources.has(key(m)));
    const peopleButton=`<button class="people-button" type="button" data-action="participants" data-task="${node.id}" aria-controls="people-popover" aria-expanded="${peopleItem===node.id}" aria-label="Repartir ${escape(node.title)} entre personas">${participants.slice(0,3).map((m,index)=>`<span class="avatar c${index%4}" title="${escape(m.displayName)}">${escape(initials(m.displayName))}</span>`).join('')}<span>${participants.length ? `${participants.length} · reparto local` : '+ Repartir'}</span></button>`;
    const type=`<span class="node-type kind-${typeRank(node)}">${escape(node.type)}</span>`;
    if (!isExecutable(node)) {
      return `<details class="hierarchy-branch" data-node="${node.id}" ${picker || search || !collapsed.has(node.id) ? 'open' : ''}><summary><span class="branch-chevron">›</span>${type}<span class="branch-title">${node.project ? `<small class="pill">${escape(node.project)}</small> ` : ''}${escape(node.title)} <small>#${node.id}${node.contextOnly ? ' · contexto' : ''}</small>${azureLink(node)}${node.modified ? `<span class="pill changed">${pendingLabel(node)}</span>` : ''}</span><button class="button small" data-action="create" data-parent="${node.id}" aria-label="Crear hijo de ${escape(node.title)}">+</button><button class="button small" data-action="edit" data-task="${node.id}">Editar</button>${picker ? `<button class="remove-branch" type="button" data-action="remove-branch" data-task="${node.id}" aria-label="Quitar ${escape(node.title)} de ${escape(memberName(member))}" title="Quita la rama y desmarca sus tareas de esta iteración">Quitar rama ×</button>` : peopleButton}</summary><div class="hierarchy-children">${node.children.map(child=>nodeHtml(child,depth+1)).join('') || '<p class="branch-empty">Sin tareas o bugs disponibles en esta rama.</p>'}</div></details>`;
    }
    const already=node.iterationPath === iteration?.path && node.assignedTo === member;
    const other=!!node.assignedTo && node.assignedTo !== member;
    const disabled=other;
    const effort=node.remainingWork !== null ? `${number(node.remainingWork)} h` : node.points !== null ? `${number(node.points)} pts` : 'Sin estimar';
    const controls=picker ? `<input type="checkbox" name="taskIds" value="${node.id}" aria-label="Seleccionar ${escape(node.title)}" ${disabled ? 'disabled' : ''} ${already ? 'checked' : ''}>` : '';
    const status=picker && other ? `Responsable: ${memberName(node.assignedTo)}` : already ? 'Seleccionada' : iterationName(node.iterationPath);
    const contents=`${controls}<div class="leaf-copy"><div class="leaf-meta">${type}<span>#${node.id}</span>${azureLink(node)}${node.project ? `<span class="pill">${escape(node.project)}</span>` : ''}${node.modified ? `<span class="pill changed">${pendingLabel(node)}</span>` : ''}</div>${picker ? `<span class="leaf-title">${escape(node.title)}</span>` : `<button class="leaf-title" data-action="edit" data-task="${node.id}">${escape(node.title)}</button>`}<span class="leaf-status">${escape(status)}${!picker && node.assignedTo ? ` · ${escape(memberName(node.assignedTo))}` : ''}</span></div><span class="effort">${effort}</span>${picker ? '' : peopleButton}`;
    const leaf=picker ? `<label class="hierarchy-leaf ${disabled ? 'unavailable' : ''}">${contents}</label>` : `<div class="hierarchy-leaf" draggable="true" data-drag-task="${node.id}">${contents}</div>`;
    return leaf + (node.children.length ? `<div class="hierarchy-children">${node.children.map(child=>nodeHtml(child,depth+1)).join('')}</div>` : '');
  }
  const empty=`<div class="empty-result">${picker ? 'Sin tareas para esta persona. Reparte una rama en el paso 1.' : 'No hay tareas para esta selección. Cambia el filtro o reparte una rama entre personas.'}</div>`;
  if (!ws.sources) return roots.map(node=>nodeHtml(node,0)).join('') || empty;
  // With several projects, each project is the top parent of its own backlog.
  const projects=ws.sources.map(source=>{
    const own=roots.filter(node=>node.sourceId===source.id);
    if (!own.length) return '';
    return `<details class="hierarchy-branch project-branch" data-project="${escape(source.id)}" ${picker || search || !collapsed.has(`project:${source.id}`) ? 'open' : ''}><summary><span class="branch-chevron">›</span><span class="node-type kind-project">Proyecto</span><span class="branch-title">${escape(source.config.project)} <small>${escape(source.config.team)}</small></span></summary><div class="hierarchy-children">${own.map(node=>nodeHtml(node,1)).join('')}</div></details>`;
  }).join('');
  const unknown=roots.filter(node=>!ws.sources.some(source=>source.id===node.sourceId)).map(node=>nodeHtml(node,0)).join('');
  return projects+unknown || empty;
}
function hierarchyView() {
  return `<section class="hierarchy-surface"><div class="hierarchy-toolbar"><input class="search" id="search" aria-label="Buscar en el backlog" placeholder="Buscar rama o tarea" value="${escape(query)}"><select id="backlog-filter" aria-label="Filtrar backlog"><option value="all" ${backlogFilter==='all' ? 'selected' : ''}>Todo el backlog</option><option value="unshared" ${backlogFilter==='unshared' ? 'selected' : ''}>Sin personas</option></select><button class="button small" data-action="expand-tree">Expandir</button><button class="button small" data-action="collapse-tree">Plegar</button></div><div id="hierarchy-content">${treeView()}</div></section>`;
}
function sectionRefreshButton() {
  const section=({iteration:'iterations',capacity:'capacity',hierarchy:'tasks',planning:'tasks',previous:'tasks'})[tab];
  if(!section || state.workspace?.mode!=='azure') return '';
  const label=({iterations:'iteraciones',capacity:'capacidad',tasks:'tareas y jerarquía'})[section];
  const at=state.workspace.refreshedAt?.[section];
  return `<div class="workspace-controls"><button class="button small" data-action="refresh-section" data-section="${section}">Actualizar ${label}</button><small class="text-muted">Solo ${label}${at ? ' · '+new Date(at).toLocaleTimeString('es') : ''}</small></div>`;
}
function stepView() { return sectionRefreshButton()+stepContent(); }
function stepContent() {
  const iteration=selected();
  if (tab==='iteration') return iterationView();
  if (tab==='previous') return previousView();
  if (tab==='capacity') return capacityView();
  if (tab==='planning') return plannerView();
  if (tab==='hierarchy' || !iteration) return hierarchyView();
  return board(iteration,state.workspace.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath===iteration.path));
}
function stepTabs(changes) {
  const open=previousTasks().tasks.filter(t=>t.status==='open').length;
  const steps=[['iteration','Iteración'],...(state.workspace.iterations.some(i=>i.past) ? [['previous','Revisar anterior',open]] : []),['capacity','Capacidad'],['hierarchy','Repartir ramas'],['planning','Elegir tareas']];
  return `<nav class="step-tabs" aria-label="Pasos de planificación">${steps.map(([id,label,count],index)=>`<button class="step-tab ${tab===id ? 'active' : ''}" data-action="tab" data-tab="${id}" ${tab===id ? 'aria-current="step"' : ''}><span>${index+1}</span>${label}${count ? `<small aria-label="${count} sin decidir">${count}</small>` : ''}</button>`).join('')}<button class="step-tab" data-action="review" ${changes ? '' : 'disabled'}><span>${steps.length+1}</span>${changes ? `${changes} pendiente${changes===1 ? '' : 's'} · Revisar y sincronizar` : 'Revisar'}</button></nav>`;
}
// Step 1: the iteration being planned. Every later step works on it.
function timeFrameLabel(iteration) {
  const frame=String(iteration.attributes?.timeFrame ?? '').toLowerCase();
  return ['1','current'].includes(frame) ? 'Actual' : ['2','future'].includes(frame) ? 'Próxima' : 'Iteración';
}
function iterationView() {
  const ws=state.workspace, current=selected();
  if (!current) return '<div class="empty-result">Importa un equipo con iteraciones para empezar a planificar.</div>';
  return `<section class="iteration-step"><header class="step-heading"><h2>¿Qué iteración vas a planificar?</h2><p>Después revisarás el trabajo que quedó abierto en la iteración anterior.</p></header><div class="iteration-options">${planningIterations().map(i=>{
    const planned=ws.effectiveItems.filter(item=>isExecutable(item) && item.iterationPath===i.path).length, previous=previousIteration(ws.iterations,i.id);
    return `<button class="iteration-option ${i.id===current.id ? 'active' : ''}" data-action="choose-iteration" data-iteration="${escape(i.id)}" aria-pressed="${i.id===current.id}"><span class="iteration-when">${timeFrameLabel(i)}</span><strong>${escape(i.name)}</strong><span>${date(i.attributes?.startDate)} — ${date(i.attributes?.finishDate)}</span><small>${planned} tarea${planned===1 ? '' : 's'} ya planificada${planned===1 ? '' : 's'} · ${previous ? `revisarás ${escape(previous.name)}` : 'sin iteración anterior'}</small></button>`;
  }).join('')}</div></section>`;
}
// Step 2: each open task of the previous iteration moves to the one being
// planned or is closed. Both decisions are local drafts until the review.
const previousOrder={open:0,moved:1,backlog:2,elsewhere:3,completed:4};
function previousTasks(iteration=selected()) {
  const ws=state.workspace, previous=iteration ? previousIteration(ws.iterations,iteration.id) : null;
  if (!previous) return {previous,tasks:[]};
  const base=new Map(ws.items.map(i=>[i.id,i]));
  const tasks=ws.effectiveItems.filter(i=>isExecutable(i) && (i.iterationPath===previous.path || base.get(i.id)?.iterationPath===previous.path)).map(item=>{
    // With several projects, each one closes a type with its own state.
    const status=isCompleted(item,ws) ? 'completed' : item.iterationPath===iteration.path ? 'moved' : item.iterationPath===ws.settings.backlogIteration.path ? 'backlog' : item.iterationPath!==previous.path ? 'elsewhere' : 'open';
    return {item,base:base.get(item.id),status};
  });
  return {previous,tasks:tasks.sort((a,b)=>previousOrder[a.status]-previousOrder[b.status] || (a.item.priority ?? 5)-(b.item.priority ?? 5) || a.item.id-b.item.id)};
}
function previousTaskRow({item,base,status},iteration) {
  const effort=item.remainingWork!==null ? `${number(item.remainingWork)} h` : 'Sin estimar';
  const decided=item.iterationPath!==base.iterationPath || item.state!==base.state;
  const outcome={completed:'✓ Completada',backlog:'↩ En el backlog, sin iteración',moved:`→ Pasa a ${escape(iteration.name)}`,elsewhere:`Movida a ${escape(iterationName(item.iterationPath))}`}[status];
  const actions=status==='open'
    ? `<button class="button small primary" data-action="carry-over" data-task="${item.id}">Pasar a ${escape(iteration.name)} →</button><button class="button small" data-action="complete-task" data-task="${item.id}" title="Marcar como completada">✓ Completada</button><button class="button small" data-action="to-backlog" data-task="${item.id}" title="Mandar al backlog: quita la iteración y conserva el responsable">↩ Backlog</button>`
    : `<span class="previous-outcome outcome-${status}">${outcome}</span>${decided ? `<button class="button small subtle" data-action="undo-previous" data-task="${item.id}">Deshacer</button>` : ''}`;
  return `<li class="previous-task status-${status}" data-previous-task="${item.id}"><div class="previous-task-copy"><div class="leaf-meta"><span class="node-type kind-${typeRank(item)}">${escape(item.type)}</span><span>#${item.id}</span>${azureLink(item)}<span class="pill">${escape(base.state || 'Sin estado')}</span>${item.modified ? `<span class="pill changed">${pendingLabel(item)}</span>` : ''}</div><button class="leaf-title" data-action="edit" data-task="${item.id}">${escape(item.title)}</button></div><span class="effort">${effort}</span><div class="previous-task-actions">${actions}</div></li>`;
}
function previousPerson(group,iteration) {
  const open=group.tasks.filter(t=>t.status==='open'), hours=open.reduce((sum,t)=>sum+(t.item.remainingWork ?? 0),0), decided=group.tasks.length-open.length;
  return `<section class="previous-person"><header class="person">${group.avatar ? `<span class="avatar ${group.avatar}">${escape(initials(group.name))}</span>` : ''}<div class="person-detail"><h3>${escape(group.name)}</h3><p>${open.length} sin decidir · ${number(hours)} h pendientes${decided ? ` · ${decided} decidida${decided===1 ? '' : 's'}` : ''}</p></div></header><ul class="previous-tasks">${group.tasks.map(task=>previousTaskRow(task,iteration)).join('')}</ul></section>`;
}
function previousView() {
  const ws=state.workspace, iteration=selected();
  if (!iteration) return '<div class="empty-result">Elige primero la iteración que vas a planificar.</div>';
  const {previous,tasks}=previousTasks(iteration);
  const next='<button class="button primary" data-action="tab" data-tab="capacity">Continuar con la capacidad →</button>';
  if (!previous) return `<div class="empty-panel"><h2>No hay iteración anterior</h2><p>${escape(iteration.name)} es la primera iteración importada.${ws.mode==='azure' ? ' Actualiza los datos para traer la última iteración terminada.' : ''}</p>${next}</div>`;
  const open=tasks.filter(t=>t.status==='open'), owned=member=>tasks.filter(t=>t.item.assignedTo===key(member));
  const groups=[
    ...ws.members.map((member,index)=>({name:member.displayName,avatar:`c${index%4}`,tasks:owned(member)})),
    {name:'Sin asignar',tasks:tasks.filter(t=>!t.item.assignedTo)},
    {name:'Fuera del equipo',tasks:tasks.filter(t=>t.item.assignedTo && !ws.members.some(m=>key(m)===t.item.assignedTo))},
  ].filter(group=>group.tasks.length);
  const idle=ws.members.filter(member=>!owned(member).length), types=[...new Set(tasks.map(t=>t.item.type))];
  const kinds=[...new Map(tasks.map(t=>[`${t.item.sourceId ?? ''}\n${t.item.type}`,t.item])).values()];
  const completion=types.length ? `<p class="completed-states">Al completar: ${kinds.map(item=>`<button class="link-button" data-action="edit-completed-state" data-type="${escape(item.type)}" data-source="${escape(item.sourceId ?? '')}" title="Cambiar el estado completado de ${escape(item.type)}">${ws.sources ? `${escape(item.project)} · ` : ''}${escape(item.type)} → ${escape(completedState(item,ws) || 'sin elegir')}</button>`).join(' · ')}</p>` : '';
  return `<section class="previous-step"><header class="previous-heading"><div><h2>Revisa ${escape(previous.name)}</h2><p>${date(previous.attributes?.startDate)} — ${date(previous.attributes?.finishDate)} · Lo que sigue abierto de cada persona. Pásalo a ${escape(iteration.name)}, márcalo como completado o mándalo al backlog.</p>${completion}</div><div class="previous-summary"><strong>${open.length}</strong><span>sin decidir</span><small>${tasks.length} en total</small></div></header>
    ${groups.length ? `<div class="previous-people">${groups.map(group=>previousPerson(group,iteration)).join('')}</div>` : `<div class="empty-result">No quedan tareas ni bugs abiertos en ${escape(previous.name)}.</div>`}
    ${groups.length && idle.length ? `<p class="local-note">Sin trabajo abierto en ${escape(previous.name)}: ${idle.map(m=>escape(m.displayName)).join(', ')}.</p>` : ''}
    <div class="capacity-next"><span>${open.length ? `Quedan ${open.length} por decidir. Puedes continuar y volver después.` : 'Todo decidido.'} Las decisiones se guardan en local y se envían al sincronizar.</span>${next}</div></section>`;
}
// Which state closes a type is decided by the person. The list starts with what
// is known locally; the complete workflow can be read from Azure on demand.
let completedStateChoice=null;
const stateCategoryLabels={proposed:'Sin empezar',inprogress:'En curso',resolved:'Resuelto',completed:'Completado',removed:'Retirado'};
function knownStates(type, sourceId) {
  const ws=state.workspace, found=new Map();
  const add=(name,source)=>{const text=String(name ?? '').trim();if(text && !found.has(text.toLowerCase()))found.set(text.toLowerCase(),{name:text,source});};
  add(completedState({type,sourceId},ws),'Elegido actualmente');
  ws.items.filter(i=>i.type===type && (i.sourceId ?? null)===(sourceId ?? null)).forEach(i=>add(i.state,'En los datos importados'));
  ['Closed','Done','Completed','Resolved','Removed'].forEach(name=>add(name,'Nombre habitual'));
  return [...found.values()];
}
function chooseCompletedState(type, taskId=null, states=null, sourceId=undefined) {
  completedStateChoice={type,taskId,sourceId};
  const current=completedState({type,sourceId},state.workspace), project=state.workspace.sources?.find(s=>s.id===sourceId)?.config.project;
  const options=states ? states.map(s=>({name:s.name,source:stateCategoryLabels[s.category] || 'Sin categoría'})) : knownStates(type,sourceId);
  const checked=current || options.find(o=>o.source==='Completado')?.name;
  showModal(`Estado completado de «${type}»${project ? ` en ${project}` : ''}`,'Elige el estado que se asigna al marcar como completada una tarea de este tipo. Se recordará.', `<form id="completed-state-form"><div class="participant-list">${options.map(o=>`<label class="participant-option"><input type="radio" name="state" value="${escape(o.name)}" ${o.name===checked ? 'checked' : ''} required><span><strong>${escape(o.name)}</strong><small>${escape(o.source)}</small></span></label>`).join('')}<label class="participant-option"><input type="radio" name="state" value="" data-other-state><span class="other-state"><strong>Otro estado</strong><input name="other" maxlength="128" placeholder="Nombre exacto en Azure DevOps" aria-label="Otro estado"></span></label></div>${states ? '<p class="form-intro">Estados del flujo de trabajo en Azure DevOps.</p>' : `<p class="form-intro">La lista reúne los estados de los datos importados y nombres habituales.${state.mode==='demo' ? '' : ' Azure DevOps comprobará el estado al sincronizar.'}</p><button type="button" class="button small" data-action="load-work-item-states">Consultar todos los estados en Azure DevOps</button><div id="connection-progress" hidden></div>`}</form>`, `<button class="button" data-action="close">Cancelar</button><button class="button primary" type="submit" form="completed-state-form">${taskId ? 'Guardar y marcar completada' : 'Guardar'}</button>`);
  modal.classList.add('connection-modal');
}
async function decidePrevious(id, decision) {
  const ws=state.workspace, item=ws.effectiveItems.find(i=>i.id===id), base=ws.items.find(i=>i.id===id), iteration=selected();
  if (!item || !base || !iteration) throw new Error('La tarea ya no está disponible.');
  if (decision==='complete') {
    if (!completedState(item,ws)) { chooseCompletedState(item.type,id,null,item.sourceId); return; }
    await request('/api/complete-task',{id});
  }
  else await request('/api/stage',{edits:[{id,changes:decision==='carry' ? {iterationPath:iteration.path} : decision==='backlog' ? {iterationPath:ws.settings.backlogIteration.path} : {iterationPath:base.iterationPath,state:base.state}}]});
  review=null;render();
  document.querySelector(`[data-previous-task="${id}"] .previous-task-actions button`)?.focus({preventScroll:true});
  toast(decision==='carry' ? `#${id} pasa a ${iteration.name}. Pendiente de sincronizar.` : decision==='backlog' ? `#${id} vuelve al backlog. Pendiente de sincronizar.` :decision==='complete' ? `#${id} marcada como completada en local.` : `Decisión sobre #${id} deshecha.`);
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
  const members=planningMembers().filter(m=>`${m.displayName} ${key(m)}`.toLowerCase().includes(peopleQuery.toLowerCase()));
  $('#people-options').innerHTML=members.map(m=>{
    const inherited=(sources.get(key(m)) || []).find(s=>s.inherited);
    return `<label class="person-option"><input type="checkbox" data-participant="${escape(key(m))}" ${sources.has(key(m)) ? 'checked' : ''}><span class="avatar">${escape(initials(m.displayName))}</span><span>${escape(m.displayName)}${inherited ? `<small>Heredado de #${inherited.id}</small>` : ''}</span></label>`;
  }).join('') || '<p class="empty-result">Sin coincidencias</p>';
}
function ensureSelection() {
  const members=planningMembers();
  if(!members.some(m=>key(m)===pickerMember))pickerMember=members[0] ? key(members[0]) : '';
}
function choosePerson(member) {
  if(!planningMembers().some(m=>key(m)===member))return;
  const peopleScroll=$('.planning-people')?.scrollTop || 0;
  pickerMember=member;focusedMember=member;pickerQuery='';tab='planning';planningMode='person';render();
  if($('.planning-people'))$('.planning-people').scrollTop=peopleScroll;
}
function pickTasks(member) {
  modal.close();
  pickerMember=planningMembers().some(m=>key(m)===member) ? member : focusedMember || pickerMember;
  tab='planning';planningMode='person';ensureSelection();render();
}
function personMeter(member) {
  const summary=selectionSummary(state.workspace,key(member),selectedIteration);
  const meter=capacityStatus(summary);
  const label=meter.status==='over' ? `Exceso: ${number(meter.hours-meter.capacity)} h` : meter.status==='full' ? 'Horas cubiertas' : meter.status==='zero' ? 'Sin capacidad' : meter.status==='unknown' ? (meter.capacity===null ? 'Capacidad sin definir' : `${meter.unknown} sin estimar`) : `${number(meter.capacity-meter.hours)} h libres`;
  return `<span class="person-hours">${number(meter.hours)} h${meter.capacity===null ? '' : ` / ${number(meter.capacity)} h`}</span><span class="person-meter meter-${meter.status}" role="meter" aria-label="Carga de ${escape(member.displayName)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(meter.percent)}" aria-valuetext="${escape(label)}"><span style="width:${meter.percent}%"></span></span><span class="person-load-label meter-text-${meter.status}">${escape(label)}</span>`;
}
// Step 1: the capacity and days off that the rest of the planning is measured
// against. Every edit is a local draft until the review writes it to Azure.
const dayValue = value => String(value ?? '').slice(0,10);
const nextDay = value => new Date(+new Date(`${value}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
function capacityDraftCount(ws = state?.workspace) { if(ws?.sources) return Math.max(Object.values(ws.capacityDrafts ?? {}).reduce((n,d)=>n+Object.keys(d).length,0),ws.projectAllocations?.filter(p=>JSON.stringify(p.entry)!==JSON.stringify(p.original)).length ?? 0); return Object.values(ws?.capacityDrafts ?? {}).reduce((sum,drafts)=>sum+Object.keys(drafts).length,0); }
function capacityOf(iterationId, owner) {
  const capacity=state.workspace.effectiveCapacities?.[iterationId] ?? {};
  const record=owner==='team' ? { daysOff:capacity.daysOff } : (capacity.teamMembers ?? []).find(m=>m.teamMember?.id===owner);
  return { activities:(record?.activities ?? []).map(a=>({name:a.name ?? '',capacityPerDay:Number(a.capacityPerDay ?? 0)})),
    daysOff:(record?.daysOff ?? []).map(r=>({start:dayValue(r.start),end:dayValue(r.end)})).sort((a,b)=>a.start.localeCompare(b.start)) };
}
function freeDay(ranges, iteration) {
  const first=dayValue(iteration.attributes?.startDate) || new Date().toISOString().slice(0,10), last=dayValue(iteration.attributes?.finishDate);
  let candidate=first;
  for (const range of [...ranges].sort((a,b)=>a.start.localeCompare(b.start))) if (candidate>=range.start && candidate<=range.end) candidate=nextDay(range.end);
  if (last && candidate>last) throw new Error('No quedan días libres disponibles dentro de la iteración.');
  return candidate;
}
function rangeEditor(owner, ranges, iteration) {
  const first=dayValue(iteration.attributes?.startDate), last=dayValue(iteration.attributes?.finishDate);
  const limits=first && last ? ` min="${first}" max="${last}"` : '';
  const field=(index,edge,range)=>`<input type="date" data-range data-owner="${escape(owner)}" data-index="${index}" data-edge="${edge}" data-focus="range:${escape(owner)}:${index}:${edge}" value="${escape(range[edge])}"${limits} aria-label="${edge==='start' ? 'Primer' : 'Último'} día libre">`;
  return `<div class="days-off">${ranges.map((range,index)=>`<div class="days-off-row">${field(index,'start',range)}<span aria-hidden="true">→</span>${field(index,'end',range)}<button class="button small" data-action="remove-range" data-owner="${escape(owner)}" data-index="${index}" data-focus="remove:${escape(owner)}:${index}" aria-label="Quitar estos días libres">Quitar</button></div>`).join('') || '<p class="text-muted">Sin días libres</p>'}<button class="button small" data-action="add-range" data-owner="${escape(owner)}" data-focus="add:${escape(owner)}">+ Días libres</button></div>`;
}
function capacityStatusLine(owner, drafts, conflicts) {
  if (conflicts[owner]) return '<p class="inline-error">Ha cambiado en Azure DevOps desde la importación. Revisa los cambios para elegir qué versión conservar.</p>';
  return drafts[owner] ? `<p class="local-note">Pendiente de sincronizar · <button class="link-button" data-action="discard-capacity-entry" data-owner="${escape(owner)}">deshacer</button></p>` : '';
}
let capacityEditor = null;
function capacityDates(iteration) {
  const start=dayValue(iteration.attributes?.startDate), end=dayValue(iteration.attributes?.finishDate), days=[];
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return days;
  for(let day=start;day<=end && days.length<367;day=nextDay(day)) days.push(day);
  return days;
}
const containsDay = (ranges, day) => ranges.some(r=>day>=r.start && day<=r.end);
function isWorkingDay(day) {
  const names=['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const weekday=new Date(day+'T00:00:00Z').getUTCDay();
  return (state.workspace.settings.workingDays ?? [1,2,3,4,5]).some(d=>d===weekday || String(d).toLowerCase()===names[weekday]);
}
function capacityBreakdown(owner, entry) {
  const days=capacityDates(selected()), team=capacityOf(selectedIteration,'team').daysOff;
  const working=days.filter(isWorkingDay);
  const available=working.filter(day=>!containsDay(entry.daysOff,day) && (owner==='team' || !containsDay(team,day)));
  const daily=entry.activities.reduce((sum,a)=>sum+Number(a.capacityPerDay || 0),0);
  return { days, working:working.length, available:available.length, off:working.length-available.length, daily, total:Math.round(available.length*daily*100)/100 };
}
function capacityView() {
  const ws=state.workspace, iteration=selected();
  if (!iteration || !ws.members.length) return '<div class="empty-result">Importa un equipo con integrantes e iteraciones para revisar la capacidad.</div>';
  const drafts=ws.capacityDrafts?.[iteration.id] ?? {}, conflicts=ws.capacityConflicts?.[iteration.id] ?? {}, hours=ws.capacityHours?.[iteration.id] ?? {};
  const known=ws.members.filter(m=>hours[m.id]!=null), total=known.reduce((sum,m)=>sum+hours[m.id],0);
  const team=capacityBreakdown('team',capacityOf(iteration.id,'team'));
  return `<section class="capacity-step">
    <header class="capacity-hero"><div><p class="eyebrow">PRIMERO, EL TIEMPO REAL</p><h2>El tiempo con el que cuenta el equipo.</h2><p>${escape(iteration.name)} · ${date(iteration.attributes?.startDate)} — ${date(iteration.attributes?.finishDate)}</p><span class="capacity-save-note">${ws.mode==='demo' ? 'Modo de ejemplo' : 'Guardado local · revisarás los cambios antes de enviarlos a Azure'}</span></div><div class="capacity-total"><strong>${number(total)}<small> h</small></strong><span>de capacidad${known.length<ws.members.length ? ' conocida' : ' del equipo'}</span><small>${known.length} de ${ws.members.length} personas con capacidad definida</small></div></header>
    <section class="capacity-shared"><div class="capacity-shared-icon" aria-hidden="true">☀</div><div><h3>Los días que descansáis juntos</h3><p>${team.off ? `${team.off} días laborables libres para todo el equipo` : 'Sin días libres comunes'} · ${team.available} días laborables disponibles</p>${capacityStatusLine('team',drafts,conflicts)}</div><button class="button" data-action="edit-capacity" data-owner="team">Editar calendario del equipo</button></section>
    <div class="capacity-section-title"><div><h3>El tiempo de cada persona</h3><p>Horas al día y ausencias. La capacidad se calcula al momento.</p></div>${Object.keys(drafts).length ? '<button class="button small" data-action="discard-capacity">Deshacer ajustes</button>' : ''}</div>
    <div class="capacity-people">${ws.members.map((member,index)=>({member,index,total:hours[member.id]})).sort((a,b)=>Number(a.total===0)-Number(b.total===0) || a.index-b.index).map(({member,index})=>{
      const entry=capacityOf(iteration.id,member.id), b=capacityBreakdown(member.id,entry), total=hours[member.id];
      return `<section class="capacity-card capacity-profile ${total===0 ? 'zero-capacity' : ''} ${drafts[member.id] ? 'changed' : ''}"><div class="capacity-person"><span class="avatar c${index%4}">${escape(initials(member.displayName))}</span><div><strong>${escape(member.displayName)}</strong><span class="text-muted">${total===0 ? 'Fuera del reparto' : entry.activities.length>1 ? `${entry.activities.length} actividades` : 'Disponibilidad en la iteración'}</span></div></div><div class="capacity-profile-total">${total==null ? '—' : number(total)}<small> h</small></div><p class="capacity-equation">${total===0 ? 'No aparecerá en las fases de reparto' : total==null ? 'Define las horas para empezar' : `${number(b.daily)} h al día × ${b.available} días disponibles`}</p><div class="capacity-mini-days" aria-label="${b.available} días disponibles, ${b.off} días libres">${b.days.filter(isWorkingDay).slice(0,40).map(day=>`<span class="${containsDay(entry.daysOff,day) || containsDay(capacityOf(iteration.id,'team').daysOff,day) ? 'off' : ''}" title="${date(day)}"></span>`).join('')}</div><div class="capacity-profile-footer"><span>${b.off ? `${b.off} días libres` : 'Sin ausencias'}${b.days.length ? '' : ' · fechas sin definir'}</span><button class="button small" data-action="edit-capacity" data-owner="${escape(member.id)}">Ajustar capacidad</button></div>${capacityStatusLine(member.id,drafts,conflicts)}</section>`;
    }).join('')}</div><div class="capacity-next"><span>${known.length<ws.members.length ? `${ws.members.length-known.length} personas con capacidad pendiente de definir` : 'La disponibilidad está lista. Puedes empezar a repartir el trabajo.'}</span><button class="button primary" data-action="tab" data-tab="hierarchy">Repartir ramas →</button></div>
  </section>`;
}
function editCapacity(owner) {
  const member=state.workspace.members.find(m=>m.id===owner);
  if(owner!=='team' && !member)return;
  capacityEditor={owner,...structuredClone(capacityOf(selectedIteration,owner))};
  if(owner!=='team' && !capacityEditor.activities.length)capacityEditor.activities=[{name:'',capacityPerDay:0}];
  showModal(owner==='team' ? 'Días libres del equipo' : `Capacidad de ${member.displayName}`, owner==='team' ? 'Marca los días en los que descansa todo el equipo.' : 'Ajusta las horas al día y marca las ausencias en el calendario.', `<form id="capacity-editor-form">
    ${owner==='team' ? '' : `<div class="capacity-editor-hours">${capacityEditor.activities.map((a,i)=>`<label class="form-field">${escape(a.name || 'Horas disponibles al día')}<div class="capacity-hour-input"><input type="number" required min="0" max="24" step="0.25" value="${a.capacityPerDay}" data-edit-activity="${i}" aria-label="${escape(a.name || 'Horas disponibles al día')}"><span>h / día</span></div></label>`).join('')}${capacityEditor.activities.length===1 ? '<div class="capacity-presets">'+[4,6,8].map(n=>`<button class="button small" type="button" data-action="capacity-preset" data-hours="${n}">${n} h</button>`).join('')+'</div>' : ''}</div>`}
    <div id="capacity-preview" aria-live="polite"></div><div class="capacity-calendar-heading"><strong>${owner==='team' ? 'Marca los días libres comunes' : 'Marca tus días libres'}</strong><button type="button" class="link-button" data-action="capacity-clear-days">Quitar ausencias</button></div><div class="capacity-calendar-legend"><span>● Disponible</span><span>○ Día libre</span><span>▧ Descanso del equipo</span></div><div id="capacity-calendar"></div><p class="local-note">Pulsa un día para marcarlo o volver a dejarlo disponible. Los descansos del equipo se descuentan una sola vez.</p></form>`, '<button class="button" data-action="close">Cancelar</button><button type="submit" form="capacity-editor-form" class="button primary">Guardar ajustes</button>');
  modal.classList.add('connection-modal','capacity-editor-modal');
  refreshCapacityEditor();
}
function refreshCapacityEditor() {
  const e=capacityEditor;if(!e || !$('#capacity-editor-form'))return;
  const b=capacityBreakdown(e.owner,e), before=state.workspace.capacityHours?.[selectedIteration]?.[e.owner];
  const team=capacityOf(selectedIteration,'team').daysOff;
  const total=e.owner==='team' ? state.workspace.members.reduce((sum,m)=>{const entry=capacityOf(selectedIteration,m.id);return sum+b.days.filter(day=>isWorkingDay(day)&&!containsDay(e.daysOff,day)&&!containsDay(entry.daysOff,day)).length*entry.activities.reduce((s,a)=>s+a.capacityPerDay,0);},0) : b.total;
  const difference=before==null || e.owner==='team' ? '' : total-before;
  $('#capacity-preview').innerHTML=`<div class="capacity-preview-total"><strong>${b.days.length ? number(total) : '—'}<small> h</small></strong><span>${e.owner==='team' ? 'de capacidad conocida en el equipo' : `${number(b.daily)} h × ${b.available} días disponibles`}</span></div><span class="capacity-preview-delta">${difference==='' ? `${b.off} días libres` : difference===0 ? 'Sin cambios en las horas totales' : `${difference>0 ? '+' : '−'}${number(Math.abs(difference))} h respecto a lo guardado`}</span>`;
  const months=new Map();for(const day of b.days){const month=day.slice(0,7);if(!months.has(month))months.set(month,[]);months.get(month).push(day);}
  $('#capacity-calendar').innerHTML=[...months].map(([month,days])=>{
    const offset=(new Date(days[0]+'T00:00:00Z').getUTCDay()+6)%7;
    return `<section class="capacity-month"><h3>${new Date(month+'-01T00:00:00Z').toLocaleDateString('es',{month:'long',year:'numeric',timeZone:'UTC'})}</h3><div class="capacity-day-grid">${['L','M','X','J','V','S','D'].map(day=>`<span class="weekday">${day}</span>`).join('')}${'<span></span>'.repeat(offset)}${days.map(day=>{const off=containsDay(e.daysOff,day),shared=e.owner!=='team' && containsDay(team,day),working=isWorkingDay(day);return `<button type="button" class="capacity-day ${off ? 'off' : ''} ${shared ? 'shared' : ''}" data-action="capacity-day" data-day="${day}" aria-label="${date(day)}: ${shared ? 'descanso del equipo' : !working ? 'no laborable' : off ? 'día libre' : 'disponible'}" aria-pressed="${off}" ${!working || shared ? 'disabled' : ''}>${Number(day.slice(8))}<small>${shared ? 'equipo' : !working ? '—' : off ? 'libre' : e.owner==='team' ? '✓' : `${number(b.daily)} h`}</small></button>`;}).join('')}</div></section>`;
  }).join('') || '<p class="notice warning">La iteración no tiene fechas definidas. Puedes ajustar las horas diarias; añade fechas en Azure para gestionar el calendario.</p>';
}
function toggleCapacityDay(day) {
  const ranges=capacityEditor.daysOff;
  if(containsDay(ranges,day)) capacityEditor.daysOff=ranges.flatMap(r=>day<r.start || day>r.end ? [r] : [...(r.start<day ? [{start:r.start,end:new Date(Date.parse(day)-86400000).toISOString().slice(0,10)}] : []),...(day<r.end ? [{start:nextDay(day),end:r.end}] : [])]);
  else {
    const sorted=[...ranges,{start:day,end:day}].sort((a,b)=>a.start.localeCompare(b.start)), merged=[];
    for(const r of sorted){const last=merged.at(-1);if(last && r.start<=nextDay(last.end))last.end=last.end>r.end ? last.end : r.end;else merged.push({...r});}
    capacityEditor.daysOff=merged;
  }
  refreshCapacityEditor();
  $(`[data-day="${day}"]`,modal)?.focus();
}
async function saveCapacity(owner, change, focus) {
  // The request disables every control, so the target is read before sending.
  const active=focus || capacityFocus(document.activeElement);
  await request('/api/capacity',{ iterationId:selectedIteration, key:owner, ...change });
  review=null; render();
  if (active) $(active)?.focus();
}
// Saving re-renders the step, so the control the person moved to is restored.
function capacityFocus(element) { return element?.dataset?.focus ? `[data-focus="${element.dataset.focus}"]` : ''; }
async function saveCapacityHours(el) {
  const entry=capacityOf(selectedIteration,el.dataset.member), position=Number(el.dataset.activity);
  const value=el.value==='' ? null : Number(el.value);
  if (value!==null && !Number.isFinite(value)) throw new Error('Indica un número de horas válido.');
  const activities=entry.activities.length ? entry.activities.map((activity,index)=>index===position ? {...activity,capacityPerDay:value ?? 0} : activity)
    : value===null ? [] : [{name:'',capacityPerDay:value}];
  await saveCapacity(el.dataset.member,{ activities });
}
async function saveCapacityRange(el) {
  if (!el.value) return;
  const owner=el.dataset.owner, position=Number(el.dataset.index);
  const daysOff=capacityOf(selectedIteration,owner).daysOff.map((range,index)=>index===position ? {...range,[el.dataset.edge]:el.value} : range);
  // Keep the range valid while the person is still choosing the other end.
  if (daysOff[position].end<daysOff[position].start) daysOff[position][el.dataset.edge==='start' ? 'end' : 'start']=el.value;
  await saveCapacity(owner,{ daysOff });
}
let planningMode = 'team';
function plannerView() {
  const iteration=selected();
  if (!iteration) return '<div class="empty-result">Selecciona una iteración para elegir tareas.</div>';
  return `<div class="planning-view-switch"><div><h2>Elegir tareas</h2><p>Organiza el plan del equipo o elige las tareas de una persona.</p></div><div class="planning-view-options" role="group" aria-label="Vista de planificación"><button type="button" data-action="planning-view" data-view="team" aria-pressed="${planningMode==='team'}">Vista del equipo</button><button type="button" data-action="planning-view" data-view="person" aria-pressed="${planningMode==='person'}">Por persona</button></div></div>${planningMode==='team' ? board(iteration,state.workspace.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath===iteration.path)) : personPlannerView()}`;
}
function personPlannerView() {
  ensureSelection();const ws=state.workspace,iteration=selected();
  if(!iteration || !planningMembers().length)return '<div class="empty-result">No hay personas con capacidad para repartir trabajo en esta iteración.</div>';
  return `<div class="continuous-planner"><div class="planning-people" aria-label="Personas del equipo">${orderedPlanningMembers(ws,selectedIteration).map(({member:m,index,canConfirm,confirmed})=>`<div class="planning-person-card ${key(m)===pickerMember ? 'active' : ''}"><button class="planning-person" data-action="choose-person" data-member="${escape(key(m))}" aria-pressed="${key(m)===pickerMember}"><span class="person-name"><span class="avatar c${index%4}">${escape(initials(m.displayName))}</span><strong>${escape(m.displayName)}</strong></span>${personMeter(m)}${key(m)===pickerMember ? '<span class="assigning-label">Asignando ahora</span>' : ''}</button>${canConfirm ? `<button class="person-confirm ${confirmed ? 'confirmed' : ''}" data-action="confirm-person" data-member="${escape(key(m))}" aria-label="${confirmed ? 'Reparto confirmado de' : 'Confirmar reparto de'} ${escape(m.displayName)}" ${confirmed ? 'disabled' : ''}>${confirmed ? '✓ Confirmado en local' : 'Confirmar'}</button>` : ''}</div>`).join('')}</div><section class="planning-work" aria-label="Tareas de ${escape(memberName(pickerMember))}"><div class="active-assignee"><span class="avatar">${escape(initials(memberName(pickerMember)))}</span><div><span>Asignando tareas a</span><h2>${escape(memberName(pickerMember))}</h2></div></div><div class="planning-work-heading"><input id="picker-search" placeholder="Buscar tarea o rama" aria-label="Buscar tareas de esta persona" value="${escape(pickerQuery)}"><label class="show-unavailable"><input id="show-unavailable" type="checkbox" ${onlyAvailable ? '' : 'checked'}>Con otro responsable</label></div><div class="picker-toolbar"><label class="bulk-selection"><input id="toggle-visible" type="checkbox">Marcar visibles</label><span class="local-note">Borrador local · asignaciones pendientes de sincronizar</span></div><div id="picker-tree">${treeView({picker:true,member:pickerMember,search:pickerQuery})}</div></section></div>`;
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
  const scroll=$('#picker-tree')?.scrollTop || 0, peopleScroll=$('.planning-people')?.scrollTop || 0;
  render();
  if($('#picker-tree'))$('#picker-tree').scrollTop=scroll;
  if($('.planning-people'))$('.planning-people').scrollTop=peopleScroll;
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
  $('#planning-view').innerHTML=stepView();
  updateBulkCheckbox();
}

function taskCard(item, inBacklog = false) {
  const effort = item.remainingWork !== null ? `${number(item.remainingWork)} h` : item.points !== null ? `${number(item.points)} pts` : 'Sin estimar';
  return `<article class="task-card ${item.modified ? 'modified' : ''}" draggable="true" data-task="${item.id}" data-action="edit" tabindex="0" role="button" aria-label="Editar #${item.id}: ${escape(item.title)}">
    <div class="task-meta"><span class="type-icon ${item.type === 'Bug' ? 'bug' : ''}">${item.type === 'Bug' ? '◆' : '▣'}</span><span>#${item.id}</span>${azureLink(item)}<span>· ${escape(item.type)}</span>${item.modified ? `<span class="pill changed">${pendingLabel(item)}</span>` : ''}</div>
    <p class="task-title">${item.project ? `<small class="pill">${escape(item.project)}</small> ` : ''}${escape(item.title)}</p>
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
  const members=planningMembers(iteration.id), activeKeys=new Set(members.map(key));
  const eligible = new Set(focusedMember ? eligibleTasks(ws,focusedMember,iteration.id).map(i=>i.id) : []);
  const unassigned = planned.filter(i=>!i.assignedTo && (!focusedMember || eligible.has(i.id)));
  const outside = planned.filter(i=>(!focusedMember || eligible.has(i.id)) && i.assignedTo && !ws.members.some(m=>key(m) === i.assignedTo));
  const excluded=planned.filter(i=>i.assignedTo && ws.members.some(m=>key(m)===i.assignedTo) && !activeKeys.has(i.assignedTo));
  const considered=planned.length-excluded.length;
  return `<div class="board"><section class="backlog" data-drop="backlog"><div class="section-heading"><h2>Backlog disponible</h2><span class="count">${backlog.length}</span></div><p class="section-meta">Pendientes y tareas de otras iteraciones</p>${treeView({availableOnly:true})}</section><section><div class="section-heading"><h2>Plan de la iteración</h2><span class="count">${considered} tareas${excluded.length ? ` · ${excluded.length} fuera del reparto` : ''}</span></div><p class="section-meta">Reparte el trabajo según la capacidad del equipo</p><div class="members-grid">${members.filter(m=>!focusedMember || key(m)===focusedMember).map((m,index)=>lane(m,planned,index,iteration)).join('')}<section class="member" data-drop=""><div class="member-header"><div class="section-heading"><h3>Sin asignar</h3><span class="count">${unassigned.length}</span></div><p class="section-meta" style="margin:0">Dentro de esta iteración</p></div><div class="member-items">${filtered(unassigned).map(i=>taskCard(i)).join('') || '<div class="drop-hint">Reserva trabajo para esta iteración</div>'}</div></section>${excluded.length ? `<section class="member zero-capacity"><div class="member-header"><h3>Fuera del reparto</h3><p class="section-meta" style="margin:0">Tareas asignadas a personas con capacidad 0</p></div><div class="member-items">${filtered(excluded).map(i=>taskCard(i)).join('')}</div></section>` : ''}${outside.length ? `<section class="member"><div class="member-header"><h3>Otras personas</h3><p class="section-meta" style="margin:0">Responsables que no figuran en este equipo</p></div><div class="member-items">${filtered(outside).map(i=>taskCard(i)).join('')}</div></section>` : ''}</div></section></div><p class="bottom-note">Arrastra tareas para planificar. Pulsa una tarjeta para editar con teclado o en móvil. Las horas y los puntos se mantienen separados.</p>`;
}

function render() {
  const ws=state.workspace;
  $('#connection-button').textContent=state.config ? 'Configuración' : 'Conectar Azure DevOps';
  $('#save-status').textContent=ws ? savedStatus() : '';
  const section = ({ home: 'Inicio', permissions: 'Permisos', maintenance: 'Mantenimiento' })[tab] || 'Planificación';
  $('.workspace-label').textContent = section;
  $('#app').setAttribute('aria-label', section);
  if (securitySnapshot?.scope !== JSON.stringify([state.config?.organization, state.config?.project])) securitySnapshot = null;
  if (maintenanceSnapshot?.scope !== JSON.stringify([state.mode, state.config?.organization, state.config?.project])) maintenanceSnapshot = null;
  if (tab === 'home') { $('#app').innerHTML = homeView(); return; }
  if (tab === 'maintenance') { $('#app').innerHTML = maintenanceView(maintenanceSnapshot, state, maintenanceSetup); return; }
  if (tab === 'permissions') { $('#app').innerHTML = permissionsView(securitySnapshot, state.config); return; }
  if(!ws){
    $('#app').innerHTML=`<div class="empty-panel"><h1>Planifica tu iteración</h1><button class="button primary" data-action="${state.config ? 'import' : 'connect'}">${state.config ? 'Importar equipo' : 'Conectar Azure DevOps'}</button><button class="button" data-action="demo">Probar con un ejemplo</button></div>`;return;
  }
  if(focusedMember && !ws.members.some(m=>key(m)===focusedMember))focusedMember='';
  const iteration=selected();ensureSelection();
  const changes=Object.keys(ws.drafts).length+capacityDraftCount(ws);
  $('#app').innerHTML=`<div class="workspace-controls"><span class="team-label">${ws.sources ? ws.sources.map(s=>escape(s.config.project)).join(' · ') : escape(ws.config.project)+' / '+escape(ws.config.team)}</span>${ws.mode==='azure' ? '<button class="button small" data-action="connect">+ Añadir proyecto</button>' : ''}${ws.mode==='demo' ? '<span class="pill demo">Ejemplo</span>' : ''}<button class="button small" data-action="create">+ Crear</button>${iteration ? `<button class="button small iteration-select" data-action="tab" data-tab="iteration" title="Cambiar la iteración que se planifica">Planificando ${escape(iteration.name)} · Cambiar</button>` : ''}<div class="workspace-data-actions"><button class="button small" data-action="import" ${Object.keys(ws.drafts).length || Object.keys(ws.capacityDrafts ?? {}).length || ws.mode==='demo' ? 'disabled' : ''} title="${ws.mode==='demo' ? 'Conecta Azure DevOps para actualizar datos' : changes ? 'Revisa o descarta los cambios pendientes antes de actualizar' : 'Actualizar desde Azure DevOps'}">Actualizar toda la planificación</button><a class="button small" href="/api/export" download>Exportar</a>${ws.mode==='demo' ? '<button class="button small subtle" data-action="azure">Salir del ejemplo</button>' : ''}</div></div>
  ${stepTabs(changes)}
  <div id="planning-view">${ws.sources && tab==='planning' ? allocationView() : ''}${stepView()}</div>
  ${ws.warnings.length ? `<details class="import-notices"><summary>${ws.warnings.length} avisos de importación</summary>${ws.warnings.map(w=>`<p>${escape(w)}</p>`).join('')}</details>` : ''}`;
  updateBulkCheckbox();
}
function editTask(id) {
  const ws = state.workspace, item = ws.effectiveItems.find(i=>i.id === id);
  if (!item) throw new Error('La tarea ya no está disponible.');
  if (item.contextOnly) {toast('Este elemento es solo contexto de otro equipo.');return;}
  const paths = [{ path:ws.settings.backlogIteration.path, name:'Backlog' },...planningIterations()];
  if (!paths.some(i=>i.path === item.iterationPath)) paths.push({ path:item.iterationPath, name:iterationName(item.iterationPath) });
  showModal(`#${id} · ${item.type}`, item.title, `${azureLink(item) ? `<p class="azure-open">${azureLink(item,'Abrir en Azure DevOps ↗')}</p>` : ''}<form id="task-form" data-task="${id}"><label class="form-field">Título<input name="title" required maxlength="255" value="${escape(item.title)}"></label><label class="form-field">Responsable<select name="assignedTo"><option value="">Sin asignar</option>${ws.members.map(m=>`<option value="${escape(key(m))}" ${key(m) === item.assignedTo ? 'selected' : ''}>${escape(m.displayName)}</option>`).join('')}${item.assignedTo && !ws.members.some(m=>key(m) === item.assignedTo) ? `<option value="${escape(item.assignedTo)}" selected>${escape(item.assigneeName || item.assignedTo)} (fuera del equipo)</option>` : ''}</select></label><label class="form-field">Iteración<select name="iterationPath">${paths.map(i=>`<option value="${escape(i.path)}" ${item.iterationPath === i.path ? 'selected' : ''}>${escape(i.name)}</option>`).join('')}</select></label><div class="grid2">${item.canPrioritize ? `<label class="form-field">Prioridad<select name="priority">${[1,2,3,4].map(p=>`<option value="${p}" ${item.priority === p ? 'selected' : ''}>P${p} · ${['Crítica','Alta','Media','Baja'][p-1]}</option>`).join('')}</select></label>` : ''}${item.canEstimateHours ? `<label class="form-field">Horas pendientes<input name="remainingWork" type="number" min="0" max="100000" step="0.25" value="${item.remainingWork ?? ''}" placeholder="Sin estimar"><small>Se guardan como trabajo restante.</small></label>` : `<div class="form-field">Estimación<span class="text-muted">${item.points !== null ? `${number(item.points)} puntos` : 'Sin estimar'} · consulta</span></div>`}</div><div class="notice">${ws.mode === 'demo' ? 'Datos de ejemplo. Puedes probar los cambios sin afectar a Azure DevOps.' : 'Este cambio se guarda en local. Se enviará cuando revises y confirmes la sincronización.'}</div></form>`, `${item.modified ? `<button class="button danger" data-action="discard-one" data-task="${id}">Deshacer cambios</button>` : '<button class="button" data-action="close">Cancelar</button>'}<button class="button primary" type="submit" form="task-form">Guardar en local</button>`);
  restrictAssignees($('#task-form [name="assignedTo"]'),item.assignedTo);
}
async function stage(id, changes) {
  await request('/api/stage', { edits:[{ id, changes }] }); review = null; render();
}
async function reviewChanges() {
  showModal('Revisar cambios', 'Comprobando la última versión de cada tarea y de la capacidad.', '<div id="connection-progress"></div>');
  const result = await importWithProgress($('#connection-progress'), null, { path: '/api/review', input: {}, title: 'Revisando cambios' });
  review = result.review; render(); renderReview();
}
function capacityText(entry, owner) {
  const hours=owner==='team' ? '' : entry.activities?.length ? entry.activities.map(a=>`${number(a.capacityPerDay)} h/día${a.name ? ` · ${a.name}` : ''}`).join(' + ') : '0 h/día';
  const off=entry.daysOff?.length ? entry.daysOff.map(r=>r.start===r.end ? date(r.start) : `${date(r.start)} – ${date(r.end)}`).join(', ') : 'sin días libres';
  return [hours,off].filter(Boolean).join(' · ');
}
function allocationView() {
  const ws=state.workspace;
  if(!ws?.sources) return '';
  const iteration=selected(), members=planningMembers(iteration?.id), plans=(ws.projectAllocations ?? []).filter(p=>p.iterationId===iteration?.id && members.some(m=>m.id===p.key));
  return `<section class="review-item project-allocation"><h2>Capacidad por proyecto</h2><p>Una capacidad por persona. Se reparte en proporción a las horas de sus tareas en esta iteración. Las personas con capacidad 0 quedan fuera.</p><div class="table-wrap"><table><thead><tr><th>Persona</th>${ws.sources.map(s=>`<th>${escape(s.config.project)}</th>`).join('')}<th>Sin repartir</th></tr></thead><tbody>${members.map(member=>{
    const rows=plans.filter(p=>p.key===member.id), available=ws.capacityHours?.[iteration?.id]?.[member.id] ?? 0;
    return `<tr><th>${escape(member.displayName)}<small class="text-muted"> · ${number(available)} h totales</small></th>${ws.sources.map(s=>{const p=rows.find(p=>p.sourceId===s.id);return `<td>${p ? p.missingEstimate ? 'Falta estimar' : `${number(p.allocated)} h <small>(${number(p.ratio*100)} %)</small><br><small>${number(p.hours)} h de tareas</small>` : 'Sin equipo o iteración'}</td>`;}).join('')}<td>${number(Math.max(0,available-rows.reduce((n,p)=>n+p.allocated,0)))} h</td></tr>`;
  }).join('')}</tbody></table></div><p class="local-note">Azure guarda horas por día con dos decimales. El reparto puede variar unas centésimas por redondeo y respeta los días libres de cada proyecto.</p></section>`;
}
function capacityReview() {
  const plans=review.capacityPlans ?? [];
  if (!plans.length) return '';
  return `<h3 class="review-section">Capacidad y días libres</h3>${plans.map(plan=>`<section class="review-item"><h3>${escape(plan.iteration)} · ${escape(plan.label)}</h3>${plan.sourceId ? `<p class="local-note">${number(plan.hours)} h de tareas · ${number(plan.ratio*100)} % de la capacidad · ${number(plan.allocated)} h disponibles en este proyecto</p>` : ''}<div class="change-row"><span class="change-label">${plan.key==='team' ? 'Días libres' : 'Capacidad'}</span><span class="change-old">${escape(capacityText(plan.remote,plan.key))}${plan.conflict ? `<small>Al importar: ${escape(capacityText(plan.original,plan.key))}</small>` : ''}</span><span>→</span><span class="change-new">${escape(capacityText(plan.after,plan.key))}${plan.conflict ? ' ⚠' : ''}</span></div>${plan.conflict ? `<p class="local-note">La capacidad ha cambiado en Azure DevOps desde tu importación.</p><div class="conflict-actions">${plan.sourceId ? '' : `<button class="button small" data-action="resolve-capacity-remote" data-iteration="${escape(plan.iterationId)}" data-owner="${escape(plan.key)}">Conservar la de Azure</button>`}<button class="button small" data-source="${escape(plan.sourceId || '')}" data-action="resolve-capacity-local" data-iteration="${escape(plan.iterationId)}" data-owner="${escape(plan.key)}">Mantener mis cambios</button></div>` : ''}${plan.applied && !plan.conflict ? '<p class="local-note">Estos valores ya están aplicados. Se actualizará la copia local.</p>' : ''}</section>`).join('')}`;
}
function renderReview() {
  const conflicts = review.plans.filter(p=>p.conflicts.length);
  showModal(state.mode === 'demo' ? 'Simular sincronización' : 'Revisar y sincronizar', `${review.plans.length} tareas${review.capacityPlans?.length ? ` · ${review.capacityPlans.length} ajuste${review.capacityPlans.length===1 ? '' : 's'} de capacidad` : ''} · ${state.mode === 'demo' ? 'datos de ejemplo' : 'comparados con la versión actual de Azure DevOps'}`, `<p class="local-note">Las asignaciones de responsable se sincronizan. El reparto de ramas entre varias personas y las confirmaciones son organización local.</p>${conflicts.length || review.capacityPlans?.some(p=>p.conflict) ? '<div class="notice warning" style="margin-bottom:20px">Algo ha cambiado en Azure DevOps. Elige qué versión conservar y vuelve a revisar antes de sincronizar.</div>' : ''}${review.plans.map(p=>`<section class="review-item"><h3>${p.creation ? 'Nuevo · Crear' : '#'+p.id+' · Modificar'} · ${escape(p.title)}${p.creation ? '' : ' '+azureLink(state.workspace.items.find(i=>i.id===p.id))}</h3>${p.changes.map(c=>`<div class="change-row"><span class="change-label">${escape(c.label)}</span><span class="change-old">${escape(pretty(c.field,c.before))}${c.conflict ? `<small>Al importar: ${escape(pretty(c.field,c.original))}</small>` : ''}</span><span>→</span><span class="change-new">${escape(pretty(c.field,c.after))}${c.conflict ? ' ⚠' : ''}</span></div>`).join('')}${p.conflicts.length ? `<p class="local-note">La versión remota ha cambiado desde tu importación.</p><div class="conflict-actions"><button class="button small" data-action="resolve-remote" data-task="${p.id}">Conservar versión de Azure</button><button class="button small" data-action="resolve-local" data-task="${p.id}">Mantener mis cambios</button></div>` : ''}${!Object.keys(p.updates).length ? '<p class="local-note">Estos valores ya están aplicados. Se actualizará la copia local.</p>' : ''}</section>`).join('')}${allocationView()}${capacityReview()}`, `<button class="button danger" data-action="discard-all">Descartar cambios</button><button class="button" data-action="close">Seguir planificando</button>${review.token ? `<button class="button primary" data-action="sync">${state.mode === 'demo' ? 'Confirmar simulación' : 'Sincronizar con Azure DevOps'} ↗</button>` : ''}`);
}
async function synchronize() {
  const title = state.mode === 'demo' ? 'Simulando sincronización' : 'Sincronizando cambios';
  showModal(title, 'Enviando los cambios revisados.', '<div id="connection-progress"></div>');
  const data = await importWithProgress($('#connection-progress'), null, { path: '/api/sync', input: { token: review.token }, title });
  review = null; render();
  const result = data.result, capacity = result.capacity ?? { successes:[], failures:[] };
  const failed = result.failures.length + capacity.failures.length;
  const confirmed = [`${result.successes.length} tarea${result.successes.length===1 ? '' : 's'}`, ...(capacity.successes.length ? [`${capacity.successes.length} ajuste${capacity.successes.length===1 ? '' : 's'} de capacidad`] : [])];
  showModal(failed ? 'Sincronización parcial' : result.demo ? 'Simulación completada' : 'Cambios sincronizados', `Se han confirmado ${confirmed.join(' y ')}${result.demo ? ' en el ejemplo local' : ' en Azure DevOps'}.`, `${failed ? `<div class="notice warning">Los cambios pendientes se conservan en local. Vuelve a revisarlos para reintentar solo lo que falta.</div>${result.failures.map(f=>`<p class="inline-error" style="margin-top:15px">#${f.id} ${azureLink(state.workspace?.items.find(i=>i.id===f.id))}: ${escape(f.error)}</p>`).join('')}${capacity.failures.map(f=>`<p class="inline-error" style="margin-top:15px">${escape(f.label)}: ${escape(f.error)}</p>`).join('')}` : `<div class="notice">${result.demo ? 'La simulación solo ha actualizado los datos de ejemplo de este equipo.' : 'La copia local refleja los cambios confirmados por Azure DevOps.'}</div>`}`, `${failed ? '<button class="button primary" data-action="review">Revisar pendientes</button>' : '<button class="button primary" data-action="close">Volver a la planificación</button>'}`);
}
async function refreshPlanningSection(section) {
  const title=({iterations:'Actualizar iteraciones',capacity:'Actualizar capacidad',tasks:'Actualizar tareas y jerarquía'})[section];
  showModal(title,'Se conservan los datos y cambios locales de las demás secciones.','<div id="connection-progress"></div>');
  await importWithProgress($('#connection-progress'),null,{path:'/api/refresh-section',input:{section},title});
  modal.close();render();toast('Sección actualizada desde Azure DevOps.');
}
async function importData(refreshAll = true) {
  showModal('Actualizar todos los proyectos', 'Leyendo los proyectos importados y sus tareas abiertas.', '<div id="connection-progress"></div>');
  await importWithProgress($('#connection-progress'),null,{path:'/api/import',input:{refreshAll:refreshAll!==false},title:refreshAll===false ? 'Importando proyecto' : 'Actualizando todos los proyectos'}); modal.close(); render(); toast('Datos actualizados desde Azure DevOps.');
}
async function loadSecurity() {
  const response = await fetch('/api/security', { headers: { 'X-Neo-CSRF': state.csrf } });
  if (!response.ok) throw new Error('No se pudo recuperar el informe de permisos.');
  securitySnapshot = (await response.json()).security;
}
async function securityQuery(descriptor, reauthenticate = false) {
  showModal(descriptor ? 'Analizar permisos' : 'Cargar grupos de permisos', 'Consulta de seguridad de Azure DevOps.', '<div id="connection-progress"></div>');
  try {
    const result = await importWithProgress($('#connection-progress'), null, { path: descriptor ? '/api/security-audit' : '/api/security-groups', input: { descriptor, reauthenticate } });
    securitySnapshot = result.security;
    resetPermissionFilters(); tab = 'permissions'; modal.close(); render();
  } catch (error) {
    if (/\bAzure HTTP 401\b/.test(error.message)) {
      $('.modal-footer').innerHTML = `<button class="button" data-action="connect">Revisar conexión</button><button class="button primary" data-action="security-reconnect" data-descriptor="${escape(descriptor || '')}">Elegir cuenta en el navegador y reintentar</button>`;
    }
    throw error;
  }
}
// Home: the entry point to every area of the team management.
function homeView() {
  const ws=state.workspace, iteration=ws ? selected() : null, changes=ws ? Object.keys(ws.drafts).length+capacityDraftCount(ws) : 0;
  const team=state.config?.team ? `${state.config.project} / ${state.config.team}` : ws ? `${ws.config.project} / ${ws.config.team}` : 'Neo Team';
  const planning=!ws ? 'Sin datos importados' : `${iteration ? `Planificando ${escape(iteration.name)}` : 'Sin iteraciones'}${changes ? ` · ${changes} pendiente${changes===1 ? '' : 's'} de sincronizar` : ''}`;
  const issues=maintenanceSnapshot?.issues;
  return `<section class="home"><header class="home-heading"><p class="eyebrow">GESTIÓN DEL EQUIPO</p><h1>${escape(team)}</h1><p>Elige por dónde empezar.</p></header><div class="home-sections">
    <button class="home-card" data-action="open-planning"><span class="home-icon" aria-hidden="true">◷</span><strong>Planificación</strong><span>Iteraciones, capacidad y reparto de tareas del equipo.</span><small>${planning}</small></button>
    <button class="home-card maintenance" data-action="open-maintenance"><span class="home-icon" aria-hidden="true">⚙</span><strong>Mantenimiento</strong><span>${escape(state.maintenanceSettings?.type || 'Functional Issue')} no cerrados del proyecto.</span><small>${issues ? `${issues.length} no cerrado${issues.length===1 ? '' : 's'} en la última consulta` : state.maintenanceSettings ? 'Se consultan al entrar' : 'Primero eliges qué estados son cerrados'}</small></button>
  </div></section>`;
}
async function loadMaintenance() {
  const response = await fetch('/api/maintenance', { headers: { 'X-Neo-CSRF': state.csrf } });
  if (!response.ok) throw new Error('No se pudo recuperar la consulta de mantenimiento.');
  maintenanceSnapshot = (await response.json()).maintenance;
}
async function maintenanceQuery() {
  const settings = state.maintenanceSettings;
  showModal(`Consultar ${settings.type}`, `${state.mode === 'demo' ? 'Datos de ejemplo' : state.config.project} · estados distintos de ${settings.closedStates.join(', ') || 'ninguno'}.`, '<div id="connection-progress"></div>');
  const result = await importWithProgress($('#connection-progress'), null, { path: '/api/maintenance', input: {}, title: `Consultando ${settings.type} no cerrados` });
  maintenanceSnapshot = result.maintenance; tab = 'maintenance'; modal.close(); render();
}
function exportSecurity() {
  const blob = new Blob([JSON.stringify(securitySnapshot, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'neo-team-permisos.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const actions = {
  permissions: async () => { await loadSecurity(); resetPermissionFilters(); tab = 'permissions'; render(); if (!securitySnapshot && state.config?.project) await securityQuery(); },
  'security-back': () => { tab = 'capacity'; render(); },
  'security-reconnect': el => securityQuery(el.dataset.descriptor || undefined, true),
  'security-refresh': () => securityQuery(),
  'security-group': el => securityQuery(el.dataset.descriptor),
  'security-export': exportSecurity,
  'security-copy-source': async el => { await navigator.clipboard.writeText(JSON.stringify(securitySnapshot.report.coverage[Number(el.dataset.index)].diagnostics, null, 2)); toast('Diagnóstico de la petición copiado.'); },
  'security-diagnostics': async () => { await navigator.clipboard.writeText(JSON.stringify(securitySnapshot.catalog.diagnostics, null, 2)); toast('Diagnóstico copiado. No contiene credenciales ni nombres de usuarios.'); },
  'security-page': el => filterPermissions(securitySnapshot.report, 'page', el.dataset.direction),
  home: () => { tab = 'home'; render(); window.scrollTo({ top: 0 }); },
  'open-planning': () => { tab = 'iteration'; render(); },
  'open-maintenance': async () => {
    await loadMaintenance(); maintenanceSetup = null; tab = 'maintenance'; render();
    if (!maintenanceSnapshot && state.maintenanceSettings && (state.config?.project || state.mode === 'demo')) await maintenanceQuery();
  },
  'maintenance-refresh': () => maintenanceQuery(),
  'maintenance-edit-settings': () => { maintenanceSetup = { type: state.maintenanceSettings.type, states: state.maintenanceSettings.states }; render(); },
  'maintenance-cancel-settings': () => { maintenanceSetup = null; render(); },
  'maintenance-load-states': async () => {
    const type = $('#maintenance-type').value.trim();
    if (!type) throw new Error('Indica el tipo de elemento.');
    showModal('Cargar estados', `Estados posibles de «${type}» en el proyecto.`, '<div id="connection-progress"></div>');
    const result = await importWithProgress($('#connection-progress'), null, { path: '/api/maintenance-states', input: { type }, title: `Consultando los estados de «${type}»` });
    maintenanceSetup = { type: result.type, states: result.states }; modal.close(); render();
  },
  'refresh-section':el=>refreshPlanningSection(el.dataset.section),
  connect: connection, close: () => modal.close(), 'save-config':()=>saveConfig(false),
  demo: async()=>{ await request('/api/mode',{ mode:'demo' }); selectedIteration=''; tab='iteration'; render(); },
  azure: async()=>{ await request('/api/mode',{ mode:'azure' }); selectedIteration=''; tab='iteration'; render(); },
  import: importData,
  create: el=>createItem(Number(el.dataset.parent)),
  edit: el=>editTask(Number(el.dataset.task)),
  participants: el=>editParticipants(Number(el.dataset.task),el),
  'remove-branch': el=>saveParticipation(Number(el.dataset.task),pickerMember,false),
  'pick-tasks': el=>pickTasks(el.dataset.member),
  'choose-iteration': el=>{selectedIteration=el.dataset.iteration;tab='previous';render();window.scrollTo({top:0});},
  'carry-over': el=>decidePrevious(Number(el.dataset.task),'carry'),
  'complete-task': el=>decidePrevious(Number(el.dataset.task),'complete'),
  'to-backlog': el=>decidePrevious(Number(el.dataset.task),'backlog'),
  'edit-completed-state': el=>chooseCompletedState(el.dataset.type,null,null,el.dataset.source || undefined),
  'load-work-item-states': async()=>{
    const {type,taskId,sourceId}=completedStateChoice;
    const result=await importWithProgress($('#connection-progress'),null,{path:'/api/work-item-states',input:{type,...(sourceId ? {sourceId} : {})},title:`Consultando los estados de «${type}»`});
    chooseCompletedState(type,taskId,result.states,sourceId);
  },
  'undo-previous': el=>decidePrevious(Number(el.dataset.task),'undo'),
  'choose-person': el=>choosePerson(el.dataset.member),
  'planning-view':el=>{planningMode=el.dataset.view;focusedMember=planningMode==='team' ? '' : pickerMember;query='';render();$(`[data-action="planning-view"][data-view="${planningMode}"]`)?.focus({preventScroll:true});},
  'confirm-person': async el=>{await request('/api/confirm-person',{member:el.dataset.member,iterationId:selectedIteration});renderSaved();},
  'go-sharing': ()=>{tab='hierarchy';focusedMember='';query='';backlogFilter='all';render();},
  'expand-tree': ()=>{collapsed.clear();updatePlanningView();},
  'collapse-tree': ()=>{state.workspace.items.filter(i=>!isExecutable(i)).forEach(i=>collapsed.add(i.id));updatePlanningView();},
  tab: el=>{tab=el.dataset.tab;if(tab==='planning' && focusedMember)pickerMember=focusedMember;render();},
  review: reviewChanges, sync:synchronize,
  'discard-all':()=>showModal('Descartar cambios locales', 'Esta acción afecta al borrador de la planificación actual.', '<p>Se recuperarán los valores de la última importación o sincronización. Azure DevOps no se modificará.</p>','<button class="button" data-action="close">Cancelar</button><button class="button danger" data-action="confirm-discard">Descartar borrador</button>'),
  'confirm-discard':async()=>{await request('/api/discard');modal.close();render();toast('Borrador descartado.');},
  'discard-one':async el=>{await request('/api/discard',{id:Number(el.dataset.task)});modal.close();render();toast('Cambios de la tarea deshechos.');},
  'edit-capacity':el=>editCapacity(el.dataset.owner),
  'capacity-day':el=>toggleCapacityDay(el.dataset.day),
  'capacity-clear-days':()=>{capacityEditor.daysOff=[];refreshCapacityEditor();},
  'capacity-preset':el=>{capacityEditor.activities[0].capacityPerDay=Number(el.dataset.hours);$('[data-edit-activity]',modal).value=el.dataset.hours;refreshCapacityEditor();},
  'add-range':async el=>{
    const owner=el.dataset.owner,ranges=capacityOf(selectedIteration,owner).daysOff,day=freeDay(ranges,selected());
    await saveCapacity(owner,{daysOff:[...ranges,{start:day,end:day}]},`[data-focus="range:${owner}:${ranges.length}:start"]`);
  },
  'remove-range':async el=>{
    const owner=el.dataset.owner,index=Number(el.dataset.index);
    await saveCapacity(owner,{daysOff:capacityOf(selectedIteration,owner).daysOff.filter((_,position)=>position!==index)});
  },
  'discard-capacity':async()=>{await request('/api/discard-capacity',{iterationId:selectedIteration});review=null;render();toast('Cambios de capacidad deshechos.');},
  'discard-capacity-entry':async el=>{await request('/api/discard-capacity',{iterationId:selectedIteration,key:el.dataset.owner});review=null;render();},
  'resolve-capacity-local':el=>resolveCapacity(el.dataset.iteration,el.dataset.owner,'local',el.dataset.source),
  'resolve-capacity-remote':el=>resolveCapacity(el.dataset.iteration,el.dataset.owner,'remote'),
  'resolve-local':el=>resolveTask(Number(el.dataset.task),'local'),
  'resolve-remote':el=>resolveTask(Number(el.dataset.task),'remote'),
};
async function resolveCapacity(iterationId,owner,choice,sourceId) {
  await request('/api/resolve-capacity',{iterationId,key:owner,choice,sourceId}); render();
  if (Object.keys(state.workspace.drafts).length || capacityDraftCount()) await reviewChanges();
  else { modal.close(); toast('Se ha conservado la capacidad de Azure DevOps.'); }
}
async function resolveTask(id,choice) {
  await request('/api/resolve',{id,choice}); render();
  if (Object.keys(state.workspace.drafts).length) await reviewChanges();
  else { modal.close(); toast('Se ha conservado la versión de Azure DevOps.'); }
}
$('#connection-button').onclick = () => { if (state && !pending) connection(); };
modal.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
document.addEventListener('click', async event => {
  // A link to Azure DevOps opens there without triggering the card or branch action.
  if (event.target.closest('a[href]')) return;
  const target = event.target.closest('[data-action]');
  if (!target || pending || target.disabled) return;
  if (target.closest('summary')) event.preventDefault();
  const action = actions[target.dataset.action];
  if (!action) return;
  try { await action(target); } catch (error) { errorInModal(error); }
});
document.addEventListener('keydown', event => {
  const card = event.target.closest('.task-card');
  if (card && !event.target.closest('a[href]') && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (!pending) editTask(Number(card.dataset.task)); }
  const tabButton = event.target.closest('[role="tab"]');
  if (tabButton && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const tabs=['iteration','previous','capacity','hierarchy','planning']; tab=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:tabs.length-1))%tabs.length]; render(); $(`[data-tab="${tab}"]`).focus(); }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return;
  try {
    if (event.target.id === 'maintenance-settings-form') {
      const closedStates = [...event.target.querySelectorAll('input[name="closed"]:checked')].map(el => el.value);
      await request('/api/maintenance-settings', { type: event.target.dataset.type, states: maintenanceSetup?.states ?? [], closedStates });
      maintenanceSetup = null; maintenanceSnapshot = null; render();
      await maintenanceQuery();
      return;
    }
    if (event.target.id === 'completed-state-form') {
      const form=new FormData(event.target), {type,taskId,sourceId}=completedStateChoice;
      const chosen=String(form.get('state') || form.get('other') || '').trim();
      if (!chosen) throw new Error('Indica el nombre del estado completado.');
      await request('/api/completed-state',{type,state:chosen,...(sourceId ? {sourceId} : {})});
      if (taskId) await request('/api/complete-task',{id:taskId});
      modal.close();review=null;render();
      toast(taskId ? `#${taskId} marcada como completada (${chosen}) en local.` : `«${type}» se completará con el estado ${chosen}.`);
      return;
    }
    if (event.target.id === 'capacity-editor-form') {
      const e=capacityEditor;
      await saveCapacity(e.owner,{...(e.owner==='team' ? {} : {activities:e.activities}),daysOff:e.daysOff});
      modal.close();capacityEditor=null;
      $(`[data-action="edit-capacity"][data-owner="${CSS.escape(e.owner)}"]`)?.focus({preventScroll:true});
      toast('Capacidad guardada en local.');return;
    }
    if (event.target.id === 'state-rules-form') {
      const choices = [...event.target.querySelectorAll('select[data-state]')].filter(el => el.value).map(el => ({ state: el.dataset.state, action: el.value }));
      const refreshAll=event.target.dataset.refreshAll==='true',section=event.target.dataset.section;
      await request('/api/state-rules', { choices });
      if(section) await refreshPlanningSection(section);else await importData(refreshAll);
      return;
    }
    if(event.target.id==='create-form'){const input=Object.fromEntries(new FormData(event.target));input.parent=Number(input.parent)||null;if(input.remainingWork)input.remainingWork=Number(input.remainingWork);else delete input.remainingWork;await request('/api/create',input);modal.close();render();toast('Elemento creado en local. Pendiente de sincronizar.');return;}
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
  if (el.dataset.securityFilter) { filterPermissions(securitySnapshot.report, el.dataset.securityFilter, el.value); return; }
  if (el.dataset.maintenanceFilter) { filterMaintenance(maintenanceSnapshot, el.dataset.maintenanceFilter, el.value); return; }
  try {
    if(el.id==='create-type'){updateCreationParents();return;}
    if(el.dataset.capacityHours!==undefined){await saveCapacityHours(el);return;}
    if(el.dataset.range!==undefined){await saveCapacityRange(el);return;}
    if(el.dataset.participant){const member=el.dataset.participant;await saveParticipation(peopleItem,member,el.checked);[...peoplePopover.querySelectorAll('input[data-participant]')].find(box=>box.dataset.participant===member)?.focus({preventScroll:true});return;}
    if(el.name==='taskIds'){await saveTaskSelection([Number(el.value)],el.checked);return;}
    if(el.id==='toggle-visible'){
      const ids=[...document.querySelectorAll('#picker-tree input[name="taskIds"]:not(:disabled)')].filter(box=>box.checked!==el.checked).map(box=>Number(box.value));
      if(ids.length>200)throw new Error('Selecciona un máximo de 200 tareas por operación.');
      if(ids.length)await saveTaskSelection(ids,el.checked);return;
    }
    if(el.id==='show-unavailable'){onlyAvailable=!el.checked;refreshPicker();}
    if(el.id==='backlog-filter'){backlogFilter=el.value;focusedMember='';render();}
  }catch(error){renderSaved();errorInModal(error);}
});
document.addEventListener('input',event=>{
  if (event.target.id === 'security-group-search') filterGroups();
  if (event.target.dataset.securityFilter === 'text') filterPermissions(securitySnapshot.report, 'text', event.target.value);
  if (event.target.dataset.maintenanceFilter === 'text') filterMaintenance(maintenanceSnapshot, 'text', event.target.value);
  if (event.target.name === 'other' && event.target.closest('#completed-state-form')) $('[data-other-state]').checked = true;
  if(event.target.dataset.editActivity!==undefined){capacityEditor.activities[Number(event.target.dataset.editActivity)].capacityPerDay=Number(event.target.value);refreshCapacityEditor();}
  if(event.target.id==='people-search'){peopleQuery=event.target.value;refreshPeople();positionPeople();}
  if(event.target.id==='picker-search'){pickerQuery=event.target.value;refreshPicker();}
  if(event.target.id==='search'){query=event.target.value;updatePlanningView();}
});
peoplePopover.addEventListener('toggle',event=>{if(event.newState==='closed'){peopleItem=null;document.querySelectorAll('[aria-controls="people-popover"]').forEach(el=>el.setAttribute('aria-expanded','false'));}});
window.addEventListener('resize',()=>{if(peopleItem)positionPeople();});
document.addEventListener('toggle',event=>{
  const element=event.target;
  if (!element.matches?.('details[data-node], details[data-project]') || element.closest('#picker-tree')) return;
  const id=element.dataset.project ? `project:${element.dataset.project}` : Number(element.dataset.node);
  if(element.open)collapsed.delete(id);else collapsed.add(id);
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
loadState().then(() => { registerTools(); if (!state.busy && state.stateReview) showStateReview(state.stateReview); else return resumeOperation(); }).catch(error=>{
  $('#app').innerHTML=`<div class="notice error">${escape(error.message)} Recarga esta página cuando el servidor local esté disponible.</div>`;
});
