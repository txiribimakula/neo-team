// Maintenance: the team's open Functional Issues, read from Azure DevOps on demand.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const categories = { proposed: 'Sin empezar', inprogress: 'Activo' };
const day = value => value ? new Date(value).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
let filters = { text: '', category: 'all' };

export function maintenanceView(snapshot, state) {
  const config = state.config, demo = state.mode === 'demo';
  const team = snapshot ? `${snapshot.project} / ${snapshot.team}` : config?.team ? `${config.project} / ${config.team}` : demo ? 'Datos de ejemplo' : 'Conecta un equipo para consultar su mantenimiento.';
  const heading = `<header class="maintenance-heading"><div><p class="eyebrow">MANTENIMIENTO</p><h1>Functional issues</h1><p>${escape(team)}${snapshot ? ` · consultado el ${escape(new Date(snapshot.fetchedAt).toLocaleString('es'))}` : ''}</p></div>${snapshot ? '<button class="button" data-action="maintenance-refresh">Actualizar</button>' : ''}</header>`;
  if (!config?.team && !demo) return `<section class="maintenance-page">${heading}<div class="empty-panel"><h2>Sin equipo conectado</h2><p>Conecta Azure DevOps para listar los functional issues sin empezar o activos de tu equipo.</p><button class="button primary" data-action="connect">Conectar Azure DevOps</button></div></section>`;
  if (!snapshot) return `<section class="maintenance-page">${heading}<div class="empty-panel"><h2>Functional issues abiertos</h2><p>Consulta en Azure DevOps los elementos «Functional Issue» sin empezar o activos de las áreas del equipo.</p><button class="button primary" data-action="maintenance-refresh">Consultar Azure DevOps</button></div></section>`;
  const issues = snapshot.issues, count = category => issues.filter(i => i.category === category).length;
  return `<section class="maintenance-page">${heading}
    <div class="maintenance-stats"><div><strong>${issues.length}</strong><span>abiertos</span></div><div><strong>${count('proposed')}</strong><span>sin empezar</span></div><div><strong>${count('inprogress')}</strong><span>activos</span></div><div><strong>${issues.filter(i => !i.assignedTo).length}</strong><span>sin responsable</span></div></div>
    ${snapshot.limited ? `<div class="notice warning">Se muestran los primeros ${issues.length}. Hay más elementos abiertos en Azure DevOps.</div>` : ''}
    <div class="maintenance-filters"><input type="search" data-maintenance-filter="text" aria-label="Buscar functional issues" placeholder="Buscar por título, responsable, área o etiqueta" value="${escape(filters.text)}"><select data-maintenance-filter="category" aria-label="Filtrar por estado"><option value="all">Todos los abiertos</option>${Object.entries(categories).map(([value, label]) => `<option value="${value}" ${filters.category === value ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
    <div id="maintenance-rows">${issuesTable(snapshot)}</div></section>`;
}

function issuesTable(snapshot) {
  if (!snapshot.issues.length) return `<div class="empty-result">No hay elementos «${escape(snapshot.type)}» sin empezar ni activos en las áreas del equipo.</div>`;
  const text = filters.text.trim().toLowerCase();
  const rows = snapshot.issues.filter(i => (filters.category === 'all' || i.category === filters.category) && (!text || `${i.id} ${i.title} ${i.assignedTo} ${i.state} ${i.areaPath} ${i.tags.join(' ')}`.toLowerCase().includes(text)));
  if (!rows.length) return '<div class="empty-result">Ningún elemento coincide con los filtros.</div>';
  const title = issue => snapshot.demo ? escape(issue.title)
    : `<a href="https://dev.azure.com/${encodeURIComponent(snapshot.organization)}/${encodeURIComponent(snapshot.project)}/_workitems/edit/${issue.id}" target="_blank" rel="noopener noreferrer">${escape(issue.title)}</a>`;
  return `<p class="local-note" role="status">${rows.length === snapshot.issues.length ? `${rows.length} elementos` : `${rows.length} de ${snapshot.issues.length} elementos`}</p><div class="table-wrap"><table class="maintenance-table"><thead><tr><th>ID</th><th>Título</th><th>Estado</th><th>Responsable</th><th>Prioridad</th><th>Área</th><th>Actualizado</th></tr></thead><tbody>${rows.map(i => `<tr><td>#${i.id}</td><td><span class="table-title">${title(i)}</span>${i.tags.length ? `<span class="task-tags">${i.tags.slice(0, 3).map(t => `<span class="tag">${escape(t)}</span>`).join('')}</span>` : ''}</td><td><span class="pill maintenance-${escape(i.category)}">${escape(categories[i.category] || i.category)}</span> <small class="text-muted">${escape(i.state)}</small></td><td>${i.assignedTo ? escape(i.assignedTo) : '<span class="text-muted">Sin asignar</span>'}</td><td>${i.priority ?? '—'}</td><td class="text-muted">${escape(i.areaPath)}</td><td class="text-muted">${day(i.changedAt)}</td></tr>`).join('')}</tbody></table></div>`;
}

export function filterMaintenance(snapshot, name, value) {
  filters[name] = value;
  const target = document.querySelector('#maintenance-rows');
  if (target && snapshot) target.innerHTML = issuesTable(snapshot);
}
