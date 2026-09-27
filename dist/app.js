import { permissionsView, filterPermissions, filterGroups, resetPermissionFilters } from './permissions.js';
import { maintenanceView, filterMaintenance } from './maintenance.js';
import { reviewsView, publishConfirmation } from './reviews.js';
import { hierarchy, ancestors, filterHierarchy, isExecutable, typeRank, hasPlanningCapacity, estimateFields, previousIteration, completedState, isCompleted, markSnapshot } from './hierarchy.js';
const $ = (selector, parent = document) => parent.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const key = member => (member.uniqueName || member.id || member.displayName || '').toLowerCase();
const number = value => new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(value);
const initials = name => name.trim().split(/\s+/).slice(0,2).map(s => s[0]).join('').toUpperCase();
const date = value => value ? new Date(value).toLocaleDateString('es', { day:'numeric', month:'short', timeZone:'UTC' }) : 'Sin fecha';
let securitySnapshot = null, maintenanceSnapshot = null, maintenanceSetup = null;
// Pull request review: what the person is choosing; the reviews themselves come from the server.
let prUi = { repositories: null, repository: '', pullRequests: null, reviewId: null, copilot: null, includeSummary: true };
let state, selectedIteration = '', tab = 'home', query = '', pending = false, review, toastTimer;
// The last step lists the pending changes in the page: its review load, sync and messages.
let changesUi = { loading: false, syncing: false, error: '', notice: '', confirmAll: false };
let backlogQuery='';
const collapsed = new Set();
// People in the team plan start collapsed: only their load bar until opened.
const expandedLanes = new Set(), expandedPrevious = new Set();
let previousGroupOrder = null;
// Elegir tareas works on the previous iteration (decide what is left) or the current one.
let planningPeriod = null;
const modal = $('#modal');
// Measure real row heights so wrapped parent titles never overlap.
let stickyFrame;
function layoutStickyHierarchy() {
  cancelAnimationFrame(stickyFrame);
  stickyFrame=requestAnimationFrame(()=>{
    const offsets=new Map();
    document.querySelectorAll('.hierarchy-branch').forEach(branch=>{
      const summary=branch.querySelector(':scope > summary');
      const parent=branch.parentElement.closest('.hierarchy-branch');
      const previous=offsets.get(parent);
      const top=previous?.bottom ?? 0;
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
  document.querySelectorAll('.hierarchy-branch > summary').forEach(el=>stickySizes.observe(el));
  layoutStickyHierarchy();
}).observe($('#app'),{childList:true,subtree:true});
document.addEventListener('toggle',layoutStickyHierarchy,true);
window.addEventListener('resize',layoutStickyHierarchy);
function pendingLabel(item) {return item.localOnly ? 'Nuevo · pendiente de sincronizar' : 'Pendiente de sincronizar';}
// Pending changes are counted by the server, with the same rules as the review.
const pendingCount = (ws = state?.workspace) => ws?.pendingChanges ?? 0;
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;
function savedStatus() {
  const count=pendingCount();
  return count ? `${plural(count,'pendiente')} de sincronizar` : 'Sin cambios pendientes';
}
// Every snapshot received from the server is read-only in the interface.
function setState(next) { state = next; markSnapshot(state?.workspace); }
function createItem(parentId) {
  const ws=state.workspace,parent=ws.effectiveItems.find(i=>i.id===parentId);
  const type=parent ? ({Epic:'Feature',Feature:'User Story','User Story':'Task','Product Backlog Item':'Task',Requirement:'Task'})[parent.type] || 'Task' : 'Epic';
  showModal('Crear elemento','Se guardará en local hasta revisar y sincronizar.',`<form id="create-form">${ws.sources && !parent ? `<label class="form-field">Proyecto<select name="sourceId" required>${ws.sources.map(s=>`<option value="${escape(s.id)}">${escape(s.config.project)}</option>`).join('')}</select></label>` : ''}<label class="form-field">Tipo<select name="type" id="create-type">${['Epic','Feature','User Story','Task','Bug'].map(t=>`<option ${t===type ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label class="form-field">Título<input name="title" required maxlength="255" autofocus></label><label class="form-field">Padre<select name="parent" id="create-parent"></select></label><label class="form-field">Responsable<select name="assignedTo"><option value="">Sin asignar</option>${ws.members.map(m=>`<option value="${escape(key(m))}" >${escape(m.displayName)}</option>`).join('')}</select></label><label class="form-field">Iteración<select name="iterationPath">${[{path:ws.settings.backlogIteration.path,name:'Backlog'},...planningIterations()].map(i=>`<option value="${escape(i.path)}" ${tab==='planning' && i.id===selectedIteration ? 'selected' : ''}>${escape(i.name)}</option>`).join('')}</select></label><label class="form-field" id="create-hours">Horas pendientes<input name="remainingWork" type="number" min="0" max="100000" step="0.25" placeholder="Sin estimar"></label></form>`,'<button class="button" data-action="close">Cancelar</button><button class="button primary" form="create-form" type="submit">Crear en local</button>');
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
// Errors stay longer on screen and can be dismissed by clicking them.
function toast(text, kind = 'info') {
  const element = $('#toast');
  clearTimeout(toastTimer);
  element.textContent = text;
  element.classList.toggle('error', kind === 'error');
  element.classList.toggle('warning', kind === 'warning');
  element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, kind === 'error' ? 10000 : 5000);
}
function errorInModal(error) {
  if (error.stateReview) { showStateReview(error.stateReview); return; }
  const target = $('#modal-error');
  if (modal.open && target) { target.textContent = error.message; target.hidden = false; }
  else toast(error.message, 'error');
}
async function send(path, input) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type':'application/json', 'X-Neo-CSRF': state.csrf }, body: JSON.stringify({ ...input, version: state.version }) })
    .catch(() => { throw new Error('Se perdió la conexión con el servidor local de Neo Team antes de recibir la respuesta. Si se ha detenido, revisa la terminal donde se ejecuta y el archivo .neo-team/last-error.json.'); });
  const data = await response.json().catch(() => { throw new Error(`El servidor local respondió sin datos válidos (HTTP ${response.status}).`); });
  return { response, data };
}
async function request(path, input = {}) {
  if (pending) throw new Error('Espera a que termine la operación en curso.');
  pending = true;
  let recover = false;
  const enabled = [...document.querySelectorAll('button:not(:disabled):not([data-cancel-operation]), input:not(:disabled), select:not(:disabled)')];
  // Local saves answer in a few milliseconds: controls are only disabled when a
  // request takes longer, so quick edits never make the screen flash.
  const busy = setTimeout(() => { enabled.forEach(el => el.disabled = true); $('#save-status').textContent = 'Procesando…'; }, 250);
  try {
    const version = state.version;
    let { response, data } = await send(path, input);
    if (response.status === 403 && data.reason === 'session') {
      // The server restarted and rejected the request without applying it. Renew
      // the session and repeat it only if nobody changed the plan in the meantime.
      await loadState(false);
      if (state.version !== version) throw new Error('El servidor local se ha reiniciado y la planificación ha cambiado. Revisa los datos y repite la acción.');
      ({ response, data } = await send(path, input));
    }
    if (!response.ok) {
      throw Object.assign(new Error(data.error || 'No se pudo completar la operación.'), { stateReview: data.stateReview, diagnostics: data.diagnostics });
    }
    if (data.state) setState(data.state);
    else if (data.csrf) setState(data);
    return data;
  } catch (error) {
    // Recover a server operation after a reload, another tab, or a lost response.
    await loadState(false).catch(() => {});
    recover = !!(state?.busy && state?.operation);
    if (state) render();
    throw error;
  } finally {
    clearTimeout(busy); pending = false; enabled.forEach(el => el.disabled = false);
    $('#save-status').textContent = savedStatus();
    if (recover) setTimeout(() => resumeOperation(), 0);
  }
}
async function loadState(renderNow = true) {
  const response = await fetch('/api/state');
  if (!response.ok) throw new Error('No se pudo abrir el espacio local.');
  setState(await response.json());
  if (renderNow) render();
}
function showModal(title, subtitle, body, actions = '') {
  modal.classList.remove('wide-modal', 'connection-modal');
  $('#modal-content').innerHTML = `<div class="modal-head"><div><h2 id="modal-title">${escape(title)}</h2><p>${escape(subtitle)}</p></div><button class="close" data-action="close" aria-label="Cerrar">×</button></div><div class="modal-body"><div class="inline-error" id="modal-error" role="alert" hidden></div>${body}</div><div class="modal-footer">${actions || '<button class="button" data-action="close">Cerrar</button>'}</div>`;
  if (!modal.open) modal.showModal();
}
let connectionPickerEvents = new AbortController();
function connection() {
  connectionPickerEvents.abort();
  connectionPickerEvents = new AbortController();
  const c = state.config || {}, adding = state.mode === 'azure' && !!state.workspace;
  showModal(adding ? 'Añadir proyecto' : state.config ? 'Configuración de Azure DevOps' : 'Conectar Azure DevOps', adding ? 'Añade un proyecto a la planificación conjunta. Los ya importados se conservan.' : 'Indica la organización, el proyecto y el equipo que vas a planificar. Solo se leen datos hasta que revises y sincronices.', `
    <form id="connection-form">
      <label class="form-field">Organización<input name="organization" required maxlength="150" placeholder="mi-organizacion o https://dev.azure.com/mi-organizacion" value="${escape(c.organization)}" autocomplete="off"></label>
      <label class="form-field">Acceso<select name="authentication"><option value="interactive">Iniciar sesión con Microsoft</option><option value="azcli" ${c.authentication === 'azcli' ? 'selected' : ''}>Usar mi sesión de Azure CLI</option></select><small>Con Microsoft se abrirá tu navegador para iniciar sesión. La aplicación no solicita tu contraseña.</small></label>
      ${connectionField('project', 'Proyecto', c.project)}
      ${connectionField('team', 'Equipo', c.team)}
      <details><summary class="text-muted" style="font-size:14px;cursor:pointer;margin-bottom:14px">Opciones avanzadas</summary><label class="form-field">Tenant de Microsoft Entra (opcional)<input name="tenant" placeholder="Identificador del directorio" value="${escape(c.tenant)}"><small>Déjalo vacío para detectar el directorio de tu organización.</small></label></details>
      <div id="connection-progress" hidden></div>
      <div class="notice">Se importan tareas abiertas e iteraciones actuales y futuras. Los estados personalizados sin categoría se revisan antes de descargar las tareas. Las capacidades se definen una sola vez para todos los proyectos. Podrás preparar cambios en local y revisarlos antes de sincronizarlos.</div>
    </form>`, `<button class="button" data-action="save-config">Guardar sin importar</button><button class="button primary" type="submit" form="connection-form">${adding ? 'Añadir e importar' : 'Conectar e importar'} ↙</button>`);
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
  if ($('#modal-error')) $('#modal-error').hidden = true;
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
    cancelButton.hidden = existing ? !['/api/pr-repositories', '/api/pr-list', '/api/pr-review', '/api/copilot-status', '/api/refresh-section', '/api/import', '/api/projects', '/api/teams', '/api/security-groups', '/api/security-audit', '/api/maintenance', '/api/maintenance-states', '/api/work-item-states'].includes(existing.path) : progress.cancellable === false && !progress.cancelRequested;
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
    <details class="state-review-fields" open><summary>Campos del elemento ${taskId(review.item,review)}</summary><div class="table-wrap"><table><thead><tr><th>Campo</th><th>Valor</th></tr></thead><tbody>${Object.entries(review.item.fields).map(([name, value]) => `<tr><td>${escape(name)}</td><td><pre>${escape(typeof value === 'object' ? JSON.stringify(value, null, 2) : value)}</pre></td></tr>`).join('')}</tbody></table></div></details>`,
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
    if (current.path.startsWith('/api/pr-')) { if (current.path === '/api/pr-review') prUi.reviewId = state.prReviews?.[0]?.id ?? null; tab = 'reviews'; render(); }
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
  // By default the next iteration is planned: the current one is already under way.
  if (!options.some(i => i.id === selectedIteration)) {
    const kinds=iterationKinds(options), pick=kind=>options.find(i=>kinds.get(i.id)===kind);
    selectedIteration=(pick('next') || pick('future') || pick('current') || options[0])?.id || '';
  }
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
const pretty = (field,value) => field === 'assignedTo' ? memberName(value) : field === 'iterationPath' ? iterationName(value) : value === null || value === undefined ? 'Sin definir' : ['remainingWork','originalEstimate'].includes(field) ? `${number(value)} h` : String(value);
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
const plain = text => String(text ?? '').normalize('NFD').replace(/\p{Diacritic}/gu,'').toLowerCase();
function matchesTask(item, text) {
  const wanted=plain(text.trim()).replace(/^#/,'');
  return !wanted || plain(item.title).includes(wanted) || /^\d+$/.test(wanted) && String(item.id).includes(wanted);
}
function matchesText(item, text) {
  return plain(`${item.id} #${item.id} ${item.title} ${(item.tags || []).join(' ')} ${item.type}`).includes(plain(text.trim()));
}
// Opens the real work item in Azure DevOps, in the project it belongs to.
function azureLink(item, label='↗', config=null, className='azure-link') {
  const ws=state.workspace;
  if (!(item?.id>0) || !config && ws?.mode!=='azure') return '';
  config ??= ws.sources?.find(s=>s.id===item.sourceId)?.config ?? ws.config;
  if (!config?.organization || !config.project) return '';
  const url=`https://dev.azure.com/${encodeURIComponent(config.organization)}/${encodeURIComponent(config.project)}/_workitems/edit/${item.id}`;
  return `<a class="${className}" href="${escape(url)}" target="_blank" rel="noopener noreferrer" title="Abrir #${item.id} en Azure DevOps" aria-label="Abrir #${item.id} en Azure DevOps">${escape(label)}</a>`;
}
// The task id itself links to the real work item when it exists in Azure DevOps.
function taskId(item, config=null) {
  return azureLink(item, `#${item?.id}`, config, 'task-id-link') || `#${escape(String(item?.id ?? ''))}`;
}
function treeView({ availableOnly = false, search = query } = {}) {
  const ws=state.workspace, tree=planningTree(), iteration=selected();
  const matches=new Set();
  // The available backlog filters tasks by their own name (or #id); their parents
  // are still shown for context. Elsewhere, a matching branch shows its descendants.
  for (const item of ws.effectiveItems) {
    if (availableOnly ? matchesTask(item,search) : matchesText(item,search) || ancestors(item.id,tree).some(parent=>matchesText(parent,search))) matches.add(item.id);
  }
  const include=item=>{
    if (!matches.has(item.id)) return false;
    // Open branches are shown even without available tasks (a new story, say), so
    // the whole hierarchy is visible; while filtering, only branches with matches.
    if (availableOnly) return isExecutable(item) ? !iteration || item.iterationPath !== iteration.path : !search.trim() && !item.contextOnly;
    return true;
  };
  const roots=filterHierarchy(tree.roots,include);
  function nodeHtml(node,depth) {
    const type=`<span class="node-type kind-${typeRank(node)}">${escape(node.type)}</span>`;
    if (!isExecutable(node)) {
      return `<details class="hierarchy-branch" data-node="${node.id}" ${search || !collapsed.has(node.id) ? 'open' : ''}><summary><span class="branch-chevron">›</span>${type}<span class="branch-title">${node.project ? `<small class="pill">${escape(node.project)}</small> ` : ''}${escape(node.title)} <small>${taskId(node)}${node.contextOnly ? ' · contexto' : ''}</small>${node.modified ? `<span class="pill changed">${pendingLabel(node)}</span>` : ''}</span><button class="button small" data-action="create" data-parent="${node.id}" aria-label="Crear hijo de ${escape(node.title)}">+</button><button class="button small" data-action="edit" data-task="${node.id}">Editar</button></summary><div class="hierarchy-children">${node.children.map(child=>nodeHtml(child,depth+1)).join('') || '<p class="branch-empty">Sin tareas o bugs disponibles en esta rama.</p>'}</div></details>`;
    }
    const effort=node.remainingWork !== null ? `${number(node.remainingWork)} h` : node.points !== null ? `${number(node.points)} pts` : 'Sin estimar';
    const status=iterationName(node.iterationPath);
    const contents=`<div class="leaf-copy"><div class="leaf-meta">${type}<span>${taskId(node)}</span>${node.project ? `<span class="pill">${escape(node.project)}</span>` : ''}${node.modified ? `<span class="pill changed">${pendingLabel(node)}</span>` : ''}</div><button class="leaf-title" data-action="edit" data-task="${node.id}">${escape(node.title)}</button><span class="leaf-status">${escape(status)}${node.assignedTo ? ` · ${escape(memberName(node.assignedTo))}` : ''}</span></div><span class="effort">${effort}</span>`;
    const leaf=`<div class="hierarchy-leaf" draggable="true" data-drag-task="${node.id}">${contents}</div>`;
    return leaf + (node.children.length ? `<div class="hierarchy-children">${node.children.map(child=>nodeHtml(child,depth+1)).join('')}</div>` : '');
  }
  const empty='<div class="empty-result">No hay tareas para esta selección.</div>';
  if (!ws.sources) return roots.map(node=>nodeHtml(node,0)).join('') || empty;
  // With several projects, each project is the top parent of its own backlog.
  const projects=ws.sources.map(source=>{
    const own=roots.filter(node=>node.sourceId===source.id);
    if (!own.length) return '';
    return `<details class="hierarchy-branch project-branch" data-project="${escape(source.id)}" ${search || !collapsed.has(`project:${source.id}`) ? 'open' : ''}><summary><span class="branch-chevron">›</span><span class="node-type kind-project">Proyecto</span><span class="branch-title">${escape(source.config.project)} <small>${escape(source.config.team)}</small></span></summary><div class="hierarchy-children">${own.map(node=>nodeHtml(node,1)).join('')}</div></details>`;
  }).join('');
  const unknown=roots.filter(node=>!ws.sources.some(source=>source.id===node.sourceId)).map(node=>nodeHtml(node,0)).join('');
  return projects+unknown || empty;
}
function hierarchyView() {
  return `<section class="hierarchy-surface"><div class="hierarchy-toolbar"><input class="search" id="search" aria-label="Buscar en el backlog" placeholder="Buscar rama o tarea" value="${escape(query)}"><button class="button small" data-action="expand-tree">Expandir</button><button class="button small" data-action="collapse-tree">Plegar</button></div><div id="hierarchy-content">${treeView()}</div></section>`;
}
function sectionRefreshButton() {
  const section=({iteration:'iterations',capacity:'capacity',hierarchy:'tasks'})[tab];
  if(section==='capacity') return capacityControls();
  if(!section || state.workspace?.mode!=='azure') return '';
  const label=({iterations:'iteraciones',capacity:'capacidad',tasks:'tareas y jerarquía'})[section];
  const at=state.workspace.refreshedAt?.[section];
  return `<div class="workspace-controls"><button class="button small" data-action="refresh-section" data-section="${section}">Actualizar ${label}</button><small class="text-muted">Solo ${label}${at ? ' · '+new Date(at).toLocaleTimeString('es') : ''}</small></div>`;
}
function stepView() { return sectionRefreshButton()+stepContent(); }
function stepContent() {
  const iteration=selected();
  if (tab==='changes') return changesView();
  if (tab==='iteration') return iterationView();
  if (tab==='capacity') return capacityView();
  if (tab==='planning') return plannerView();
  if (!iteration) return hierarchyView();
  return board(iteration,state.workspace.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath===iteration.path));
}
function stepTabs(changes) {
  const open=previousTasks().tasks.filter(t=>t.status==='open').length;
  const steps=[['iteration','Iteración'],['capacity','Capacidad'],['planning','Elegir tareas',open]];
  return `<nav class="step-tabs" aria-label="Pasos de planificación">${steps.map(([id,label,count],index)=>`<button class="step-tab ${tab===id ? 'active' : ''}" data-action="tab" data-tab="${id}" ${tab===id ? 'aria-current="step"' : ''}><span>${index+1}</span>${label}${count ? `<small aria-label="${count} sin decidir">${count}</small>` : ''}</button>`).join('')}<button class="step-tab ${tab==='changes' ? 'active' : ''}" data-action="tab" data-tab="changes" ${tab==='changes' ? 'aria-current="step"' : ''} ${changes || tab==='changes' ? '' : 'disabled'}><span>${steps.length+1}</span>Cambios pendientes${changes ? `<small aria-label="${changes} sin sincronizar">${changes}</small>` : ''}</button></nav>`;
}
// Step 1: the iteration being planned. Every later step works on it.
// Current, the one right after it, and later ones, each with its own colour.
function iterationKinds(iterations) {
  const today=new Date().toISOString().slice(0,10), day=value=>String(value ?? '').slice(0,10);
  const isCurrent=i=>['1','current'].includes(String(i.attributes?.timeFrame ?? '').toLowerCase()) || (day(i.attributes?.startDate) && day(i.attributes.startDate)<=today && today<=day(i.attributes?.finishDate));
  const ordered=[...iterations].sort((a,b)=>day(a.attributes?.startDate).localeCompare(day(b.attributes?.startDate)));
  const current=ordered.find(isCurrent), after=current ? ordered.slice(ordered.indexOf(current)+1) : ordered.filter(i=>day(i.attributes?.startDate)>today);
  return new Map(iterations.map(i=>[i.id,i===current ? 'current' : i===after[0] ? 'next' : after.includes(i) ? 'future' : 'other']));
}
const iterationKindLabel={current:'Actual',next:'Siguiente',future:'Futura',other:'Iteración'};
function iterationView() {
  const ws=state.workspace, selectedOne=selected();
  if (!selectedOne) return '<div class="empty-result">Importa un equipo con iteraciones para empezar a planificar.</div>';
  const iterations=planningIterations(), kinds=iterationKinds(iterations);
  return `<section class="iteration-step"><div class="iteration-options">${iterations.map(i=>{
    const planned=ws.effectiveItems.filter(item=>isExecutable(item) && item.iterationPath===i.path).length, kind=kinds.get(i.id), active=i.id===selectedOne.id;
    return `<button class="iteration-option kind-${kind} ${active ? 'active' : ''}" data-action="choose-iteration" data-iteration="${escape(i.id)}" aria-pressed="${active}"><span class="iteration-tags"><span class="iteration-when">${iterationKindLabel[kind]}</span>${active ? '<span class="iteration-chosen">✓ Planificando</span>' : ''}</span><strong>${escape(i.name)}</strong><span>${date(i.attributes?.startDate)} — ${date(i.attributes?.finishDate)}</span><small>${planned} tarea${planned===1 ? '' : 's'} planificada${planned===1 ? '' : 's'}</small></button>`;
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
// Iterations after the one being planned, to send a task further ahead.
function laterIterationSelect(item, iteration) {
  const start=i=>String(i.attributes?.startDate ?? '');
  const later=planningIterations().filter(i=>i.id!==iteration.id && (!start(iteration) || start(i)>start(iteration))).sort((a,b)=>start(a).localeCompare(start(b)));
  if (!later.length) return '';
  return `<select class="later-iteration" data-previous-move data-task="${item.id}" aria-label="Mandar #${item.id} a una iteración posterior"><option value="">Más adelante…</option>${later.map(i=>`<option value="${escape(i.path)}">${escape(i.name)}</option>`).join('')}</select>`;
}
function previousTaskRow({item,base,status},iteration) {
  const effort=item.remainingWork!==null ? `${number(item.remainingWork)} h` : 'Sin estimar';
  const decided=item.iterationPath!==base.iterationPath || item.state!==base.state;
  const outcome={completed:'✓ Completada',backlog:'↩ En el backlog, sin iteración',moved:`→ Pasa a ${escape(iteration.name)}`,elsewhere:`Movida a ${escape(iterationName(item.iterationPath))}`}[status];
  const actions=status==='open'
    ? `<button class="button small primary" data-action="carry-over" data-task="${item.id}">Pasar a ${escape(iteration.name)} →</button><button class="button small" data-action="complete-task" data-task="${item.id}" title="Marcar como completada">✓ Completada</button><button class="button small" data-action="to-backlog" data-task="${item.id}" title="Mandar al backlog: quita la iteración y conserva el responsable">↩ Backlog</button>${laterIterationSelect(item,iteration)}`
    : `<span class="previous-outcome outcome-${status}">${outcome}</span>${decided ? `<button class="button small subtle" data-action="undo-previous" data-task="${item.id}">Deshacer</button>` : ''}`;
  return `<li class="previous-task status-${status}" data-previous-task="${item.id}"><div class="previous-task-copy"><div class="leaf-meta"><span class="node-type kind-${typeRank(item)}">${escape(item.type)}</span><span>${taskId(item)}</span><span class="pill">${escape(base.state || 'Sin estado')}</span>${item.modified ? `<span class="pill changed">${pendingLabel(item)}</span>` : ''}</div><button class="leaf-title" data-action="edit" data-task="${item.id}">${escape(item.title)}</button></div><span class="effort">${effort}</span><div class="previous-task-actions">${actions}</div></li>`;
}
function previousPerson(group,iteration) {
  const open=group.tasks.filter(t=>t.status==='open'), hours=open.reduce((sum,t)=>sum+(t.item.remainingWork ?? 0),0), decided=group.tasks.length-open.length;
  const expanded=expandedPrevious.has(group.id), id=`previous-${group.id.replace(/[^a-z0-9]/gi,'-')}`;
  const status=open.length ? `<span class="previous-pending">${open.length} sin decidir · ${number(hours)} h</span>` : '<span class="previous-done">✓ Todo decidido</span>';
  return `<section class="previous-person ${open.length ? 'has-open' : 'all-decided'} ${expanded ? '' : 'collapsed'}"><button type="button" class="previous-toggle" data-action="toggle-previous" data-group="${escape(group.id)}" aria-expanded="${expanded}" aria-controls="${id}"><span class="person">${group.avatar ? `<span class="avatar ${group.avatar}">${escape(initials(group.name))}</span>` : ''}<span class="person-detail"><strong>${escape(group.name)}</strong><small>${plural(group.tasks.length,'tarea')}${decided ? ` · ${decided} decidida${decided===1 ? '' : 's'}` : ''}</small></span></span>${status}<span class="lane-chevron" aria-hidden="true">›</span></button><ul class="previous-tasks" id="${id}" ${expanded ? '' : 'hidden'}>${group.tasks.map(task=>previousTaskRow(task,iteration)).join('')}</ul></section>`;
}
function previousView() {
  const ws=state.workspace, iteration=selected();
  if (!iteration) return '<div class="empty-result">Elige primero la iteración que vas a planificar.</div>';
  const {previous,tasks}=previousTasks(iteration);
  const next='<button class="button primary" data-action="planning-period" data-period="current">Ir a la iteración actual →</button>';
  if (!previous) return `<div class="empty-panel"><h2>No hay iteración anterior</h2><p>${escape(iteration.name)} es la primera iteración importada.${ws.mode==='azure' ? ' Actualiza los datos para traer la última iteración terminada.' : ''}</p></div>`;
  const open=tasks.filter(t=>t.status==='open'), owned=member=>tasks.filter(t=>t.item.assignedTo===key(member));
  const groups=[
    ...ws.members.map((member,index)=>({id:key(member),name:member.displayName,avatar:`c${index%4}`,tasks:owned(member)})),
    {id:'unassigned',name:'Sin asignar',tasks:tasks.filter(t=>!t.item.assignedTo)},
    {id:'outside',name:'Fuera del equipo',tasks:tasks.filter(t=>t.item.assignedTo && !ws.members.some(m=>key(m)===t.item.assignedTo))},
  ].filter(group=>group.tasks.length);
  // People with everything decided go last. The order is kept while deciding and
  // refreshed on entering the view or opening/closing someone, so rows never jump.
  const orderKey=`${previous.id}|${groups.map(g=>g.id).join(',')}`;
  if (previousGroupOrder?.key!==orderKey) previousGroupOrder={key:orderKey,ids:groups.map((g,index)=>({id:g.id,index,done:!g.tasks.some(t=>t.status==='open')})).sort((a,b)=>Number(a.done)-Number(b.done) || a.index-b.index).map(g=>g.id)};
  groups.sort((a,b)=>previousGroupOrder.ids.indexOf(a.id)-previousGroupOrder.ids.indexOf(b.id));
  const idle=ws.members.filter(member=>!owned(member).length), types=[...new Set(tasks.map(t=>t.item.type))];
  const kinds=[...new Map(tasks.map(t=>[`${t.item.sourceId ?? ''}\n${t.item.type}`,t.item])).values()];
  const completion=types.length ? `<p class="completed-states">Al completar: ${kinds.map(item=>`<button class="link-button" data-action="edit-completed-state" data-type="${escape(item.type)}" data-source="${escape(item.sourceId ?? '')}" title="Cambiar el estado completado de ${escape(item.type)}">${ws.sources ? `${escape(item.project)} · ` : ''}${escape(item.type)} → ${escape(completedState(item,ws) || 'sin elegir')}</button>`).join(' · ')}</p>` : '';
  return `<section class="previous-step"><header class="previous-heading"><div><h2>Revisa ${escape(previous.name)}</h2><p>${date(previous.attributes?.startDate)} — ${date(previous.attributes?.finishDate)} · Abre a cada persona resaltada para decidir lo que le queda: pasarlo a ${escape(iteration.name)}, marcarlo como completado o mandarlo al backlog.</p>${completion}</div><div class="previous-summary"><strong>${open.length}</strong><span>sin decidir</span><small>${tasks.length} en total</small></div></header>
    ${groups.length ? `<div class="previous-people">${groups.map(group=>previousPerson(group,iteration)).join('')}</div>` : `<div class="empty-result">No quedan tareas ni bugs abiertos en ${escape(previous.name)}.</div>`}
    ${groups.length && idle.length ? `<p class="local-note">Sin trabajo abierto en ${escape(previous.name)}: ${idle.map(m=>escape(m.displayName)).join(', ')}.</p>` : ''}
    <div class="capacity-next"><span>${open.length ? `Quedan ${open.length} por decidir. Puedes seguir con ${escape(iteration.name)} y volver después.` : 'Todo decidido.'} Las decisiones se guardan en local y se envían al sincronizar.</span>${next}</div></section>`;
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
async function decidePrevious(id, decision, path) {
  const ws=state.workspace, item=ws.effectiveItems.find(i=>i.id===id), base=ws.items.find(i=>i.id===id), iteration=selected();
  if (!item || !base || !iteration) throw new Error('La tarea ya no está disponible.');
  if (decision==='complete') {
    if (!completedState(item,ws)) { chooseCompletedState(item.type,id,null,item.sourceId); return; }
    await request('/api/complete-task',{id});
  }
  else await request('/api/stage',{edits:[{id,changes:decision==='carry' ? {iterationPath:iteration.path} : decision==='move' ? {iterationPath:path} : decision==='backlog' ? {iterationPath:ws.settings.backlogIteration.path} : {iterationPath:base.iterationPath,state:base.state}}]});
  review=null;render();
  document.querySelector(`[data-previous-task="${id}"] .previous-task-actions button`)?.focus({preventScroll:true});
  // Allowed, but flagged: the owner has no capacity in the destination or is not in the team.
  const target=decision==='carry' ? iteration : decision==='move' ? ws.iterations.find(i=>i.path===path) : null, owner=item.assignedTo;
  if (target && owner) {
    const member=state.workspace.members.find(m=>key(m)===owner);
    if (!member || state.workspace.capacityHours?.[target.id]?.[member.id]===0) { toast(`#${id} pasa a ${target.name}, pero ${member ? `${member.displayName} tiene 0 h de capacidad` : `${memberName(owner)} no está en el equipo`} en esa iteración.`,'warning'); return; }
  }
  toast(decision==='carry' ? `#${id} pasa a ${iteration.name}. Pendiente de sincronizar.` : decision==='move' ? `#${id} pasa a ${iterationName(path)}. Pendiente de sincronizar.` : decision==='backlog' ? `#${id} vuelve al backlog. Pendiente de sincronizar.` :decision==='complete' ? `#${id} marcada como completada en local.` : `Decisión sobre #${id} deshecha.`);
}
// Step 1: the capacity and days off that the rest of the planning is measured
// against. Every edit is a local draft until the review writes it to Azure.
const dayValue = value => String(value ?? '').slice(0,10);
const nextDay = value => new Date(+new Date(`${value}T00:00:00Z`) + 86400000).toISOString().slice(0,10);
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
// After a download, what the person had locally sits beside Azure's value until they choose.
function capacityDownloadLine(owner) {
  const mine=state.workspace.capacityDownloads?.[selectedIteration]?.local?.[owner];
  if (!mine) return '';
  const azure=capacityOf(selectedIteration,owner);
  const text=entry=>`${owner==='team' ? '' : `${number(capacityBreakdown(owner,entry).total)} h · `}${capacityText(entry,owner)}`;
  return `<div class="capacity-download-diff" role="group" aria-label="Diferencia con tu copia local"><p class="capacity-download-title">Cambia al descargar de Azure</p><p class="download-row"><span>Tenías</span><s>${escape(text(mine))}</s></p><p class="download-row"><span>Azure</span><strong>${escape(text(azure))}</strong></p><div class="conflict-actions"><button class="button small primary" data-action="download-choice" data-choice="azure" data-owner="${escape(owner)}">Validar Azure</button><button class="button small" data-action="download-choice" data-choice="local" data-owner="${escape(owner)}">Quedarme con lo mío</button><button class="button small" data-action="focus-capacity" data-owner="${escape(owner)}">Otro valor</button></div></div>`;
}
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
// One row per person and one column per working day, aligned for the whole team.
// The first row holds the days off shared by everyone.
const weekdayLetter = day => ['D','L','M','X','J','V','S'][new Date(day+'T00:00:00Z').getUTCDay()];
const weekStart = (day, index, days) => index>0 && new Date(day+'T00:00:00Z').getUTCDay() < new Date(days[index-1]+'T00:00:00Z').getUTCDay();
function capacityHoursField(member,entry) {
  const activities=entry.activities.length ? entry.activities : [{name:'',capacityPerDay:null}];
  return activities.map((a,i)=>`<label class="capacity-inline-hours">${activities.length>1 ? `<span>${escape(a.name || 'Actividad')}</span>` : ''}<input type="number" min="0" max="24" step="0.25" inputmode="decimal" value="${a.capacityPerDay ?? ''}" placeholder="—" data-capacity-hours data-member="${escape(member.id)}" data-activity="${i}" data-focus="hours:${escape(member.id)}:${i}" aria-label="Horas al día de ${escape(member.displayName)}${a.name ? ` en ${escape(a.name)}` : ''}"></label>`).join('');
}
function capacityDayCells(owner, name, days, daysOff, teamOff) {
  return days.map((day,index)=>{
    const shared=owner!=='team' && containsDay(teamOff,day), off=shared || containsDay(daysOff,day);
    const label=`${name} · ${date(day)}: ${shared ? 'descanso del equipo' : off ? 'libre' : 'disponible'}`;
    return `<td class="cg-day ${weekStart(day,index,days) ? 'week-start' : ''}"><button type="button" class="cg-toggle ${off ? 'off' : ''} ${shared ? 'shared' : ''}" data-action="card-day" data-owner="${escape(owner)}" data-day="${day}" data-focus="day:${escape(owner)}:${day}" aria-pressed="${off}" aria-label="${escape(label)}" title="${escape(label)}" ${shared ? 'disabled' : ''}></button></td>`;
  }).join('');
}
// Conflicts and downloaded differences get their own row; a plain pending change
// is a short line under the name.
// The undo button always keeps its place, so marking a change never moves the row.
function capacityUndo(owner, drafts) {
  const pending=!!drafts[owner];
  return `<button type="button" class="cg-undo" data-action="discard-capacity-entry" data-owner="${escape(owner)}" title="Deshacer el ajuste sin subir" aria-label="Deshacer el ajuste sin subir" ${pending ? '' : 'hidden'}>↶</button>`;
}
function capacityNoteRow(owner, drafts, conflicts, columns) {
  const note=conflicts[owner] ? '<p class="inline-error">Ha cambiado en Azure DevOps desde la importación. Descarga la capacidad o revísala en Cambios pendientes para elegir qué versión conservar.</p>' : capacityDownloadLine(owner);
  return note ? `<tr class="cg-note"><td colspan="${columns}">${note}</td></tr>` : '';
}
// Marking a day splits or merges the ranges that Azure stores.
function toggleDay(ranges, day) {
  if(containsDay(ranges,day)) return ranges.flatMap(r=>day<r.start || day>r.end ? [r] : [...(r.start<day ? [{start:r.start,end:new Date(Date.parse(day)-86400000).toISOString().slice(0,10)}] : []),...(day<r.end ? [{start:nextDay(day),end:r.end}] : [])]);
  const sorted=[...ranges,{start:day,end:day}].sort((a,b)=>a.start.localeCompare(b.start)), merged=[];
  for(const r of sorted){const last=merged.at(-1);if(last && r.start<=nextDay(last.end))last.end=last.end>r.end ? last.end : r.end;else merged.push({...r});}
  return merged;
}
let capacityOrder=null;
function capacityGrid(ws,iteration,drafts,conflicts,hours,total,team) {
  const days=capacityDates(iteration).filter(isWorkingDay), columns=days.length+3, teamOff=capacityOf(iteration.id,'team').daysOff;
  if (!days.length) return '<p class="notice warning">La iteración no tiene fechas definidas. Añade fechas en Azure DevOps para gestionar los días libres.</p>';
  const head=`<tr><th class="cg-person" scope="col">Persona</th><th class="cg-hours" scope="col">h / día</th>${days.map((day,index)=>`<th class="cg-day ${weekStart(day,index,days) ? 'week-start' : ''}" scope="col"><span>${weekdayLetter(day)}</span>${Number(day.slice(8))}</th>`).join('')}<th class="cg-total" scope="col">Total</th></tr>`;
  const teamRow=`<tr class="cg-team ${drafts.team ? 'changed' : ''}"><th class="cg-person" scope="row"><span class="cg-name"><span class="cg-team-icon" aria-hidden="true">☀</span><span><strong>Todo el equipo</strong><small>${team.off ? plural(team.off,'día libre','días libres') : 'Sin descansos comunes'}</small></span>${capacityUndo('team',drafts)}</span></th><td class="cg-hours"></td>${capacityDayCells('team','Todo el equipo',days,teamOff,teamOff)}<td class="cg-total">${number(total)} h</td></tr>${capacityNoteRow('team',drafts,conflicts,columns)}`;
  // Available people first; then those off every day, those with 0 h and, last,
  // those without capacity in Azure. Everyone without hours is dimmed.
  const rank=member=>{
    const total=hours[member.id], entry=capacityOf(iteration.id,member.id);
    if (total==null || !entry.activities.length) return 3;
    if (total>0) return 0;
    return capacityBreakdown(member.id,entry).daily>0 ? 1 : 2;
  };
  // The order is fixed on entering the step: editing never moves a row.
  const orderKey=`${state.mode}|${iteration.id}|${ws.members.map(m=>m.id).join(',')}`;
  if (capacityOrder?.key!==orderKey) capacityOrder={key:orderKey,ids:ws.members.map((member,index)=>({id:member.id,index,rank:rank(member)})).sort((a,b)=>a.rank-b.rank || a.index-b.index).map(p=>p.id)};
  const rows=capacityOrder.ids.map(id=>ws.members.findIndex(m=>m.id===id)).filter(index=>index>=0).map(index=>({member:ws.members[index],index,rank:rank(ws.members[index])})).map(({member,index,rank})=>{
    const entry=capacityOf(iteration.id,member.id), person=hours[member.id];
    return `<tr class="${rank ? 'zero-capacity' : ''} ${drafts[member.id] ? 'changed' : ''}"><th class="cg-person" scope="row"><span class="cg-name"><span class="avatar c${index%4}">${escape(initials(member.displayName))}</span><span><strong>${escape(member.displayName)}</strong><small>${capacityBreakdown(member.id,entry).available} días disponibles</small></span>${capacityUndo(member.id,drafts)}</span></th><td class="cg-hours">${capacityHoursField(member,entry)}</td>${capacityDayCells(member.id,member.displayName,days,entry.daysOff,teamOff)}<td class="cg-total">${person==null ? '—' : `${number(person)} h`}</td></tr>${capacityNoteRow(member.id,drafts,conflicts,columns)}`;
  }).join('');
  const cols=`<colgroup><col class="cg-col-person"><col class="cg-col-hours">${days.map(()=>'<col class="cg-col-day">').join('')}<col class="cg-col-total"></colgroup>`;
  return `<div class="capacity-grid-wrap"><table class="capacity-grid" style="--days:${days.length}">${cols}<thead>${head}</thead><tbody>${teamRow}${rows}</tbody></table></div>`;
}
function capacityView() {
  const ws=state.workspace, iteration=selected();
  if (!iteration || !ws.members.length) return '<div class="empty-result">Importa un equipo con integrantes e iteraciones para revisar la capacidad.</div>';
  const drafts=ws.capacityDrafts?.[iteration.id] ?? {}, conflicts=ws.capacityConflicts?.[iteration.id] ?? {}, hours=ws.capacityHours?.[iteration.id] ?? {};
  const known=ws.members.filter(m=>hours[m.id]!=null), total=known.reduce((sum,m)=>sum+hours[m.id],0);
  const team=capacityBreakdown('team',capacityOf(iteration.id,'team'));
  return `<section class="capacity-step">
    ${capacityGrid(ws,iteration,drafts,conflicts,hours,total,team)}
  </section>`;
}
// 'change' fires before focus moves on: wait for it to land on the next control.
const settledFocus = () => new Promise(resolve => setTimeout(resolve, 0));
// A field reached again after a redraw is selected, as when tabbing into it, so
// typing replaces its value.
function restoreFocus(selector) {
  const element=selector ? $(selector) : null;
  element?.focus({preventScroll:true});
  if (element?.matches?.('input')) element.select();
}
async function saveCapacity(owner, change, focus) {
  // Saving redraws the step, so the control the person moved to is read first.
  if (!focus) await settledFocus();
  const active=focus || capacityFocus(document.activeElement);
  await request('/api/capacity',{ iterationId:selectedIteration, key:owner, ...change });
  review=null; render();
  restoreFocus(active);
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
function plannerView() {
  const iteration=selected();
  if (!iteration) return '<div class="empty-result">Selecciona una iteración para elegir tareas.</div>';
  const {previous,tasks}=previousTasks(iteration), open=tasks.filter(t=>t.status==='open').length;
  // The previous iteration comes first while something there is still undecided.
  if (!previous) planningPeriod='current';
  else planningPeriod ??= open ? 'previous' : 'current';
  const periods=previous ? `<div class="planning-periods" role="group" aria-label="Iteración con la que trabajas"><button type="button" data-action="planning-period" data-period="previous" aria-pressed="${planningPeriod==='previous'}"><small>Iteración anterior</small><span>${escape(previous.name)}${open ? ` <em>${open} sin decidir</em>` : ' ✓'}</span></button><button type="button" data-action="planning-period" data-period="current" aria-pressed="${planningPeriod==='current'}"><small>Iteración actual</small><span>${escape(iteration.name)}</span></button></div>` : '';
  if (planningPeriod==='previous') return periods+previousView();
  return periods+board(iteration,state.workspace.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath===iteration.path));
}
// The available backlog filters as the person types, without redrawing the plan.
function refreshBacklog() {
  const tree=$('#backlog-tree');if(!tree)return;
  tree.innerHTML=leftPanelContent();
  $('#backlog-count').textContent=leftPanelCount();
}
function updatePlanningView() {
  $('#planning-view').innerHTML=stepView();
  if(backlogQuery.trim() && $('#backlog-count')) $('#backlog-count').textContent=leftPanelCount();
}

// Hour fields are edited on the card itself, with the names they have in Azure DevOps.
function taskEstimates(item) {
  const fields=estimateFields(state.workspace,item);
  const input=(field,label)=>label ? `<label class="task-field"><span title="${escape(label)} en Azure DevOps">${escape(label)}</span><input type="number" min="0" max="100000" step="0.25" inputmode="decimal" value="${item[field] ?? ''}" placeholder="—" data-task-field="${field}" data-task="${item.id}" data-focus="estimate:${item.id}:${field}" aria-label="${escape(label)} de #${item.id}"><small>h</small></label>` : '';
  const html=input('originalEstimate',fields.originalEstimate)+input('remainingWork',fields.remainingWork);
  return html ? `<div class="task-estimates">${html}</div>` : '';
}
function taskCard(item, inBacklog = false) {
  const estimates = taskEstimates(item);
  const effort = estimates ? '' : item.points !== null ? `${number(item.points)} pts` : 'Sin estimar';
  return `<article class="task-card ${item.modified ? 'modified' : ''}" draggable="true" data-task="${item.id}" data-action="edit" data-focus="card:${item.id}" tabindex="0" role="button" aria-label="Editar #${item.id}: ${escape(item.title)}">
    <div class="task-meta"><span class="type-icon ${item.type === 'Bug' ? 'bug' : ''}">${item.type === 'Bug' ? '◆' : '▣'}</span><span>${taskId(item)}</span><span>· ${escape(item.type)}</span>${item.modified ? `<span class="pill changed">${pendingLabel(item)}</span>` : ''}</div>
    <p class="task-title">${item.project ? `<small class="pill">${escape(item.project)}</small> ` : ''}${escape(item.title)}</p>
    <div class="task-footer"><div class="task-tags">${item.tags.slice(0,2).map(t=>`<span class="tag">${escape(t)}</span>`).join('')}${item.priority === 1 ? '<span class="tag" style="background:#fceee3;color:#a6743e">P1</span>' : ''}</div>${effort ? `<span class="effort">${effort}</span>` : ''}</div>
    ${estimates}
    ${inBacklog && item.iterationPath !== state.workspace.settings.backlogIteration.path ? `<div class="local-note">${escape(iterationName(item.iterationPath))}</div>` : ''}
  </article>`;
}
function lane(member, allItems, index, iteration) {
  const owned = allItems.filter(i => i.assignedTo === key(member));
  const hours = owned.reduce((sum,i) => sum + (i.remainingWork || 0),0);
  const capacity = state.workspace.capacityHours[iteration.id]?.[member.id] ?? null;
  const unknown = owned.filter(i=>i.canEstimateHours && i.remainingWork === null).length;
  const percent = capacity === null ? 0 : capacity === 0 ? (hours > 0 ? 100 : 0) : Math.min(100, Math.round(hours / capacity * 100));
  const open=expandedLanes.has(key(member)), id=`lane-${index}`;
  const meter=`<span class="capacity-line ${capacity !== null && hours > capacity ? 'over' : ''}"><span>${number(hours)} h ${unknown ? `+ ${unknown} sin estimar` : 'asignadas'}</span><span>${capacity === null ? 'Capacidad sin definir' : `${number(capacity)} h disponibles`}</span></span><span class="capacity-track" role="meter" aria-label="Carga de ${escape(member.displayName)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${number(hours)} horas asignadas; capacidad ${capacity === null ? 'desconocida' : number(capacity)}"><span class="capacity-fill" style="--load:${percent}%"></span></span>`;
  return `<section class="member ${open ? '' : 'collapsed'}" data-drop="${escape(key(member))}"><button type="button" class="member-header member-toggle" data-action="toggle-lane" data-member="${escape(key(member))}" data-focus="lane:${escape(key(member))}" aria-expanded="${open}" aria-controls="${id}"><span class="person"><span class="avatar c${index % 4}">${escape(initials(member.displayName))}</span><span class="person-detail"><strong class="member-name">${escape(member.displayName)}</strong><small>${owned.length} ${owned.length === 1 ? 'tarea' : 'tareas'} en la iteración</small></span><span class="lane-chevron" aria-hidden="true">›</span></span>${meter}</button><div id="${id}" ${open ? '' : 'hidden'}><div class="member-items">${filtered(owned).map(i=>taskCard(i)).join('') || '<div class="drop-hint">Arrastra una tarea aquí<br>o ábrela para asignarla</div>'}</div></div></section>`;
}
// The left panel alternates between the available backlog and the sprint's
// unassigned tasks; people take one row each on the right.
let leftPanel='backlog';
function unassignedTasks(iteration=selected()) {
  return state.workspace.effectiveItems.filter(i=>isExecutable(i) && iteration && i.iterationPath===iteration.path && !i.assignedTo);
}
function leftPanelContent() {
  if (leftPanel==='unassigned') {
    const tasks=unassignedTasks().filter(i=>matchesTask(i,backlogQuery)).sort((a,b)=>(a.priority ?? 5)-(b.priority ?? 5) || a.id-b.id);
    return tasks.map(i=>taskCard(i)).join('') || '<div class="drop-hint">Arrastra aquí una tarea para dejarla en el sprint sin responsable</div>';
  }
  return treeView({availableOnly:true,search:backlogQuery});
}
function leftPanelCount() {
  const iteration=selected(), total=leftPanel==='unassigned' ? unassignedTasks(iteration).length : state.workspace.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath!==iteration?.path).length;
  if (!backlogQuery.trim()) return String(total);
  const shown=leftPanel==='unassigned' ? unassignedTasks(iteration).filter(i=>matchesTask(i,backlogQuery)).length : $('#backlog-tree')?.querySelectorAll('.hierarchy-leaf').length ?? 0;
  return `${shown} de ${total}`;
}
function board(iteration, planned) {
  const ws = state.workspace, backlog = ws.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath !== iteration.path), unassigned=unassignedTasks(iteration);
  const members=planningMembers(iteration.id), activeKeys=new Set(members.map(key));
  const outside = planned.filter(i=>i.assignedTo && !ws.members.some(m=>key(m) === i.assignedTo));
  const excluded=planned.filter(i=>i.assignedTo && ws.members.some(m=>key(m)===i.assignedTo) && !activeKeys.has(i.assignedTo));
  const considered=planned.length-excluded.length;
  const panelButton=(panel,label,count)=>`<button type="button" data-action="left-panel" data-panel="${panel}" aria-pressed="${leftPanel===panel}"><span>${label}</span><span class="count" ${leftPanel===panel ? 'id="backlog-count"' : ''}>${count}</span></button>`;
  const download=leftPanel==='backlog' && ws.mode==='azure' ? `<button class="button small backlog-download" data-action="download-hierarchy" title="Trae de Azure DevOps las tareas y la jerarquía. Tus cambios locales se conservan y siguen pendientes de sincronizar.">Descargar jerarquía</button><div id="backlog-progress" hidden></div>` : '';
  const left=`<section class="backlog" data-drop="${leftPanel==='backlog' ? 'backlog' : ''}"><div class="panel-switch" role="group" aria-label="Tareas por repartir">${panelButton('backlog','Backlog',backlog.length)}${panelButton('unassigned','Sin asignar',unassigned.length)}</div>${download}<input class="search backlog-search" id="backlog-search" type="search" placeholder="Filtrar tareas" aria-label="Filtrar las tareas por su nombre" aria-controls="backlog-tree" value="${escape(backlogQuery)}" autocomplete="off"><div id="backlog-tree" class="${leftPanel==='unassigned' ? 'unassigned-list' : ''}">${leftPanelContent()}</div></section>`;
  const extra=(title,note,items,cls='')=>items.length ? `<section class="member ${cls}"><div class="member-header"><h3>${title}</h3><p class="section-meta" style="margin:0">${note}</p></div><div class="member-items">${filtered(items).map(i=>taskCard(i)).join('')}</div></section>` : '';
  return `<div class="board">${left}<section><div class="section-heading"><h2>Plan de la iteración</h2><span class="count">${considered} tareas${excluded.length ? ` · ${excluded.length} fuera del reparto` : ''}</span></div><div class="members-grid">${members.map((m,index)=>lane(m,planned,index,iteration)).join('')}${extra('Fuera del reparto','Tareas asignadas a personas con capacidad 0',excluded,'zero-capacity')}${extra('Otras personas','Responsables que no figuran en este equipo',outside)}</div></section></div>`;
}

function render() {
  const ws=state.workspace;
  $('#connection-button').textContent=state.config ? 'Configuración' : 'Conectar Azure DevOps';
  $('#save-status').textContent=ws ? savedStatus() : '';
  const section = ({ home: 'Inicio', permissions: 'Permisos', maintenance: 'Mantenimiento', reviews: 'Revisión de PRs' })[tab] || 'Planificación';
  $('.workspace-label').textContent = section;
  $('#app').setAttribute('aria-label', section);
  if (securitySnapshot?.scope !== JSON.stringify([state.config?.organization, state.config?.project])) securitySnapshot = null;
  if (maintenanceSnapshot?.scope !== JSON.stringify([state.mode, state.config?.organization, state.config?.project])) maintenanceSnapshot = null;
  if (tab === 'home') { $('#app').innerHTML = homeView(); return; }
  if (tab === 'maintenance') { $('#app').innerHTML = maintenanceView(maintenanceSnapshot, state, maintenanceSetup); return; }
  if (tab === 'reviews') { $('#app').innerHTML = reviewsView(state, prUi); return; }
  if (tab === 'permissions') { $('#app').innerHTML = permissionsView(securitySnapshot, state.config); return; }
  if(!ws){
    $('#app').innerHTML=`<div class="empty-panel"><h1>Planifica tu iteración</h1><p>${state.config ? `Importa ${escape(state.config.project)} / ${escape(state.config.team)} para traer sus iteraciones, capacidad y tareas abiertas. Solo se lee Azure DevOps: nada se modifica hasta que revises y sincronices.` : 'Conecta tu organización de Azure DevOps para traer iteraciones, capacidad y tareas, o prueba antes con un ejemplo que nunca contacta con Azure.'}</p><div class="actions"><button class="button primary" data-action="${state.config ? 'import' : 'connect'}">${state.config ? 'Importar equipo' : 'Conectar Azure DevOps'}</button><button class="button" data-action="demo">Probar con un ejemplo</button></div></div>`;return;
  }
  const iteration=selected();
  const changes=pendingCount(ws), drafted=Object.keys(ws.drafts).length || Object.keys(ws.capacityDrafts ?? {}).length;
  // Redrawing keeps the horizontal position of the capacity grid.
  const gridScroll=$('.capacity-grid-wrap')?.scrollLeft ?? 0;
  $('#app').innerHTML=`<div class="workspace-controls"><span class="team-label">${ws.sources ? ws.sources.map(s=>escape(s.config.project)).join(' · ') : escape(ws.config.project)+' / '+escape(ws.config.team)}</span>${ws.mode==='azure' ? '<button class="button small" data-action="connect">+ Añadir proyecto</button>' : ''}${ws.mode==='demo' ? '<span class="pill demo">Ejemplo</span>' : ''}<button class="button small" data-action="create">+ Crear</button>${iteration ? `<button class="button small iteration-select" data-action="tab" data-tab="iteration" title="Cambiar la iteración que se planifica">Planificando ${escape(iteration.name)} · Cambiar</button>` : ''}<div class="workspace-data-actions">${ws.mode==='demo' ? '' : `<button class="button small" data-action="import" ${drafted ? 'disabled' : ''} title="${drafted ? 'Sincroniza o descarta los cambios pendientes antes de actualizar' : 'Vuelve a leer todos los proyectos desde Azure DevOps'}">Actualizar toda la planificación</button>`}<a class="button small" href="/api/export" download>Exportar</a>${ws.mode==='demo' ? '<button class="button small subtle" data-action="azure">Salir del ejemplo</button>' : ''}</div></div>
  ${stepTabs(changes)}
  <div id="planning-view">${stepView()}</div>
  ${ws.warnings.length ? `<details class="import-notices"><summary>${ws.warnings.length} avisos de importación</summary>${ws.warnings.map(w=>`<p>${escape(w)}</p>`).join('')}</details>` : ''}`;
  if(gridScroll && $('.capacity-grid-wrap')) $('.capacity-grid-wrap').scrollLeft=gridScroll;
  if(backlogQuery.trim() && $('#backlog-count')) $('#backlog-count').textContent=leftPanelCount();
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
function reviewChanges() {
  tab='changes'; review=null; changesUi={...changesUi,error:'',confirmAll:false}; render();
}
const reviewFresh = () => review && review.version===state.version && review.mode===state.mode;
// Entering the step compares the local changes with Azure DevOps once; any later
// local change invalidates the comparison and it is read again.
async function loadReview() {
  if (tab!=='changes' || changesUi.loading || changesUi.syncing || changesUi.error || reviewFresh() || !pendingCount()) return;
  if (pending) { setTimeout(loadReview,200); return; }
  changesUi.loading=true; render();
  try {
    review=(await importWithProgress($('#changes-progress'), null, { path: '/api/review', input: {}, title: 'Comparando con Azure DevOps' })).review;
  } catch (error) {
    changesUi.error=error.message;
  } finally {
    changesUi.loading=false; render();
  }
}
function capacityText(entry, owner) {
  const hours=owner==='team' ? '' : entry.activities?.length ? entry.activities.map(a=>`${number(a.capacityPerDay)} h/día${a.name ? ` · ${a.name}` : ''}`).join(' + ') : '0 h/día';
  const off=entry.daysOff?.length ? entry.daysOff.map(r=>r.start===r.end ? date(r.start) : `${date(r.start)} – ${date(r.end)}`).join(', ') : 'sin días libres';
  return [hours,off].filter(Boolean).join(' · ');
}
// Incomplete splits are synced as they are and corrected in a later sync.
function incompleteAllocationsNotice() {
  const incomplete=review.incompleteAllocations ?? [];
  if (!incomplete.length) return '';
  return `<div class="notice warning">El reparto de capacidad se sincroniza con los datos actuales y se ajustará cuando lo completes: ${incomplete.map(p=>`${escape(p.label)} en ${escape(p.iteration)} (${p.missingEstimate ? 'tareas sin estimar, cuentan como 0 h' : 'sin días disponibles'})`).join('; ')}.</div>`;
}
function capacityReview() {
  const plans=review.capacityPlans ?? [];
  if (!plans.length) return '';
  return `<h3 class="review-section">Capacidad y días libres</h3>${plans.map(plan=>`<section class="review-item"><div class="review-item-head"><h3>${escape(plan.iteration)} · ${escape(plan.label)}</h3><button class="button small danger" data-action="discard-capacity-change" data-source="${escape(plan.sourceId || '')}" data-iteration="${escape(plan.iterationId)}" data-owner="${escape(plan.key)}">${plan.sourceId ? 'Mantener la de Azure' : 'Descartar'}</button></div>${plan.sourceId ? `<p class="local-note">${number(plan.hours)} h de tareas · ${number(plan.ratio*100)} % de la capacidad · ${number(plan.allocated)} h disponibles en este proyecto</p>` : ''}<div class="change-row"><span class="change-label">${plan.key==='team' ? 'Días libres' : 'Capacidad'}</span><span class="change-old">${escape(capacityText(plan.remote,plan.key))}${plan.conflict ? `<small>Al importar: ${escape(capacityText(plan.original,plan.key))}</small>` : ''}</span><span>→</span><span class="change-new">${escape(capacityText(plan.after,plan.key))}${plan.conflict ? ' ⚠' : ''}</span></div>${plan.conflict ? `<p class="local-note">La capacidad ha cambiado en Azure DevOps desde tu importación. Si sincronizas sin elegir, se sobrescribe con tu valor local.</p><div class="conflict-actions">${plan.sourceId ? '' : `<button class="button small" data-action="resolve-capacity-remote" data-iteration="${escape(plan.iterationId)}" data-owner="${escape(plan.key)}">Conservar la de Azure</button>`}<button class="button small" data-source="${escape(plan.sourceId || '')}" data-action="resolve-capacity-local" data-iteration="${escape(plan.iterationId)}" data-owner="${escape(plan.key)}">Mantener mis cambios</button></div>` : ''}${plan.unverified ? '<p class="local-note">No se pudo leer en Azure DevOps. Se volverá a leer justo antes de enviarla: si alguien la ha cambiado, no se sobrescribirá. Si Azure sigue sin responder, se enviará tu valor.</p>' : ''}${plan.applied && !plan.conflict ? '<p class="local-note">Estos valores ya están aplicados. Se actualizará la copia local.</p>' : ''}</section>`).join('')}`;
}
// The review says exactly what will be written. Conflicts do not block, so the
// button states when synchronizing will overwrite values changed in Azure DevOps.
function reviewPlan(p) {
  const heading=`${p.creation ? 'Nuevo · Crear' : taskId(state.workspace.items.find(i=>i.id===p.id) ?? p)+' · Modificar'} · ${escape(p.title)}`;
  const rows=p.changes.map(c=>`<div class="change-row"><span class="change-label">${escape(c.label)}</span><span class="change-old">${escape(pretty(c.field,c.before))}${c.conflict ? `<small>Al importar: ${escape(pretty(c.field,c.original))}</small>` : ''}</span><span>→</span><span class="change-new">${escape(pretty(c.field,c.after))}${c.conflict ? ' ⚠' : ''}</span></div>`).join('');
  const notes=[
    p.missing && '<p class="local-note">No se pudo leer esta tarea en Azure DevOps (puede haberse eliminado o no tienes acceso). No se enviará; el resto de cambios sí.</p>',
    p.unverified && '<p class="local-note">No se pudo leer en Azure DevOps. Solo se enviará si la tarea no ha cambiado desde la importación; si cambió, quedará pendiente para revisarla.</p>',
    p.conflicts.length && `<p class="local-note warning-text">Alguien la ha cambiado en Azure DevOps desde tu importación. Si sincronizas sin elegir, tu versión local sobrescribirá ${p.conflicts.length===1 ? 'ese campo' : 'esos campos'}.</p><div class="conflict-actions"><button class="button small" data-action="resolve-remote" data-task="${p.id}">Conservar versión de Azure</button><button class="button small" data-action="resolve-local" data-task="${p.id}">Mantener mis cambios</button></div>`,
    !p.missing && !p.unverified && !Object.keys(p.updates).length && '<p class="local-note">Estos valores ya están aplicados en Azure DevOps. Solo se actualizará la copia local.</p>',
  ].filter(Boolean).join('');
  const discard=`<button class="button small danger" data-action="discard-change" data-task="${p.id}">${p.creation ? 'Descartar creación' : 'Descartar'}</button>`;
  return `<section class="review-item"><div class="review-item-head"><h3>${heading}</h3>${discard}</div>${rows}${notes}</section>`;
}
function changesView() {
  const notice=changesUi.notice;
  if (changesUi.loading || changesUi.syncing) return `${notice}<div id="changes-progress"></div>`;
  if (!pendingCount()) return `${notice}<div class="empty-panel"><h2>Sin cambios pendientes</h2><p>La copia local coincide con lo último importado o sincronizado.</p><div class="actions"><button class="button" data-action="tab" data-tab="planning">Volver a planificar</button></div></div>`;
  if (changesUi.error) return `${notice}<div class="notice error">No se pudieron comparar los cambios con Azure DevOps: ${escape(changesUi.error)}</div><div class="actions changes-retry"><button class="button" data-action="retry-review">Reintentar</button></div>`;
  if (!reviewFresh()) { setTimeout(loadReview,0); return `${notice}<div id="changes-progress"></div>`; }
  const demo=state.mode==='demo', plans=review.plans, capacity=review.capacityPlans ?? [];
  const conflicts=plans.reduce((sum,p)=>sum+p.conflicts.length,0)+capacity.filter(p=>p.conflict).length;
  const summary=[plural(plans.length,'tarea'),...(capacity.length ? [plural(capacity.length,'ajuste de capacidad','ajustes de capacidad')] : []),demo ? 'datos de ejemplo' : 'comparados con la versión actual de Azure DevOps'].join(' · ');
  const unreadable=review.unreadable?.length ? `<div class="notice warning">No se pudo leer parte de Azure DevOps para compararla: ${review.unreadable.map(escape).join('; ')}. Antes de escribirlo se vuelve a comprobar, para no sobrescribir lo que otra persona haya cambiado desde la importación.</div>` : '';
  const conflictNotice=conflicts ? `<div class="notice warning"><strong>${plural(conflicts,'conflicto')}.</strong> Algo ha cambiado en Azure DevOps desde tu importación. Elige qué versión conservar en cada caso; si sincronizas sin elegir, se enviará tu versión local.</div>` : '';
  const syncLabel=demo ? 'Confirmar simulación' : conflicts ? `Sincronizar y sobrescribir ${plural(conflicts,'conflicto')}` : 'Sincronizar con Azure DevOps';
  const discardAll=changesUi.confirmAll
    ? `<span class="changes-confirm">¿Descartar ${plural(pendingCount(),'cambio')}? Se recuperan los valores importados.</span><button class="button" data-action="cancel-discard-all">Cancelar</button><button class="button danger" data-action="confirm-discard">Sí, descartar todo</button>`
    : '<button class="button danger" data-action="discard-all">Descartar todo</button>';
  const actions=`<div class="changes-actions">${discardAll}${review.token && !changesUi.confirmAll ? `<button class="button primary ${conflicts && !demo ? 'danger' : ''}" data-action="sync">${escape(syncLabel)} ↗</button>` : ''}</div>`;
  return `${notice}<section class="changes-page"><header class="changes-heading"><div><h2>${demo ? 'Cambios del ejemplo' : 'Cambios pendientes'}</h2><p>${escape(summary)}</p></div>${actions}</header><p class="local-note">Se envían las asignaciones, iteraciones, prioridades, horas y estados que has cambiado. El reparto de ramas y las confirmaciones son organización local y no se envían. Descartar un cambio lo deshace solo en local.</p>${unreadable}${conflictNotice}<div class="changes-list">${plans.map(reviewPlan).join('')}${incompleteAllocationsNotice()}${capacityReview()}</div></section>`;
}
async function synchronize() {
  const token=review.token, title=state.mode==='demo' ? 'Simulando sincronización' : 'Sincronizando cambios';
  changesUi={...changesUi,syncing:true,notice:'',confirmAll:false}; render();
  let data;
  try { data=await importWithProgress($('#changes-progress'), null, { path: '/api/sync', input: { token }, title }); }
  catch (error) { changesUi.notice=`<div class="notice error">${escape(error.message)}</div>`; }
  finally { changesUi.syncing=false; review=null; }
  if (data) {
    const result=data.result, capacity=result.capacity ?? { successes:[], failures:[] };
    const failed=result.failures.length+capacity.failures.length, succeeded=result.successes.length+capacity.successes.length;
    const confirmed=[plural(result.successes.length,'tarea'), ...(capacity.successes.length ? [plural(capacity.successes.length,'ajuste de capacidad','ajustes de capacidad')] : [])];
    const done=succeeded ? `Se han confirmado ${confirmed.join(' y ')}${result.demo ? ' en el ejemplo local' : ' en Azure DevOps'}.` : 'No se ha confirmado ningún cambio.';
    changesUi.notice=failed
      ? `<div class="notice warning changes-result"><strong>${succeeded ? 'Sincronización parcial.' : 'No se pudo sincronizar.'}</strong> ${escape(done)} Lo que falló sigue abajo como pendiente.${result.failures.map(f=>`<p class="inline-error">${taskId(state.workspace?.items.find(i=>i.id===f.id) ?? f)}: ${escape(f.error)}</p>`).join('')}${capacity.failures.map(f=>`<p class="inline-error">${escape(f.label)}: ${escape(f.error)}</p>`).join('')}</div>`
      : `<div class="notice changes-result"><strong>${result.demo ? 'Simulación completada.' : 'Cambios sincronizados.'}</strong> ${escape(done)}</div>`;
  }
  render();
}
// Capacity moves both ways for the iteration being planned: download replaces the
// local copy with Azure, upload sends only this iteration's capacity changes.
let capacityNotice='';
function capacityControls() {
  const ws=state.workspace, iteration=selected(), azure=ws?.mode==='azure';
  if(!ws || !iteration) return '';
  const pending=ws.capacityPendingByIteration?.[iteration.id] ?? 0;
  const upload=`<button class="button small ${pending ? 'primary' : ''}" data-action="upload-capacity" ${pending ? '' : 'disabled'} title="${pending ? `Envía a Azure DevOps los ${pending} ajustes de capacidad de ${escape(iteration.name)}` : 'No hay cambios de capacidad pendientes en esta iteración'}">${azure ? 'Subir capacidad' : 'Simular subida'}<span class="upload-count" aria-hidden="${!pending}">${pending || ''}</span></button>`;
  const download=azure ? `<button class="button small" data-action="download-capacity" title="Sobrescribe la capacidad local de ${escape(iteration.name)} con la de Azure DevOps">Descargar capacidad</button>` : '';
  const undo=`<button class="button small" data-action="discard-capacity" ${ws.capacityDrafts?.[iteration.id] ? '' : 'disabled'}>Deshacer ajustes</button>`;
  return `<div class="workspace-controls">${download}${upload}${undo}</div><div id="capacity-download-progress" hidden></div>${capacityNotice}`;
}
async function uploadCapacity() {
  const iteration=selected();
  capacityNotice='';
  const data=await importWithProgress($('#capacity-download-progress'),null,{path:'/api/upload-capacity',input:{iterationId:iteration.id},title:`Subiendo la capacidad de ${iteration.name}`});
  const {successes,failures,conflicts}=data.result;
  const problems=[...failures.map(f=>`<p class="inline-error">${escape(f.label)}: ${escape(f.error)}</p>`),...conflicts.map(label=>`<p class="inline-error">${escape(label)}: ha cambiado en Azure DevOps desde la importación. No se ha tocado; descarga la capacidad o revísala en Cambios pendientes para elegir.</p>`)].join('');
  capacityNotice=problems ? `<div class="notice warning capacity-notice"><strong>${successes.length ? `Subidos ${plural(successes.length,'ajuste')}, faltan ${failures.length+conflicts.length}.` : 'No se ha subido la capacidad.'}</strong>${problems}</div>` : '';
  review=null;render();
  if(!problems) toast(`Capacidad subida: ${plural(successes.length,'ajuste')} sincronizado${successes.length===1 ? '' : 's'}.`);
}
async function downloadCapacity() {
  capacityNotice='';
  const iteration=selected();
  await importWithProgress($('#capacity-download-progress'),null,{path:'/api/download-capacity',input:{iterationId:iteration.id},title:`Descargando la capacidad de ${iteration.name}`});
  review=null;render();
  const differences=Object.keys(state.workspace.capacityDownloads?.[iteration.id]?.local ?? {}).length;
  toast(differences ? `Capacidad descargada. ${plural(differences,'diferencia','diferencias')} con tu copia local por validar.` : 'Capacidad descargada. Coincide con tu copia local.');
}
// Tasks and hierarchy come from Azure while local changes stay on top of them.
async function downloadHierarchy() {
  await importWithProgress($('#backlog-progress'),null,{path:'/api/refresh-section',input:{section:'tasks'},title:'Descargando la jerarquía'});
  review=null;render();
  const pending=Object.keys(state.workspace.drafts ?? {}).length;
  toast(pending ? `Jerarquía descargada. Tus ${plural(pending,'cambio')} local${pending===1 ? '' : 'es'} siguen pendientes de sincronizar.` : 'Jerarquía descargada desde Azure DevOps.');
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
  const ws=state.workspace, iteration=ws ? selected() : null, changes=pendingCount(ws);
  const team=state.config?.team ? `${state.config.project} / ${state.config.team}` : ws ? `${ws.config.project} / ${ws.config.team}` : 'Neo Team';
  const planning=!ws ? 'Sin datos importados' : `${iteration ? `Planificando ${escape(iteration.name)}` : 'Sin iteraciones'}${changes ? ` · ${changes} pendiente${changes===1 ? '' : 's'} de sincronizar` : ''}`;
  const issues=maintenanceSnapshot?.issues;
  const start=!state.config && !ws ? `<div class="home-start"><div><strong>Primer paso: conecta tu organización</strong><p>Neo Team lee tu equipo de Azure DevOps y guarda la planificación en este ordenador. Nada se envía a Azure hasta que revisas y confirmas los cambios. ¿Solo quieres verlo? Prueba con datos de ejemplo.</p></div><div class="actions"><button class="button primary" data-action="connect">Conectar Azure DevOps</button><button class="button" data-action="demo">Probar con un ejemplo</button></div></div>` : '';
  return `<section class="home"><header class="home-heading"><p class="eyebrow">GESTIÓN DEL EQUIPO</p><h1>${escape(team)}</h1><p>Elige por dónde empezar.</p></header>${start}<div class="home-sections">
    <button class="home-card" data-action="open-planning"><span class="home-icon" aria-hidden="true">◷</span><strong>Planificación</strong><span>Iteraciones, capacidad y reparto de tareas del equipo.</span><small>${planning}</small></button>
    <button class="home-card maintenance" data-action="open-maintenance"><span class="home-icon" aria-hidden="true">⚙</span><strong>Mantenimiento</strong><span>${escape(state.maintenanceSettings?.type || 'Functional Issue')} no cerrados del proyecto.</span><small>${issues ? `${issues.length} no cerrado${issues.length===1 ? '' : 's'} en la última consulta` : state.maintenanceSettings ? 'Se consultan al entrar' : 'Primero eliges qué estados son cerrados'}</small></button>
    <button class="home-card reviews" data-action="open-reviews"><span class="home-icon" aria-hidden="true">⌥</span><strong>Revisión de PRs</strong><span>Revisa pull requests con GitHub Copilot y publica los comentarios que confirmes.</span><small>${state.prReviews?.length ? plural(state.prReviews.length,'revisión guardada','revisiones guardadas') : 'Nada se publica sin tu confirmación'}</small></button>
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
// An operation shown in its own dialog with progress; the dialog closes when it ends.
async function runOperation(path, input, title, subtitle) {
  showModal(title, subtitle, '<div id="connection-progress"></div>');
  const data = await importWithProgress($('#connection-progress'), null, { path, input, title });
  modal.close();
  return data;
}
async function startReview(input) {
  const demo = state.mode === 'demo';
  const data = await runOperation('/api/pr-review', input, 'Revisar con GitHub Copilot', demo ? 'Ejemplo: la revisión se simula y nada sale de este equipo.' : 'Se lee el pull request en Azure DevOps y GitHub Copilot revisa su diff. Todavía no se publica nada.');
  prUi.reviewId = data.reviewId; tab = 'reviews'; render(); window.scrollTo({ top: 0 });
  toast('Revisión lista. Ajusta los comentarios y publica los que quieras.');
}
async function loadPullRequests(repository) {
  prUi.repository = repository; prUi.pullRequests = null;
  if (repository) prUi.pullRequests = (await runOperation('/api/pr-list', { repository }, 'Buscar pull requests', `Pull requests activos de «${repository}».`)).pullRequests;
  render();
}
const currentReview = () => state.prReviews?.find(r => r.id === prUi.reviewId);
async function saveFinding(el, change) {
  const focus = capacityFocus(document.activeElement);
  await request('/api/pr-finding', { id: prUi.reviewId, findingId: el.dataset.prSelect || el.dataset.prBody, ...change });
  render();
  if (focus) $(focus)?.focus();
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
  'open-reviews': () => { prUi.reviewId = null; tab = 'reviews'; render(); window.scrollTo({ top: 0 }); },
  'pr-copilot-status': async () => {
    prUi.copilot = (await runOperation('/api/copilot-status', {}, 'Comprobar GitHub Copilot', 'Se inicia Copilot con la cuenta de GitHub de este equipo. No se envía ningún código.')).copilot;
    render(); toast(prUi.copilot.isAuthenticated ? `GitHub Copilot está listo con la cuenta ${prUi.copilot.login || 'de GitHub'}.` : 'No hay una sesión de GitHub con Copilot. Revisa las indicaciones.', prUi.copilot.isAuthenticated ? 'info' : 'error');
  },
  'pr-load-repositories': async () => {
    prUi.repositories = (await runOperation('/api/pr-repositories', {}, 'Buscar repositorios', 'Repositorios de Git del proyecto.')).repositories;
    if (prUi.repositories.length === 1) await loadPullRequests(prUi.repositories[0].name); else render();
  },
  'pr-review': el => startReview({ repository: el.dataset.repository, pullRequestId: Number(el.dataset.pullRequest) }),
  'pr-open': el => { prUi.reviewId = el.dataset.review; render(); window.scrollTo({ top: 0 }); },
  'pr-back': () => { prUi.reviewId = null; render(); },
  'pr-delete': el => showModal('Descartar revisión', 'Se borra solo de Neo Team.', '<p>La revisión y sus comentarios sin publicar se eliminan de este equipo. Los comentarios ya publicados en Azure DevOps no se tocan.</p>', `<button class="button" data-action="close">Cancelar</button><button class="button danger" data-action="pr-delete-confirm" data-review="${escape(el.dataset.review)}">Descartar revisión</button>`),
  'pr-delete-confirm': async el => { await request('/api/pr-review-delete', { id: el.dataset.review }); prUi.reviewId = null; modal.close(); render(); toast('Revisión descartada.'); },
  'pr-publish': el => {
    const review = currentReview(), includeSummary = !!$('#pr-include-summary')?.checked && !review?.summaryPublished;
    if (!review) throw new Error('La revisión ya no está disponible.');
    const confirmation = publishConfirmation(review, includeSummary);
    if (!confirmation.count) throw new Error('Marca al menos un comentario o el resumen para publicar.');
    const demo = review.mode === 'demo';
    showModal(demo ? 'Simular publicación' : 'Publicar en Azure DevOps', `${plural(confirmation.count, 'comentario')} · pull request !${review.pullRequest.id}`, confirmation.html, `<button class="button" data-action="close">Cancelar</button><button class="button primary" data-action="pr-publish-confirm" data-review="${escape(review.id)}" data-summary="${includeSummary}">${demo ? 'Simular publicación' : `Publicar ${plural(confirmation.count, 'comentario')}`}</button>`);
  },
  'pr-publish-confirm': async el => {
    const demo = state.mode === 'demo';
    const data = await runOperation('/api/pr-publish', { id: el.dataset.review, includeSummary: el.dataset.summary === 'true' }, demo ? 'Simulando la publicación' : 'Publicando en Azure DevOps', 'Se comprueba el pull request y se añaden los comentarios confirmados.');
    render();
    const { published, failures } = data.result;
    showModal(failures.length ? (published.length ? 'Publicación parcial' : 'No se pudo publicar') : demo ? 'Publicación simulada' : 'Comentarios publicados', published.length ? `${plural(published.length, 'comentario publicado', 'comentarios publicados')}${demo ? ' en el ejemplo' : ' en Azure DevOps'}.` : 'No se ha publicado ningún comentario.',
      failures.length ? `<div class="notice warning">Los que fallaron siguen pendientes. Al volver a publicar se comprueba primero si llegaron a Azure, para no duplicarlos.</div>${failures.map(f => `<p class="inline-error" style="margin-top:15px">${escape(f.id === 'summary' ? 'Resumen' : currentReview()?.findings.find(x => x.id === f.id)?.title ?? f.id)}: ${escape(f.error)}</p>`).join('')}` : `<div class="notice">${demo ? 'En el ejemplo no se contacta con Azure DevOps.' : 'Los comentarios ya están en el pull request.'}</div>`);
  },
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
  'download-capacity':downloadCapacity,
  'download-hierarchy':downloadHierarchy,
  'left-panel':el=>{leftPanel=el.dataset.panel;updatePlanningView();$(`[data-action="left-panel"][data-panel="${leftPanel}"]`)?.focus({preventScroll:true});},
  'upload-capacity':uploadCapacity,
  'download-choice':async el=>{
    const choice=el.dataset.choice;
    await request('/api/capacity-download-choice',{iterationId:selectedIteration,key:el.dataset.owner,choice});review=null;render();
    toast(choice==='azure' ? 'Validada la capacidad de Azure DevOps.' : 'Recuperada tu capacidad local. Pendiente de sincronizar.');
  },
  connect: connection, close: () => modal.close(), 'save-config':()=>saveConfig(false),
  demo: async()=>{ await request('/api/mode',{ mode:'demo' }); selectedIteration=''; tab='iteration'; render(); },
  azure: async()=>{ await request('/api/mode',{ mode:'azure' }); selectedIteration=''; tab='iteration'; render(); },
  import: importData,
  create: el=>createItem(Number(el.dataset.parent)),
  edit: el=>editTask(Number(el.dataset.task)),
  'choose-iteration': el=>{selectedIteration=el.dataset.iteration;planningPeriod=null;tab='capacity';render();window.scrollTo({top:0});},
  'planning-period': el=>{planningPeriod=el.dataset.period;previousGroupOrder=null;render();$(`[data-action="planning-period"][data-period="${planningPeriod}"]`)?.focus({preventScroll:true});},
  'toggle-previous': el=>{const group=el.dataset.group;if(expandedPrevious.has(group))expandedPrevious.delete(group);else expandedPrevious.add(group);previousGroupOrder=null;updatePlanningView();$(`[data-action="toggle-previous"][data-group="${CSS.escape(group)}"]`)?.focus({preventScroll:true});},
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
  'toggle-lane': el=>{const member=el.dataset.member;if(expandedLanes.has(member))expandedLanes.delete(member);else expandedLanes.add(member);updatePlanningView();$(`[data-action="toggle-lane"][data-member="${CSS.escape(member)}"]`)?.focus({preventScroll:true});},
  'expand-tree': ()=>{collapsed.clear();updatePlanningView();},
  'collapse-tree': ()=>{state.workspace.items.filter(i=>!isExecutable(i)).forEach(i=>collapsed.add(i.id));updatePlanningView();},
  tab: el=>{if(el.dataset.tab==='changes' && tab!=='changes'){reviewChanges();return;}tab=el.dataset.tab;capacityNotice='';if(tab==='capacity')capacityOrder=null;if(tab==='planning')previousGroupOrder=null;changesUi={...changesUi,notice:'',error:'',confirmAll:false};render();},
  review: reviewChanges, sync:synchronize,
  'retry-review':()=>{changesUi.error='';render();},
  'discard-all':()=>{changesUi.confirmAll=true;render();},
  'cancel-discard-all':()=>{changesUi.confirmAll=false;render();},
  'confirm-discard':async()=>{changesUi={...changesUi,confirmAll:false,notice:''};await request('/api/discard');review=null;render();toast('Cambios locales descartados.');},
  'discard-change':async el=>{changesUi.notice='';await request('/api/discard',{id:Number(el.dataset.task)});review=null;render();toast('Cambio descartado en local.');},
  'discard-capacity-change':async el=>{
    changesUi.notice='';
    const {source,iteration,owner}=el.dataset;
    if(source) await request('/api/discard-allocation',{sourceId:source,iterationId:iteration,key:owner});
    else await request('/api/discard-capacity',{iterationId:iteration,key:owner});
    review=null;render();toast(source ? 'Se mantiene la capacidad de Azure DevOps en ese proyecto.' : 'Cambio de capacidad descartado en local.');
  },
  'discard-one':async el=>{await request('/api/discard',{id:Number(el.dataset.task)});modal.close();render();toast('Cambios de la tarea deshechos.');},
  'focus-capacity':el=>{const owner=el.dataset.owner, input=$(owner==='team' ? '[data-owner="team"][data-action="card-day"]' : `[data-focus="hours:${CSS.escape(owner)}:0"]`);input?.focus();input?.select?.();},
  'card-day':async el=>{const owner=el.dataset.owner;await saveCapacity(owner,{daysOff:toggleDay(capacityOf(selectedIteration,owner).daysOff,el.dataset.day)},`[data-focus="${CSS.escape(el.dataset.focus)}"]`);},
  'discard-capacity':async()=>{await request('/api/discard-capacity',{iterationId:selectedIteration});review=null;render();toast('Cambios de capacidad deshechos.');},
  'discard-capacity-entry':async el=>{await request('/api/discard-capacity',{iterationId:selectedIteration,key:el.dataset.owner});review=null;render();},
  'resolve-capacity-local':el=>resolveCapacity(el.dataset.iteration,el.dataset.owner,'local',el.dataset.source),
  'resolve-capacity-remote':el=>resolveCapacity(el.dataset.iteration,el.dataset.owner,'remote'),
  'resolve-local':el=>resolveTask(Number(el.dataset.task),'local'),
  'resolve-remote':el=>resolveTask(Number(el.dataset.task),'remote'),
};
async function resolveCapacity(iterationId,owner,choice,sourceId) {
  await request('/api/resolve-capacity',{iterationId,key:owner,choice,sourceId}); review=null; render();
  toast(choice==='remote' ? 'Se ha conservado la capacidad de Azure DevOps.' : 'Se mantienen tus cambios.');
}
async function resolveTask(id,choice) {
  await request('/api/resolve',{id,choice}); review=null; render();
  toast(choice==='remote' ? 'Se ha conservado la versión de Azure DevOps.' : 'Se mantienen tus cambios.');
}
$('#connection-button').onclick = () => { if (state && !pending) connection(); };
modal.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
document.addEventListener('click', async event => {
  // A link to Azure DevOps opens there without triggering the card or branch action.
  if (event.target.closest('a[href]')) return;
  // Fields inside a card are edited in place; they do not open the card.
  if (event.target.closest('.task-estimates')) return;
  const target = event.target.closest('[data-action]');
  if (!target || pending || target.disabled) return;
  if (target.closest('summary')) event.preventDefault();
  const action = actions[target.dataset.action];
  if (!action) return;
  try { await action(target); } catch (error) { errorInModal(error); }
});
document.addEventListener('keydown', event => {
  const card = event.target.closest('.task-card');
  if (card && event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); if (!pending) editTask(Number(card.dataset.task)); }
  // Arrow keys move between the planning steps; Enter or Space opens one.
  const step = event.target.closest('.step-tab');
  if (step && ['ArrowLeft','ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const steps = [...document.querySelectorAll('.step-tab:not(:disabled)')], index = steps.indexOf(step);
    steps[(index + (event.key === 'ArrowRight' ? 1 : steps.length - 1)) % steps.length]?.focus();
  }
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
    if (event.target.id === 'pr-url-form') { await startReview({ url: new FormData(event.target).get('url') }); return; }
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
    if(el.id==='pr-repository'){await loadPullRequests(el.value);return;}
    if(el.id==='pr-include-summary'){prUi.includeSummary=el.checked;return;}
    if(el.dataset.prSelect){await saveFinding(el,{selected:el.checked});return;}
    if(el.dataset.prBody){await saveFinding(el,{body:el.value});return;}
    if(el.dataset.capacityHours!==undefined){await saveCapacityHours(el);return;}
    if(el.dataset.taskField){
      // The control the person moved to (Tab, click) is read once focus has
      // settled, before saving redraws the plan.
      await settledFocus();
      const next=capacityFocus(document.activeElement), value=el.value==='' ? null : Number(el.value);
      if(value===null || !Number.isFinite(value) || value<0){render();throw new Error('Indica un número de horas válido.');}
      await request('/api/stage',{edits:[{id:Number(el.dataset.task),changes:{[el.dataset.taskField]:value}}]});review=null;render();
      restoreFocus(next);return;
    }
    if(el.dataset.previousMove!==undefined){if(el.value)await decidePrevious(Number(el.dataset.task),'move',el.value);return;}
  }catch(error){render();errorInModal(error);}
});
document.addEventListener('input',event=>{
  if (event.target.id === 'security-group-search') filterGroups();
  if (event.target.dataset.securityFilter === 'text') filterPermissions(securitySnapshot.report, 'text', event.target.value);
  if (event.target.dataset.maintenanceFilter === 'text') filterMaintenance(maintenanceSnapshot, 'text', event.target.value);
  if (event.target.name === 'other' && event.target.closest('#completed-state-form')) $('[data-other-state]').checked = true;
  if(event.target.id==='search'){query=event.target.value;updatePlanningView();}
  if(event.target.id==='backlog-search'){backlogQuery=event.target.value;refreshBacklog();}
});
document.addEventListener('toggle',event=>{
  const element=event.target;
  if (!element.matches?.('details[data-node], details[data-project]')) return;
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
  try { await stage(id,target === 'backlog' ? {iterationPath:state.workspace.settings.backlogIteration.path} : {assignedTo:target,iterationPath:iteration.path});toast('Planificación guardada en local.'); } catch(error){toast(error.message,'error');}
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
// An unexpected failure in the interface is shown instead of silently stopping an action.
window.addEventListener('unhandledrejection',event=>toast(event.reason?.message || 'Se produjo un error inesperado. Recarga la página si algo no responde.','error'));
window.addEventListener('error',event=>{ if (event.message) toast(`Error inesperado en la interfaz: ${event.message}. Recarga la página si algo no responde.`,'error'); });
$('#toast').addEventListener('click',()=>{ $('#toast').hidden=true; });
loadState().then(() => { registerTools(); if (!state.busy && state.stateReview) showStateReview(state.stateReview); else return resumeOperation(); }).catch(error=>{
  $('#app').innerHTML=`<div class="notice error">${escape(error.message)} Recarga esta página cuando el servidor local esté disponible.</div>`;
});
