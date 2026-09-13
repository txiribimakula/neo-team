import { permissionsView, filterPermissions, filterGroups, resetPermissionFilters } from './permissions.js';
import { hierarchy, ancestors, participantSources, eligibleTasks, filterHierarchy, isExecutable, typeRank, selectionSummary, capacityStatus, orderedPlanningMembers } from './hierarchy.js';
const $ = (selector, parent = document) => parent.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const key = member => (member.uniqueName || member.id || member.displayName || '').toLowerCase();
const number = value => new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(value);
const initials = name => name.trim().split(/\s+/).slice(0,2).map(s => s[0]).join('').toUpperCase();
const date = value => value ? new Date(value).toLocaleDateString('es', { day:'numeric', month:'short', timeZone:'UTC' }) : 'Sin fecha';
let securitySnapshot = null;
let state, selectedIteration = '', tab = 'capacity', query = '', pending = false, review, toastTimer;
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
  showModal('Crear elemento','Se guardará en local hasta revisar y sincronizar.',`<form id="create-form"><label class="form-field">Tipo<select name="type" id="create-type">${['Epic','Feature','User Story','Task','Bug'].map(t=>`<option ${t===type ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label class="form-field">Título<input name="title" required maxlength="255" autofocus></label><label class="form-field">Padre<select name="parent" id="create-parent"></select></label><label class="form-field">Responsable<select name="assignedTo"><option value="">Sin asignar</option>${ws.members.map(m=>`<option value="${escape(key(m))}" ${tab==='planning' && key(m)===pickerMember ? 'selected' : ''}>${escape(m.displayName)}</option>`).join('')}</select></label><label class="form-field">Iteración<select name="iterationPath">${[{path:ws.settings.backlogIteration.path,name:'Backlog'},...ws.iterations].map(i=>`<option value="${escape(i.path)}" ${tab==='planning' && i.id===selectedIteration ? 'selected' : ''}>${escape(i.name)}</option>`).join('')}</select></label><label class="form-field" id="create-hours">Horas pendientes<input name="remainingWork" type="number" min="0" max="100000" step="0.25" placeholder="Sin estimar"></label></form>`,'<button class="button" data-action="close">Cancelar</button><button class="button primary" form="create-form" type="submit">Crear en local</button>');
  updateCreationParents(parentId);
}
function updateCreationParents(parentId) {
  const type=$('#create-type').value,allowed={Epic:[],Feature:['Epic'],'User Story':['Feature'],Task:['User Story','Product Backlog Item','Requirement'],Bug:['User Story','Product Backlog Item','Requirement']}[type];
  $('#create-parent').innerHTML='<option value="">'+(type==='Epic' ? 'Sin padre' : 'Selecciona el padre')+'</option>'+state.workspace.effectiveItems.filter(i=>allowed.includes(i.type)).map(i=>`<option value="${i.id}" ${i.id===parentId ? 'selected' : ''}>${escape(i.title)} · ${i.localOnly ? 'nuevo' : '#'+i.id}</option>`).join('');
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
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type':'application/json', 'X-Neo-CSRF': state.csrf }, body: JSON.stringify({ ...input, version: state.version }) });
    const data = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(data.error || 'No se pudo completar la operación.'), { stateReview: data.stateReview });
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
  showModal('Conecta tu equipo', 'Configura Azure DevOps desde aquí. Los datos se guardan en este equipo.', `
    <form id="connection-form">
      <label class="form-field">Organización<input name="organization" required maxlength="150" placeholder="mi-organizacion o https://dev.azure.com/mi-organizacion" value="${escape(c.organization)}" autocomplete="off"></label>
      <label class="form-field">Acceso<select name="authentication"><option value="interactive">Iniciar sesión con Microsoft</option><option value="azcli" ${c.authentication === 'azcli' ? 'selected' : ''}>Usar mi sesión de Azure CLI</option></select><small>Con Microsoft se abrirá tu navegador para iniciar sesión. La aplicación no solicita tu contraseña.</small></label>
      ${connectionField('project', 'Proyecto', c.project)}
      ${connectionField('team', 'Equipo', c.team)}
      <details><summary class="text-muted" style="font-size:14px;cursor:pointer;margin-bottom:14px">Opciones avanzadas</summary><label class="form-field">Tenant de Microsoft Entra (opcional)<input name="tenant" placeholder="Identificador del directorio" value="${escape(c.tenant)}"><small>Déjalo vacío para detectar el directorio de tu organización.</small></label></details>
      <div id="connection-progress" hidden></div>
      <div class="notice">Se importarán integrantes, iteraciones, backlog y capacidad. Podrás preparar cambios en local y revisarlos antes de sincronizarlos.</div>
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
      message(`Cargando ${plural}… Completa el acceso de Microsoft si se abre el navegador.`);
      try {
        const data = await request(`/api/${kind}`, { config });
        items = [...new Set(data[kind].map(item => item.name))].sort((a, b) => a.localeCompare(b, 'es'));
        message(items.length ? `${items.length} ${plural} disponibles. Escribe para filtrar y selecciona uno.` : `No hay ${plural} disponibles. Comprueba el acceso o introduce el nombre manualmente.`);
        input.focus();
        open();
      } catch (error) {
        items = null;
        message(`No se pudieron cargar los ${plural}: ${error.message} Abre el desplegable para reintentar.`, true);
        input.focus();
      } finally {
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
  const isImport = !start && (!existing || existing.path === '/api/import');
  let finish, fail;
  const completion = existing ? new Promise((resolve, reject) => { finish = resolve; fail = reject; }) : null;
  const controller = new AbortController();
  let stopped = false, timer;
  $('#modal-error').hidden = true;
  target.hidden = false;
  target.className = 'import-progress';
  target.innerHTML = `<div class="import-progress-heading"><span class="spinner" aria-hidden="true"></span><strong>Importando equipo</strong></div><p class="import-progress-phase" role="status" aria-live="polite">Conectando con Azure DevOps. Completa el acceso de Microsoft si se solicita.</p><ul class="import-progress-counts" aria-label="Datos obtenidos"></ul><small class="import-progress-note">Los elementos detectados pueden aumentar al encontrar tareas hijas.</small><small class="import-progress-connection" role="status"></small><small class="import-progress-time"></small><button type="button" class="button small" data-cancel-operation>Cancelar consulta</button>`;
  target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const cancelButton = $('[data-cancel-operation]', target);
  if (start) $('.import-progress-heading strong', target).textContent = 'Consultando permisos';
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
    cancelButton.hidden = existing ? !['/api/import', '/api/projects', '/api/teams', '/api/security-groups', '/api/security-audit'].includes(existing.path) : false;
    cancelButton.disabled = progress.cancellable === false || !!progress.cancelRequested;
    const elapsed = progress.startedAt ? Math.floor((Date.now() - progress.startedAt) / 1000) : 0;
    const idle = progress.updatedAt ? Math.floor((Date.now() - progress.updatedAt) / 1000) : 0;
    $('.import-progress-time', target).textContent = progress.startedAt ? `${Math.floor(elapsed / 60)} min ${elapsed % 60} s en curso${idle >= 30 ? ` · ${idle} s sin nuevos datos. Azure puede estar esperando la autenticación o una respuesta.` : ''}` : '';
    $('.import-progress-phase', target).textContent = progress.message;
    const c = progress.counts || {};
    const entries = [
      c.namespacesRead !== undefined && `${c.namespacesRead} / ${c.namespaceTotal} ámbitos consultados`,
      c.resources !== undefined && `${c.resources} recursos encontrados`,
      c.grants !== undefined && `${c.grants} entradas de permisos encontradas`,
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
        else if (['failed', 'cancelled'].includes(progress.status)) fail(Object.assign(new Error(progress.error || progress.message), { stateReview: progress.stateReview }));
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
    $('.import-progress-note', target).textContent = 'La operación no se ha completado. Puedes volver a intentarlo.';
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
let recoveringOperation = false;
function showStateReview(review) {
  const normalize = value => value.trim().toLowerCase();
  const states = new Map(review.states.map(item => [normalize(item.name), item]));
  if (!states.has(normalize(review.state))) states.set(normalize(review.state), { name: review.state, category: '' });
  showModal('Revisar estados de importación', `Proyecto ${review.project} · ${review.type}. Indica qué estados deben entrar en la planificación.`, `
    <p>No se ha podido clasificar <strong>${escape(review.state)}</strong>. Tus decisiones se guardarán para este proyecto y tipo de elemento.</p>
    <form id="state-rules-form">${[...states.values()].map((item, index) => {
      const required = normalize(item.name) === normalize(review.state);
      return `<label class="form-field">${escape(item.name)}${required ? ' · pendiente de decidir' : ''}<select name="rule-${index}" data-state="${escape(item.name)}" ${required ? 'required' : ''}><option value="">${required ? 'Elige cómo tratar este estado' : item.category ? `Según Azure (${escape(item.category)})` : normalize(item.name) === 'discarded' ? 'Excluir descartados' : 'Sin decisión guardada'}</option><option value="exclude">Excluir: cerrado o descartado</option><option value="include">Importar: sigue abierto</option></select></label>`;
    }).join('')}</form>
    <details class="state-review-fields" open><summary>Campos del elemento #${escape(review.item.id)}</summary><div class="table-wrap"><table><thead><tr><th>Campo</th><th>Valor</th></tr></thead><tbody>${Object.entries(review.item.fields).map(([name, value]) => `<tr><td>${escape(name)}</td><td><pre>${escape(typeof value === 'object' ? JSON.stringify(value, null, 2) : value)}</pre></td></tr>`).join('')}</tbody></table></div></details>`,
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
    const peopleButton=`<button class="people-button" type="button" data-action="participants" data-task="${node.id}" aria-controls="people-popover" aria-expanded="${peopleItem===node.id}" aria-label="Repartir ${escape(node.title)} entre personas">${participants.slice(0,3).map((m,index)=>`<span class="avatar c${index%4}" title="${escape(m.displayName)}">${escape(initials(m.displayName))}</span>`).join('')}<span>${participants.length ? `${participants.length} · reparto local` : '+ Repartir'}</span></button>`;
    const type=`<span class="node-type kind-${typeRank(node)}">${escape(node.type)}</span>`;
    if (!isExecutable(node)) {
      return `<details class="hierarchy-branch" data-node="${node.id}" ${picker || search || !collapsed.has(node.id) ? 'open' : ''}><summary><span class="branch-chevron">›</span>${type}<span class="branch-title">${escape(node.title)} <small>#${node.id}${node.contextOnly ? ' · contexto' : ''}</small>${node.modified ? `<span class="pill changed">${pendingLabel(node)}</span>` : ''}</span><button class="button small" data-action="create" data-parent="${node.id}" aria-label="Crear hijo de ${escape(node.title)}">+</button><button class="button small" data-action="edit" data-task="${node.id}">Editar</button>${picker ? `<button class="remove-branch" type="button" data-action="remove-branch" data-task="${node.id}" aria-label="Quitar ${escape(node.title)} de ${escape(memberName(member))}" title="Quita la rama y desmarca sus tareas de esta iteración">Quitar rama ×</button>` : peopleButton}</summary><div class="hierarchy-children">${node.children.map(child=>nodeHtml(child,depth+1)).join('') || '<p class="branch-empty">Sin tareas o bugs disponibles en esta rama.</p>'}</div></details>`;
    }
    const already=node.iterationPath === iteration?.path && node.assignedTo === member;
    const other=!!node.assignedTo && node.assignedTo !== member;
    const disabled=other;
    const effort=node.remainingWork !== null ? `${number(node.remainingWork)} h` : node.points !== null ? `${number(node.points)} pts` : 'Sin estimar';
    const controls=picker ? `<input type="checkbox" name="taskIds" value="${node.id}" aria-label="Seleccionar ${escape(node.title)}" ${disabled ? 'disabled' : ''} ${already ? 'checked' : ''}>` : '';
    const status=picker && other ? `Responsable: ${memberName(node.assignedTo)}` : already ? 'Seleccionada' : iterationName(node.iterationPath);
    const contents=`${controls}<div class="leaf-copy"><div class="leaf-meta">${type}<span>#${node.id}</span>${node.modified ? `<span class="pill changed">${pendingLabel(node)}</span>` : ''}</div>${picker ? `<span class="leaf-title">${escape(node.title)}</span>` : `<button class="leaf-title" data-action="edit" data-task="${node.id}">${escape(node.title)}</button>`}<span class="leaf-status">${escape(status)}${!picker && node.assignedTo ? ` · ${escape(memberName(node.assignedTo))}` : ''}</span></div><span class="effort">${effort}</span>${picker ? '' : peopleButton}`;
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
  const peopleScroll=$('.planning-people')?.scrollTop || 0;
  pickerMember=member;focusedMember=member;pickerQuery='';tab='planning';planningMode='person';render();
  if($('.planning-people'))$('.planning-people').scrollTop=peopleScroll;
}
function pickTasks(member) {
  modal.close();
  pickerMember=state.workspace.members.some(m=>key(m)===member) ? member : focusedMember || pickerMember;
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
function capacityDraftCount(ws = state?.workspace) { return Object.values(ws?.capacityDrafts ?? {}).reduce((sum,drafts)=>sum+Object.keys(drafts).length,0); }
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
    <div class="capacity-people">${ws.members.map((member,index)=>{
      const entry=capacityOf(iteration.id,member.id), b=capacityBreakdown(member.id,entry), total=hours[member.id];
      return `<section class="capacity-card capacity-profile ${drafts[member.id] ? 'changed' : ''}"><div class="capacity-person"><span class="avatar c${index%4}">${escape(initials(member.displayName))}</span><div><strong>${escape(member.displayName)}</strong><span class="text-muted">${entry.activities.length>1 ? `${entry.activities.length} actividades` : 'Disponibilidad en la iteración'}</span></div></div><div class="capacity-profile-total">${total==null ? '—' : number(total)}<small> h</small></div><p class="capacity-equation">${total==null ? 'Define las horas para empezar' : `${number(b.daily)} h al día × ${b.available} días disponibles`}</p><div class="capacity-mini-days" aria-label="${b.available} días disponibles, ${b.off} días libres">${b.days.filter(isWorkingDay).slice(0,40).map(day=>`<span class="${containsDay(entry.daysOff,day) || containsDay(capacityOf(iteration.id,'team').daysOff,day) ? 'off' : ''}" title="${date(day)}"></span>`).join('')}</div><div class="capacity-profile-footer"><span>${b.off ? `${b.off} días libres` : 'Sin ausencias'}${b.days.length ? '' : ' · fechas sin definir'}</span><button class="button small" data-action="edit-capacity" data-owner="${escape(member.id)}">Ajustar capacidad</button></div>${capacityStatusLine(member.id,drafts,conflicts)}</section>`;
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
  if(!iteration || !ws.members.length)return '<div class="empty-result">Importa un equipo con integrantes e iteraciones para planificar.</div>';
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
  const iteration=selected();
  $('#planning-view').innerHTML=tab==='capacity' ? capacityView() : tab==='planning' ? plannerView() : tab==='hierarchy' ? hierarchyView() : iteration ? board(iteration,state.workspace.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath===iteration.path)) : hierarchyView();
  updateBulkCheckbox();
}

function taskCard(item, inBacklog = false) {
  const effort = item.remainingWork !== null ? `${number(item.remainingWork)} h` : item.points !== null ? `${number(item.points)} pts` : 'Sin estimar';
  return `<article class="task-card ${item.modified ? 'modified' : ''}" draggable="true" data-task="${item.id}" data-action="edit" tabindex="0" role="button" aria-label="Editar #${item.id}: ${escape(item.title)}">
    <div class="task-meta"><span class="type-icon ${item.type === 'Bug' ? 'bug' : ''}">${item.type === 'Bug' ? '◆' : '▣'}</span><span>#${item.id}</span><span>· ${escape(item.type)}</span>${item.modified ? `<span class="pill changed">${pendingLabel(item)}</span>` : ''}</div>
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

function render() {
  const ws=state.workspace;
  $('#connection-button').textContent=state.config ? 'Configuración' : 'Conectar Azure DevOps';
  $('#save-status').textContent=ws ? savedStatus() : '';
  $('.workspace-label').textContent = tab === 'permissions' ? 'Permisos' : 'Planificación';
  $('#app').setAttribute('aria-label', tab === 'permissions' ? 'Permisos' : 'Planificación');
  if (securitySnapshot?.scope !== JSON.stringify([state.config?.organization, state.config?.project])) securitySnapshot = null;
  if (tab === 'permissions') { $('#app').innerHTML = permissionsView(securitySnapshot, state.config); return; }
  if(!ws){
    $('#app').innerHTML=`<div class="empty-panel"><h1>Planifica tu iteración</h1><button class="button primary" data-action="${state.config ? 'import' : 'connect'}">${state.config ? 'Importar equipo' : 'Conectar Azure DevOps'}</button><button class="button" data-action="demo">Probar con un ejemplo</button></div>`;return;
  }
  if(focusedMember && !ws.members.some(m=>key(m)===focusedMember))focusedMember='';
  const iteration=selected();ensureSelection();
  const changes=Object.keys(ws.drafts).length+capacityDraftCount(ws);
  $('#app').innerHTML=`<div class="workspace-controls"><span class="team-label">${escape(ws.config.project)} / ${escape(ws.config.team)}</span>${ws.mode==='demo' ? '<span class="pill demo">Ejemplo</span>' : ''}<button class="button small" data-action="create">+ Crear</button><select id="iteration-select" class="iteration-select" aria-label="Iteración">${ws.iterations.map(i=>`<option value="${escape(i.id)}" ${i.id===selectedIteration ? 'selected' : ''}>${escape(i.name)}</option>`).join('')}</select><div class="workspace-data-actions"><button class="button small" data-action="import" ${changes || ws.mode==='demo' ? 'disabled' : ''} title="${ws.mode==='demo' ? 'Conecta Azure DevOps para actualizar datos' : changes ? 'Revisa o descarta los cambios pendientes antes de actualizar' : 'Actualizar desde Azure DevOps'}">Actualizar datos</button><a class="button small" href="/api/export" download>Exportar</a>${ws.mode==='demo' ? '<button class="button small subtle" data-action="azure">Salir del ejemplo</button>' : ''}</div></div>
  <nav class="step-tabs" aria-label="Pasos de planificación"><button class="step-tab ${tab==='capacity' ? 'active' : ''}" data-action="tab" data-tab="capacity" ${tab==='capacity' ? 'aria-current="step"' : ''}><span>1</span>Capacidad</button><button class="step-tab ${tab==='hierarchy' ? 'active' : ''}" data-action="tab" data-tab="hierarchy" ${tab==='hierarchy' ? 'aria-current="step"' : ''}><span>2</span>Repartir ramas</button><button class="step-tab ${tab==='planning' ? 'active' : ''}" data-action="tab" data-tab="planning" ${tab==='planning' ? 'aria-current="step"' : ''}><span>3</span>Elegir tareas</button><button class="step-tab" data-action="review" ${changes ? '' : 'disabled'}><span>4</span>${changes ? `${changes} pendiente${changes===1 ? '' : 's'} · Revisar y sincronizar` : 'Revisar'}</button></nav>
  <div id="planning-view">${tab==='capacity' ? capacityView() : tab==='planning' ? plannerView() : tab==='hierarchy' ? hierarchyView() : iteration ? board(iteration,ws.effectiveItems.filter(i=>isExecutable(i) && i.iterationPath===iteration.path)) : hierarchyView()}</div>
  ${ws.warnings.length ? `<details class="import-notices"><summary>${ws.warnings.length} avisos de importación</summary>${ws.warnings.map(w=>`<p>${escape(w)}</p>`).join('')}</details>` : ''}`;
  updateBulkCheckbox();
}
function editTask(id) {
  const ws = state.workspace, item = ws.effectiveItems.find(i=>i.id === id);
  if (!item) throw new Error('La tarea ya no está disponible.');
  if (item.contextOnly) {toast('Este elemento es solo contexto de otro equipo.');return;}
  const paths = [{ path:ws.settings.backlogIteration.path, name:'Backlog' },...ws.iterations];
  if (!paths.some(i=>i.path === item.iterationPath)) paths.push({ path:item.iterationPath, name:item.iterationPath });
  showModal(`#${id} · ${item.type}`, item.title, `<form id="task-form" data-task="${id}"><label class="form-field">Título<input name="title" required maxlength="255" value="${escape(item.title)}"></label><label class="form-field">Responsable<select name="assignedTo"><option value="">Sin asignar</option>${ws.members.map(m=>`<option value="${escape(key(m))}" ${key(m) === item.assignedTo ? 'selected' : ''}>${escape(m.displayName)}</option>`).join('')}${item.assignedTo && !ws.members.some(m=>key(m) === item.assignedTo) ? `<option value="${escape(item.assignedTo)}" selected>${escape(item.assigneeName || item.assignedTo)} (fuera del equipo)</option>` : ''}</select></label><label class="form-field">Iteración<select name="iterationPath">${paths.map(i=>`<option value="${escape(i.path)}" ${item.iterationPath === i.path ? 'selected' : ''}>${escape(i.name)}</option>`).join('')}</select></label><div class="grid2">${item.canPrioritize ? `<label class="form-field">Prioridad<select name="priority">${[1,2,3,4].map(p=>`<option value="${p}" ${item.priority === p ? 'selected' : ''}>P${p} · ${['Crítica','Alta','Media','Baja'][p-1]}</option>`).join('')}</select></label>` : ''}${item.canEstimateHours ? `<label class="form-field">Horas pendientes<input name="remainingWork" type="number" min="0" max="100000" step="0.25" value="${item.remainingWork ?? ''}" placeholder="Sin estimar"><small>Se guardan como trabajo restante.</small></label>` : `<div class="form-field">Estimación<span class="text-muted">${item.points !== null ? `${number(item.points)} puntos` : 'Sin estimar'} · consulta</span></div>`}</div><div class="notice">${ws.mode === 'demo' ? 'Datos de ejemplo. Puedes probar los cambios sin afectar a Azure DevOps.' : 'Este cambio se guarda en local. Se enviará cuando revises y confirmes la sincronización.'}</div></form>`, `${item.modified ? `<button class="button danger" data-action="discard-one" data-task="${id}">Deshacer cambios</button>` : '<button class="button" data-action="close">Cancelar</button>'}<button class="button primary" type="submit" form="task-form">Guardar en local</button>`);
}
async function stage(id, changes) {
  await request('/api/stage', { edits:[{ id, changes }] }); review = null; render();
}
async function reviewChanges() {
  showModal('Revisar cambios', 'Comprobando la última versión de cada tarea y de la capacidad.', '<p class="busy-note"><span class="spinner"></span> Consultando las tareas… Completa el acceso de Microsoft si se solicita.</p>');
  const result = await request('/api/review'); review = result.review; render(); renderReview();
}
function capacityText(entry, owner) {
  const hours=owner==='team' ? '' : entry.activities?.length ? entry.activities.map(a=>`${number(a.capacityPerDay)} h/día${a.name ? ` · ${a.name}` : ''}`).join(' + ') : '0 h/día';
  const off=entry.daysOff?.length ? entry.daysOff.map(r=>r.start===r.end ? date(r.start) : `${date(r.start)} – ${date(r.end)}`).join(', ') : 'sin días libres';
  return [hours,off].filter(Boolean).join(' · ');
}
function capacityReview() {
  const plans=review.capacityPlans ?? [];
  if (!plans.length) return '';
  return `<h3 class="review-section">Capacidad y días libres</h3>${plans.map(plan=>`<section class="review-item"><h3>${escape(plan.iteration)} · ${escape(plan.label)}</h3><div class="change-row"><span class="change-label">${plan.key==='team' ? 'Días libres' : 'Capacidad'}</span><span class="change-old">${escape(capacityText(plan.remote,plan.key))}${plan.conflict ? `<small>Al importar: ${escape(capacityText(plan.original,plan.key))}</small>` : ''}</span><span>→</span><span class="change-new">${escape(capacityText(plan.after,plan.key))}${plan.conflict ? ' ⚠' : ''}</span></div>${plan.conflict ? `<p class="local-note">La capacidad ha cambiado en Azure DevOps desde tu importación.</p><div class="conflict-actions"><button class="button small" data-action="resolve-capacity-remote" data-iteration="${escape(plan.iterationId)}" data-owner="${escape(plan.key)}">Conservar la de Azure</button><button class="button small" data-action="resolve-capacity-local" data-iteration="${escape(plan.iterationId)}" data-owner="${escape(plan.key)}">Mantener mis cambios</button></div>` : ''}${plan.applied && !plan.conflict ? '<p class="local-note">Estos valores ya están aplicados. Se actualizará la copia local.</p>' : ''}</section>`).join('')}`;
}
function renderReview() {
  const conflicts = review.plans.filter(p=>p.conflicts.length);
  showModal(state.mode === 'demo' ? 'Simular sincronización' : 'Revisar y sincronizar', `${review.plans.length} tareas${review.capacityPlans?.length ? ` · ${review.capacityPlans.length} ajuste${review.capacityPlans.length===1 ? '' : 's'} de capacidad` : ''} · ${state.mode === 'demo' ? 'datos de ejemplo' : 'comparados con la versión actual de Azure DevOps'}`, `<p class="local-note">Las asignaciones de responsable se sincronizan. El reparto de ramas entre varias personas y las confirmaciones son organización local.</p>${conflicts.length || review.capacityPlans?.some(p=>p.conflict) ? '<div class="notice warning" style="margin-bottom:20px">Algo ha cambiado en Azure DevOps. Elige qué versión conservar y vuelve a revisar antes de sincronizar.</div>' : ''}${review.plans.map(p=>`<section class="review-item"><h3>${p.creation ? 'Nuevo · Crear' : '#'+p.id+' · Modificar'} · ${escape(p.title)}</h3>${p.changes.map(c=>`<div class="change-row"><span class="change-label">${escape(c.label)}</span><span class="change-old">${escape(pretty(c.field,c.before))}${c.conflict ? `<small>Al importar: ${escape(pretty(c.field,c.original))}</small>` : ''}</span><span>→</span><span class="change-new">${escape(pretty(c.field,c.after))}${c.conflict ? ' ⚠' : ''}</span></div>`).join('')}${p.conflicts.length ? `<p class="local-note">La versión remota ha cambiado desde tu importación.</p><div class="conflict-actions"><button class="button small" data-action="resolve-remote" data-task="${p.id}">Conservar versión de Azure</button><button class="button small" data-action="resolve-local" data-task="${p.id}">Mantener mis cambios</button></div>` : ''}${!Object.keys(p.updates).length ? '<p class="local-note">Estos valores ya están aplicados. Se actualizará la copia local.</p>' : ''}</section>`).join('')}${capacityReview()}`, `<button class="button danger" data-action="discard-all">Descartar cambios</button><button class="button" data-action="close">Seguir planificando</button>${review.token ? `<button class="button primary" data-action="sync">${state.mode === 'demo' ? 'Confirmar simulación' : 'Sincronizar con Azure DevOps'} ↗</button>` : ''}`);
}
async function synchronize() {
  const data = await request('/api/sync', { token:review.token }); review = null; render();
  const result = data.result, capacity = result.capacity ?? { successes:[], failures:[] };
  const failed = result.failures.length + capacity.failures.length;
  const confirmed = [`${result.successes.length} tarea${result.successes.length===1 ? '' : 's'}`, ...(capacity.successes.length ? [`${capacity.successes.length} ajuste${capacity.successes.length===1 ? '' : 's'} de capacidad`] : [])];
  showModal(failed ? 'Sincronización parcial' : result.demo ? 'Simulación completada' : 'Cambios sincronizados', `Se han confirmado ${confirmed.join(' y ')}${result.demo ? ' en el ejemplo local' : ' en Azure DevOps'}.`, `${failed ? `<div class="notice warning">Los cambios pendientes se conservan en local. Vuelve a revisarlos para reintentar solo lo que falta.</div>${result.failures.map(f=>`<p class="inline-error" style="margin-top:15px">#${f.id}: ${escape(f.error)}</p>`).join('')}${capacity.failures.map(f=>`<p class="inline-error" style="margin-top:15px">${escape(f.label)}: ${escape(f.error)}</p>`).join('')}` : `<div class="notice">${result.demo ? 'La simulación solo ha actualizado los datos de ejemplo de este equipo.' : 'La copia local refleja los cambios confirmados por Azure DevOps.'}</div>`}`, `${failed ? '<button class="button primary" data-action="review">Revisar pendientes</button>' : '<button class="button primary" data-action="close">Volver a la planificación</button>'}`);
}
async function importData() {
  showModal('Actualizar desde Azure DevOps', 'Leyendo el equipo y sus tareas.', '<div id="connection-progress"></div>');
  await importWithProgress($('#connection-progress')); modal.close(); render(); toast('Datos actualizados desde Azure DevOps.');
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
  'security-page': el => filterPermissions(securitySnapshot.report, 'page', el.dataset.direction),
  connect: connection, close: () => modal.close(), 'save-config':()=>saveConfig(false),
  demo: async()=>{ await request('/api/mode',{ mode:'demo' }); selectedIteration=''; render(); },
  azure: async()=>{ await request('/api/mode',{ mode:'azure' }); selectedIteration=''; render(); },
  import: importData,
  create: el=>createItem(Number(el.dataset.parent)),
  edit: el=>editTask(Number(el.dataset.task)),
  participants: el=>editParticipants(Number(el.dataset.task),el),
  'remove-branch': el=>saveParticipation(Number(el.dataset.task),pickerMember,false),
  'pick-tasks': el=>pickTasks(el.dataset.member),
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
  'resolve-capacity-local':el=>resolveCapacity(el.dataset.iteration,el.dataset.owner,'local'),
  'resolve-capacity-remote':el=>resolveCapacity(el.dataset.iteration,el.dataset.owner,'remote'),
  'resolve-local':el=>resolveTask(Number(el.dataset.task),'local'),
  'resolve-remote':el=>resolveTask(Number(el.dataset.task),'remote'),
};
async function resolveCapacity(iterationId,owner,choice) {
  await request('/api/resolve-capacity',{iterationId,key:owner,choice}); render();
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
  if (tabButton && ['ArrowLeft','ArrowRight'].includes(event.key)) { event.preventDefault(); const tabs=['capacity','hierarchy','planning']; tab=tabs[(tabs.indexOf(tab)+(event.key==='ArrowRight'?1:2))%3]; render(); $(`[data-tab="${tab}"]`).focus(); }
});
document.addEventListener('submit', async event => {
  event.preventDefault(); if (pending) return;
  try {
    if (event.target.id === 'capacity-editor-form') {
      const e=capacityEditor;
      await saveCapacity(e.owner,{...(e.owner==='team' ? {} : {activities:e.activities}),daysOff:e.daysOff});
      modal.close();capacityEditor=null;
      $(`[data-action="edit-capacity"][data-owner="${CSS.escape(e.owner)}"]`)?.focus({preventScroll:true});
      toast('Capacidad guardada en local.');return;
    }
    if (event.target.id === 'state-rules-form') {
      const choices = [...event.target.querySelectorAll('select[data-state]')].filter(el => el.value).map(el => ({ state: el.dataset.state, action: el.value }));
      await request('/api/state-rules', { choices });
      await importData();
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
    if(el.id==='iteration-select'){selectedIteration=el.value;render();}
  }catch(error){renderSaved();errorInModal(error);}
});
document.addEventListener('input',event=>{
  if (event.target.id === 'security-group-search') filterGroups();
  if (event.target.dataset.securityFilter === 'text') filterPermissions(securitySnapshot.report, 'text', event.target.value);
  if(event.target.dataset.editActivity!==undefined){capacityEditor.activities[Number(event.target.dataset.editActivity)].capacityPerDay=Number(event.target.value);refreshCapacityEditor();}
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
loadState().then(() => { registerTools(); if (!state.busy && state.stateReview) showStateReview(state.stateReview); else return resumeOperation(); }).catch(error=>{
  $('#app').innerHTML=`<div class="notice error">${escape(error.message)} Recarga esta página cuando el servidor local esté disponible.</div>`;
});
