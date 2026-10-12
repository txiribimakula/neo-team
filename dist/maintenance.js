// Maintenance: the open items of a type (Functional Issue by default), read from
// Azure DevOps with the closed states the person chose for the project. Each
// state belongs to a group (sin empezar, en curso, pendiente de verificación,
// cerrado) whose color is the same in the summary, the list and the people view.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const categoryLabels = { proposed: 'Sin empezar', inprogress: 'En curso', resolved: 'Resuelto', completed: 'Completado', removed: 'Retirado' };
const groupLabels = { new: 'Sin empezar', active: 'En curso', verify: 'Verificación', closed: 'Cerrado' };
const GROUPS = Object.keys(groupLabels);
const day = value => value ? new Date(value).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es').trim();
const EMPTY = '__empty__', SELECT_LIMIT = 40;
const DATE_RANGES = [['last:7', 'Últimos 7 días'], ['last:30', 'Últimos 30 días'], ['last:90', 'Últimos 90 días'], ['older:30', 'Hace más de 30 días'], ['older:90', 'Hace más de 90 días']];
// Columns the list always shows; any other filtered field is added as a column.
const BASE_VALUES = { 'System.State': i => i.state, 'System.AssignedTo': i => i.assignedTo, 'System.AreaPath': i => i.areaPath, 'System.IterationPath': i => i.iterationPath, 'Microsoft.VSTS.Common.Priority': i => i.priority ?? '', 'System.ChangedDate': i => i.changedAt ?? '', 'System.CreatedDate': i => i.createdAt ?? '', 'System.Tags': i => i.tags.join('; ') };
const SHOWN = new Set(['System.State', 'System.AssignedTo', 'System.AreaPath', 'Microsoft.VSTS.Common.Priority', 'System.ChangedDate', 'System.Tags']);
const valueOf = (issue, ref) => issue.values?.[ref] ?? BASE_VALUES[ref]?.(issue) ?? '';

// The filters are remembered per project in this browser.
const defaults = () => ({ text: '', states: [], conditions: [], view: 'list', includeClosed: false });
let filters = defaults(), scopeKey = null, last = { snapshot: null, settings: null };
const storageKey = key => `neo-team.maintenance.${key}`;
function restore(saved) {
  const base = defaults();
  if (!saved || typeof saved !== 'object') return base;
  return {
    text: typeof saved.text === 'string' ? saved.text.slice(0, 200) : '',
    states: Array.isArray(saved.states) ? saved.states.filter(s => typeof s === 'string').slice(0, 100) : [],
    conditions: Array.isArray(saved.conditions) ? saved.conditions.filter(c => typeof c?.field === 'string' && typeof c.value === 'string').slice(0, 20).map(c => ({ field: c.field, value: c.value.slice(0, 200) })) : [],
    view: saved.view === 'people' ? 'people' : 'list', includeClosed: saved.includeClosed === true,
  };
}
function save() {
  if (!scopeKey) return;
  try { globalThis.localStorage?.setItem(storageKey(scopeKey), JSON.stringify(filters)); } catch {}
}
function useScope(key) {
  if (key === scopeKey) return;
  scopeKey = key;
  try { filters = restore(JSON.parse(globalThis.localStorage?.getItem(storageKey(key)) || 'null')); } catch { filters = defaults(); }
}
export function resetMaintenanceFilters() { filters = { ...defaults(), view: filters.view, includeClosed: filters.includeClosed }; save(); }
export const maintenanceIncludeClosed = () => filters.includeClosed;
export function setMaintenanceIncludeClosed(value) { filters.includeClosed = value === true; save(); }
export function setMaintenanceView(view) { filters.view = view === 'people' ? 'people' : 'list'; save(); }
export function addMaintenanceCondition(field) { filters.conditions.push({ field, value: '' }); save(); return filters.conditions.length - 1; }
export function removeMaintenanceCondition(index) { filters.conditions.splice(index, 1); save(); }
export function toggleMaintenanceState(snapshot, name) {
  filters.states = filters.states.includes(name) ? filters.states.filter(s => s !== name) : [...filters.states, name];
  save(); refresh(snapshot);
}
export function filterMaintenance(snapshot, name, value, index) {
  if (name === 'condition' && filters.conditions[index]) filters.conditions[index].value = value;
  else if (name === 'text') filters.text = value;
  save(); refresh(snapshot);
}
function refresh(snapshot) {
  const target = document.querySelector('#maintenance-body');
  if (target && snapshot) target.innerHTML = body(snapshot);
}

// Each state with its group and a tone, so states of the same group are told apart.
const statusCache = new WeakMap();
function statusOf(snapshot) {
  if (statusCache.has(snapshot)) return statusCache.get(snapshot);
  const states = snapshot.states ?? last.settings?.states ?? [];
  const closed = new Set(snapshot.closedStates ?? last.settings?.closedStates ?? []), verify = new Set(snapshot.verifyStates ?? last.settings?.verifyStates ?? []);
  const names = [...new Set([...states.map(s => s.name), ...snapshot.issues.map(i => i.state)])];
  const category = name => states.find(s => s.name === name)?.category ?? snapshot.issues.find(i => i.state === name)?.category ?? '';
  const group = name => closed.has(name) ? 'closed' : verify.has(name) ? 'verify' : ['inprogress', 'resolved'].includes(category(name)) ? 'active' : 'new';
  const tones = {}, result = new Map();
  for (const name of [...names].sort((a, b) => GROUPS.indexOf(group(a)) - GROUPS.indexOf(group(b)))) {
    const g = group(name);
    tones[g] = (tones[g] ?? -1) + 1;
    result.set(name, { group: g, tone: tones[g] % 3, order: result.size });
  }
  statusCache.set(snapshot, result);
  return result;
}
const statusClass = (snapshot, name) => { const s = statusOf(snapshot).get(name); return s ? `st st-${s.group} st-t${s.tone}` : 'st st-new st-t0'; };
const statePill = (snapshot, issue) => `<span class="pill ${statusClass(snapshot, issue.state)}" title="${escape(groupLabels[statusOf(snapshot).get(issue.state)?.group] || categoryLabels[issue.category] || '')}">${escape(issue.state)}</span>`;

// How each field is filtered: dates by range, few values with a list, the rest by text.
const controlCache = new WeakMap();
function controlsOf(snapshot) {
  if (controlCache.has(snapshot)) return controlCache.get(snapshot);
  const result = new Map();
  for (const field of snapshot.fields ?? []) {
    if (field.type === 'dateTime') { result.set(field.ref, { field, kind: 'date' }); continue; }
    const values = new Set();
    let empty = false;
    for (const issue of snapshot.issues) {
      const value = valueOf(issue, field.ref);
      if (value === '') empty = true;
      else if (field.ref === 'System.Tags') String(value).split(';').map(t => t.trim()).filter(Boolean).forEach(t => values.add(t));
      else values.add(String(value));
    }
    const options = [...values].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    result.set(field.ref, options.length <= SELECT_LIMIT ? { field, kind: 'select', options, empty } : { field, kind: 'text' });
  }
  controlCache.set(snapshot, result);
  return result;
}
function matches(issue, condition, control) {
  const value = valueOf(issue, condition.field);
  if (condition.value === EMPTY) return value === '';
  if (control.kind === 'date') {
    if (!value) return false;
    const [mode, days] = condition.value.split(':'), age = (Date.now() - new Date(value)) / 86400000;
    return mode === 'last' ? age <= Number(days) : age > Number(days);
  }
  if (control.kind === 'text') return normalize(value).includes(normalize(condition.value));
  if (condition.field === 'System.Tags') return String(value).split(';').some(t => t.trim() === condition.value);
  return String(value) === condition.value;
}
const shownConditions = snapshot => filters.conditions.map((condition, index) => ({ condition, index, control: controlsOf(snapshot).get(condition.field) })).filter(c => c.control);
function visible(snapshot) {
  const text = normalize(filters.text), active = shownConditions(snapshot).filter(c => c.condition.value);
  return snapshot.issues.filter(i => (!text || normalize(`${i.id} ${i.title} ${i.assignedTo} ${i.state} ${i.areaPath} ${i.tags.join(' ')} ${Object.values(i.values ?? {}).join(' ')}`).includes(text)) && active.every(c => matches(i, c.condition, c.control)));
}

export function maintenanceView(snapshot, state, setup) {
  const settings = state.maintenanceSettings, demo = state.mode === 'demo';
  useScope(demo ? 'demo' : `${state.config?.organization ?? ''}/${state.config?.project ?? ''}`.toLowerCase());
  last = { snapshot, settings };
  const project = demo ? 'Datos de ejemplo' : state.config?.project;
  const details = [escape(project || 'Conecta un proyecto para consultar su mantenimiento.')];
  if (settings && !setup) details.push(`cerrados: ${escape(settings.closedStates.join(', ') || 'ninguno')} · verificación: ${escape(settings.verifyStates?.join(', ') || 'ninguno')} <button class="link-button" data-action="maintenance-edit-settings">Cambiar</button>`);
  if (snapshot && !setup) details.push(`consultado el ${escape(new Date(snapshot.fetchedAt).toLocaleString('es'))}`);
  const title = `${escape(settings?.type || 'Functional Issue')}${snapshot?.includeClosed ? '' : ' no cerrados'}`;
  const heading = `<header class="maintenance-heading"><div><p class="eyebrow">MANTENIMIENTO</p><h1>${title}</h1><p>${details.join(' · ')}</p></div>${snapshot && settings && !setup ? '<button class="button" data-action="maintenance-refresh">Actualizar</button>' : ''}</header>`;
  const page = content => `<section class="maintenance-page">${heading}${content}</section>`;
  if (!state.config?.project && !demo) return page('<div class="empty-panel"><h2>Sin proyecto conectado</h2><p>Conecta Azure DevOps para consultar el mantenimiento del proyecto.</p><button class="button primary" data-action="connect">Conectar Azure DevOps</button></div>');
  if (!settings || setup) return page(setupView(settings, setup));
  if (!snapshot) return page(`<div class="empty-panel"><h2>Sin consultar</h2><p>Se traerán todos los «${escape(settings.type)}» del proyecto cuyo estado no sea ${escape(settings.closedStates.join(', ') || 'ninguno')}.</p><button class="button primary" data-action="maintenance-refresh">Consultar Azure DevOps</button></div>`);
  return page(`${snapshot.limited ? `<div class="notice warning">Se muestran los primeros ${snapshot.issues.length}. Hay más elementos en Azure DevOps.</div>` : ''}
    ${filterBar(snapshot)}<div id="maintenance-body">${body(snapshot)}</div>`);
}

function filterBar(snapshot) {
  const used = new Set(filters.conditions.map(c => c.field));
  const available = (snapshot.fields ?? []).filter(f => !used.has(f.ref)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const chips = shownConditions(snapshot).map(({ condition, index, control }) => {
    const name = escape(control.field.name), attrs = `data-maintenance-filter="condition" data-index="${index}" aria-label="${name}"`;
    const option = (value, label) => `<option value="${escape(value)}" ${condition.value === value ? 'selected' : ''}>${escape(label)}</option>`;
    const input = control.kind === 'text' ? `<input type="search" ${attrs} value="${escape(condition.value)}" placeholder="Contiene…">`
      : `<select ${attrs}>${option('', 'Todos')}${control.kind === 'date' ? DATE_RANGES.map(([value, label]) => option(value, label)).join('') : control.options.map(value => option(value, value)).join('')}${control.kind === 'date' || control.empty ? option(EMPTY, '(vacío)') : ''}</select>`;
    return `<span class="field-chip${condition.value ? ' active' : ''}"><label><span>${name}</span>${input}</label><button type="button" class="chip-remove" data-action="maintenance-remove-condition" data-index="${index}" aria-label="Quitar ${name}">×</button></span>`;
  }).join('');
  const view = name => filters.view === name ? 'true' : 'false';
  return `<div class="maintenance-filters"><input type="search" data-maintenance-filter="text" aria-label="Buscar elementos" placeholder="Buscar" value="${escape(filters.text)}">${chips}
    ${available.length ? `<select class="field-add" data-maintenance-add aria-label="Filtrar por campo"><option value="">+ Campo</option>${available.map(f => `<option value="${escape(f.ref)}">${escape(f.name)}</option>`).join('')}</select>` : ''}
    <span class="maintenance-tools"><label class="check-chip" title="Incluir los elementos cerrados"><input type="checkbox" data-maintenance-include-closed ${snapshot.includeClosed ? 'checked' : ''}>Cerrados</label>
    <span class="segmented" role="group" aria-label="Vista"><button type="button" data-action="maintenance-view" data-view="list" aria-pressed="${view('list')}">Lista</button><button type="button" data-action="maintenance-view" data-view="people" aria-pressed="${view('people')}">Personas</button></span>
    <button class="button small" data-action="maintenance-clear-filters">Limpiar filtros</button></span></div>`;
}

function body(snapshot) {
  if (!snapshot.issues.length) return `<div class="empty-result">No hay elementos «${escape(snapshot.type)}»${snapshot.includeClosed ? '' : ' no cerrados'} en el proyecto.</div>`;
  const base = visible(snapshot), rows = filters.states.length ? base.filter(i => filters.states.includes(i.state)) : base;
  const content = !rows.length ? '<div class="empty-result" role="status"><p>Ningún elemento coincide con los filtros.</p><button class="button" data-action="maintenance-clear-filters">Mostrar todos los elementos</button></div>'
    : `<p class="local-note" role="status">${rows.length === snapshot.issues.length ? `${rows.length} elementos` : `${rows.length} de ${snapshot.issues.length} elementos`}</p>${filters.view === 'people' ? peopleView(snapshot, rows) : issuesTable(snapshot, rows)}`;
  return statusSummary(snapshot, base) + content;
}

// The distribution of the visible items by state; each state filters the list.
function statusBar(snapshot, rows, small = false) {
  const counts = new Map();
  for (const issue of rows) counts.set(issue.state, (counts.get(issue.state) ?? 0) + 1);
  const names = [...statusOf(snapshot).keys()].filter(name => counts.get(name));
  const label = names.map(name => `${name}: ${counts.get(name)}`).join(', ');
  return `<div class="status-bar${small ? ' small' : ''}${!small && filters.states.length ? ' filtered' : ''}" role="img" aria-label="${escape(label || 'Sin elementos')}">${names.map(name => `<span class="${statusClass(snapshot, name)}${filters.states.includes(name) ? ' on' : ''}" style="flex-grow:${counts.get(name)}" title="${escape(name)}: ${counts.get(name)}"></span>`).join('')}</div>`;
}
function statusSummary(snapshot, rows) {
  const status = statusOf(snapshot), counts = new Map();
  for (const issue of rows) counts.set(issue.state, (counts.get(issue.state) ?? 0) + 1);
  const groups = GROUPS.map(group => {
    const names = [...status].filter(([name, s]) => s.group === group && (counts.get(name) || filters.states.includes(name))).map(([name]) => name);
    if (!names.length) return '';
    const total = names.reduce((sum, name) => sum + (counts.get(name) ?? 0), 0);
    return `<div class="status-group st-${group}"><span class="status-group-name">${groupLabels[group]}<b>${total}</b></span>${names.map(name => `<button type="button" class="status-key ${statusClass(snapshot, name)}" data-action="maintenance-state" data-state="${escape(name)}" aria-pressed="${filters.states.includes(name)}"><i></i>${escape(name)}<b>${counts.get(name) ?? 0}</b></button>`).join('')}</div>`;
  }).join('');
  return `<div class="maintenance-status">${statusBar(snapshot, rows)}<div class="status-legend">${groups}</div></div>`;
}

const issueLink = (snapshot, issue) => snapshot.demo ? escape(issue.title)
  : `<a href="https://dev.azure.com/${encodeURIComponent(snapshot.organization)}/${encodeURIComponent(snapshot.project)}/_workitems/edit/${issue.id}" target="_blank" rel="noopener noreferrer">${escape(issue.title)}</a>`;
function cell(issue, field) {
  const value = valueOf(issue, field.ref);
  if (value === '') return '<span class="text-muted">—</span>';
  return field.type === 'dateTime' ? day(value) : escape(value);
}

function issuesTable(snapshot, rows) {
  const extra = shownConditions(snapshot).map(c => c.control.field).filter(f => !SHOWN.has(f.ref));
  return `<div class="table-wrap"><table class="maintenance-table"><thead><tr><th>ID</th><th>Título</th><th>Estado</th><th>Responsable</th><th>Prioridad</th><th>Área</th>${extra.map(f => `<th>${escape(f.name)}</th>`).join('')}<th>Actualizado</th></tr></thead><tbody>${rows.map(i => `<tr class="${statusClass(snapshot, i.state)}"><td>#${i.id}</td><td><span class="table-title">${issueLink(snapshot, i)}</span>${i.tags.length ? `<span class="task-tags">${i.tags.slice(0, 3).map(t => `<span class="tag">${escape(t)}</span>`).join('')}</span>` : ''}</td><td>${statePill(snapshot, i)}</td><td>${i.assignedTo ? escape(i.assignedTo) : '<span class="text-muted">Sin asignar</span>'}</td><td>${i.priority ?? '—'}</td><td class="text-muted">${escape(i.areaPath)}</td>${extra.map(f => `<td>${cell(i, f)}</td>`).join('')}<td class="text-muted">${day(i.changedAt)}</td></tr>`).join('')}</tbody></table></div>`;
}

// What each person has assigned, with the people with more items first and the
// unassigned ones at the end.
function peopleView(snapshot, rows) {
  const status = statusOf(snapshot), groups = new Map();
  for (const issue of rows) groups.set(issue.assignedTo, [...(groups.get(issue.assignedTo) ?? []), issue]);
  const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const tint = name => [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4;
  return `<div class="maintenance-people">${[...groups].sort(([a, x], [b, y]) => (!a) - (!b) || y.length - x.length || a.localeCompare(b, 'es')).map(([name, items]) => {
    const sorted = [...items].sort((a, b) => (status.get(a.state)?.order ?? 0) - (status.get(b.state)?.order ?? 0));
    return `<section class="person-card"><header><span class="avatar${name ? ` c${tint(name)}` : ' none'}" aria-hidden="true">${name ? escape(initials(name)) : '?'}</span><strong>${name ? escape(name) : 'Sin asignar'}</strong><span class="count">${items.length}</span></header>${statusBar(snapshot, items, true)}
      <ul>${sorted.map(i => `<li class="${statusClass(snapshot, i.state)}">${statePill(snapshot, i)}<span><span class="text-muted">#${i.id}</span> ${issueLink(snapshot, i)}</span></li>`).join('')}</ul></section>`;
  }).join('')}</div>`;
}

// The person decides, for each possible state of the type, whether it is open,
// waiting to be verified or closed.
function setupView(settings, setup) {
  const type = setup?.type ?? settings?.type ?? 'Functional Issue', states = setup?.states;
  const cancel = settings ? '<button type="button" class="button" data-action="maintenance-cancel-settings">Cancelar</button>' : '';
  const typeField = `<div class="maintenance-setup-type"><label class="form-field">Tipo de elemento<input id="maintenance-type" value="${escape(type)}" maxlength="128" autocomplete="off"></label><button type="button" class="button ${states ? '' : 'primary'}" data-action="maintenance-load-states">${states ? 'Volver a cargar estados' : 'Cargar estados'}</button></div>`;
  if (!states) return `<div class="maintenance-setup"><h2>Estados de «${escape(type)}»</h2>${typeField}${cancel ? `<div class="actions">${cancel}</div>` : ''}</div>`;
  const same = settings?.type === type;
  const closed = new Set(same ? settings.closedStates : states.filter(s => ['completed', 'removed'].includes(s.category)).map(s => s.name));
  const verify = new Set(same ? settings.verifyStates ?? [] : states.filter(s => s.category === 'resolved').map(s => s.name));
  const roles = [['open', 'Abierto'], ['verify', 'Verificación'], ['closed', 'Cerrado']];
  return `<div class="maintenance-setup"><h2>Estados de «${escape(type)}»</h2>${typeField}
    <p id="maintenance-type-hint" class="notice" role="status" hidden>Has cambiado el tipo de elemento. Vuelve a cargar sus estados antes de guardar.</p><form id="maintenance-settings-form" data-type="${escape(type)}"><div class="maintenance-states">${states.map((s, index) => {
      const role = closed.has(s.name) ? 'closed' : verify.has(s.name) ? 'verify' : 'open';
      return `<fieldset class="state-role"><legend><strong>${escape(s.name)}</strong><small>${escape(categoryLabels[s.category] || 'Sin categoría')}</small></legend><span class="segmented roles">${roles.map(([value, label]) => `<label class="role-${value}"><input type="radio" name="role-${index}" value="${value}" data-state="${escape(s.name)}" ${role === value ? 'checked' : ''}>${label}</label>`).join('')}</span></fieldset>`;
    }).join('')}</div><div class="actions">${cancel}<button class="button primary" type="submit">Guardar y consultar</button></div></form></div>`;
}
