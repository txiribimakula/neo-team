// Maintenance: the open items of a type (Functional Issue by default), read from
// Azure DevOps with the closed states the person chose for the project.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const categoryLabels = { proposed: 'Sin empezar', inprogress: 'En curso', resolved: 'Resuelto', completed: 'Completado', removed: 'Retirado' };
const day = value => value ? new Date(value).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
let filters = { text: '', state: 'all' };

export function maintenanceView(snapshot, state, setup) {
  const settings = state.maintenanceSettings, demo = state.mode === 'demo';
  const project = demo ? 'Datos de ejemplo' : state.config?.project;
  const details = [escape(project || 'Conecta un proyecto para consultar su mantenimiento.')];
  if (settings && !setup) details.push(`cerrados: ${escape(settings.closedStates.join(', ') || 'ninguno')} <button class="link-button" data-action="maintenance-edit-settings">Cambiar</button>`);
  if (snapshot && !setup) details.push(`consultado el ${escape(new Date(snapshot.fetchedAt).toLocaleString('es'))}`);
  const heading = `<header class="maintenance-heading"><div><p class="eyebrow">MANTENIMIENTO</p><h1>${escape(settings?.type || 'Functional Issue')} no cerrados</h1><p>${details.join(' · ')}</p></div>${snapshot && settings && !setup ? '<button class="button" data-action="maintenance-refresh">Actualizar</button>' : ''}</header>`;
  const page = body => `<section class="maintenance-page">${heading}${body}</section>`;
  if (!state.config?.project && !demo) return page('<div class="empty-panel"><h2>Sin proyecto conectado</h2><p>Conecta Azure DevOps para consultar el mantenimiento del proyecto.</p><button class="button primary" data-action="connect">Conectar Azure DevOps</button></div>');
  if (!settings || setup) return page(setupView(settings, setup));
  if (!snapshot) return page(`<div class="empty-panel"><h2>Sin consultar</h2><p>Se traerán todos los «${escape(settings.type)}» del proyecto cuyo estado no sea ${escape(settings.closedStates.join(', ') || 'ninguno')}.</p><button class="button primary" data-action="maintenance-refresh">Consultar Azure DevOps</button></div>`);
  const issues = snapshot.issues, byState = new Map();
  for (const issue of issues) byState.set(issue.state, (byState.get(issue.state) ?? 0) + 1);
  if (filters.state !== 'all' && !byState.has(filters.state)) filters.state = 'all';
  return page(`<div class="maintenance-stats"><div><strong>${issues.length}</strong><span>no cerrados</span></div><div><strong>${issues.filter(i => !i.assignedTo).length}</strong><span>sin responsable</span></div>${[...byState].map(([name, count]) => `<div><strong>${count}</strong><span>${escape(name)}</span></div>`).join('')}</div>
    ${snapshot.limited ? `<div class="notice warning">Se muestran los primeros ${issues.length}. Hay más elementos no cerrados en Azure DevOps.</div>` : ''}
    <div class="maintenance-filters"><input type="search" data-maintenance-filter="text" aria-label="Buscar elementos" placeholder="Buscar por título, responsable, área o etiqueta" value="${escape(filters.text)}"><select data-maintenance-filter="state" aria-label="Filtrar por estado"><option value="all">Todos los estados</option>${[...byState.keys()].map(name => `<option value="${escape(name)}" ${filters.state === name ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select></div>
    <div id="maintenance-rows">${issuesTable(snapshot)}</div>`);
}

// The person chooses the type and, from its possible states, which ones are closed.
function setupView(settings, setup) {
  const type = setup?.type ?? settings?.type ?? 'Functional Issue', states = setup?.states;
  const cancel = settings ? '<button type="button" class="button" data-action="maintenance-cancel-settings">Cancelar</button>' : '';
  const typeField = `<div class="maintenance-setup-type"><label class="form-field">Tipo de elemento<input id="maintenance-type" value="${escape(type)}" maxlength="128" autocomplete="off"></label><button type="button" class="button ${states ? '' : 'primary'}" data-action="maintenance-load-states">${states ? 'Volver a cargar estados' : 'Cargar estados'}</button></div>`;
  if (!states) return `<div class="maintenance-setup"><h2>¿Qué se considera cerrado?</h2><p class="text-muted">Para traer solo los elementos no cerrados necesito saber qué estados cuentan como cerrados. Carga los estados posibles del tipo en el proyecto y elígelos.</p>${typeField}${cancel ? `<div class="actions">${cancel}</div>` : ''}</div>`;
  const chosen = new Set(settings?.type === type ? settings.closedStates : states.filter(s => ['completed', 'removed'].includes(s.category)).map(s => s.name));
  return `<div class="maintenance-setup"><h2>¿Qué estados de «${escape(type)}» se consideran cerrados?</h2><p class="text-muted">La consulta traerá todos los elementos cuyo estado no esté marcado. Vienen propuestos los de categoría Completado y Retirado en Azure DevOps.</p>${typeField}
    <form id="maintenance-settings-form" data-type="${escape(type)}"><div class="maintenance-states">${states.map(s => `<label class="participant-option"><input type="checkbox" name="closed" value="${escape(s.name)}" ${chosen.has(s.name) ? 'checked' : ''}><span><strong>${escape(s.name)}</strong><small>${escape(categoryLabels[s.category] || 'Sin categoría')}</small></span></label>`).join('')}</div><div class="actions">${cancel}<button class="button primary" type="submit">Guardar y consultar</button></div></form></div>`;
}

function issuesTable(snapshot) {
  if (!snapshot.issues.length) return `<div class="empty-result">No hay elementos «${escape(snapshot.type)}» no cerrados en el proyecto.</div>`;
  const text = filters.text.trim().toLowerCase();
  const rows = snapshot.issues.filter(i => (filters.state === 'all' || i.state === filters.state) && (!text || `${i.id} ${i.title} ${i.assignedTo} ${i.state} ${i.areaPath} ${i.tags.join(' ')}`.toLowerCase().includes(text)));
  if (!rows.length) return '<div class="empty-result">Ningún elemento coincide con los filtros.</div>';
  const title = issue => snapshot.demo ? escape(issue.title)
    : `<a href="https://dev.azure.com/${encodeURIComponent(snapshot.organization)}/${encodeURIComponent(snapshot.project)}/_workitems/edit/${issue.id}" target="_blank" rel="noopener noreferrer">${escape(issue.title)}</a>`;
  return `<p class="local-note" role="status">${rows.length === snapshot.issues.length ? `${rows.length} elementos` : `${rows.length} de ${snapshot.issues.length} elementos`}</p><div class="table-wrap"><table class="maintenance-table"><thead><tr><th>ID</th><th>Título</th><th>Estado</th><th>Responsable</th><th>Prioridad</th><th>Área</th><th>Actualizado</th></tr></thead><tbody>${rows.map(i => `<tr><td>#${i.id}</td><td><span class="table-title">${title(i)}</span>${i.tags.length ? `<span class="task-tags">${i.tags.slice(0, 3).map(t => `<span class="tag">${escape(t)}</span>`).join('')}</span>` : ''}</td><td><span class="pill maintenance-${escape(i.category || 'none')}" title="${escape(categoryLabels[i.category] || 'Sin categoría')}">${escape(i.state)}</span></td><td>${i.assignedTo ? escape(i.assignedTo) : '<span class="text-muted">Sin asignar</span>'}</td><td>${i.priority ?? '—'}</td><td class="text-muted">${escape(i.areaPath)}</td><td class="text-muted">${day(i.changedAt)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function filterMaintenance(snapshot, name, value) {
  filters[name] = value;
  const target = document.querySelector('#maintenance-rows');
  if (target && snapshot) target.innerHTML = issuesTable(snapshot);
}
