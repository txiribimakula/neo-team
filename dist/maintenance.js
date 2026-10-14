// Mantenimiento: the tickets of the Jira filter, with their agents on the board, and
// the open items of a type of Azure DevOps (Functional Issue by default), in one
// section. The filters choose what is seen in every view and what updating and the
// agents act on. Each state belongs to a group (sin empezar, en curso, verificación,
// cerrado) whose color is the same in the summary, the list and the people view.
import { ORIGINS, groupLabels, GROUPS, EMPTY, DATE_RANGES, COMMON_FIELDS, JIRA_FIELDS, azureItem, jiraItems, defaultFilters, filtersFrom, narrowed, filterItems, valueOf, valuesOf } from './maintenance-items.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const categoryLabels = { proposed: 'Sin empezar', inprogress: 'En curso', resolved: 'Resuelto', completed: 'Completado', removed: 'Retirado' };
const day = value => value ? new Date(value).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const SELECT_LIMIT = 40;
const VIEWS = [['board', 'Tablero'], ['list', 'Lista'], ['people', 'Personas']];
// Columns the list always shows; any other filtered field is added as a column.
const SHOWN = new Set(['System.State', 'System.AssignedTo', 'System.AreaPath', 'Microsoft.VSTS.Common.Priority', 'System.ChangedDate', 'System.Tags', 'neo.stage']);

// The filters are remembered in this browser, apart for the example; the view is not:
// Mantenimiento opens on the board.
let filters = defaultFilters(), scopeKey = null, view = 'board';
const storageKey = key => `neo-team.maintenance.${key}`;
function save() {
  if (!scopeKey) return;
  try { globalThis.localStorage?.setItem(storageKey(scopeKey), JSON.stringify(filters)); } catch {}
}
// Before Jira joined, the filters were kept per project of Azure DevOps.
function useScope(state) {
  const key = state.mode === 'demo' ? 'demo' : 'real';
  if (key === scopeKey) return;
  scopeKey = key;
  const legacy = state.mode === 'demo' ? null : `${state.config?.organization ?? ''}/${state.config?.project ?? ''}`.toLowerCase();
  try {
    const storage = globalThis.localStorage;
    filters = filtersFrom(JSON.parse(storage?.getItem(storageKey(key)) ?? (legacy ? storage?.getItem(storageKey(legacy)) : null) ?? 'null'));
  } catch { filters = defaultFilters(); }
}
export const maintenanceViewName = () => view;
export function setMaintenanceView(next) { view = VIEWS.some(([id]) => id === next) ? next : 'board'; }
export function resetMaintenanceFilters() { filters = { ...defaultFilters(), includeClosed: filters.includeClosed }; save(); }
export const maintenanceIncludeClosed = () => filters.includeClosed;
export function setMaintenanceIncludeClosed(value) { filters.includeClosed = value === true; save(); }
export function setMaintenanceOrigin(origin) { filters.origin = ORIGINS[origin] ? origin : ''; save(); }
export function addMaintenanceCondition(field) { filters.conditions.push({ field, value: '' }); save(); return filters.conditions.length - 1; }
export function removeMaintenanceCondition(index) { filters.conditions.splice(index, 1); save(); }
export function toggleMaintenanceState(name) { filters.states = filters.states.includes(name) ? filters.states.filter(s => s !== name) : [...filters.states, name]; save(); }
export function filterMaintenance(name, value, index) {
  if (name === 'condition' && filters.conditions[index]) filters.conditions[index].value = value;
  else if (name === 'text') filters.text = value;
  save();
}

// What there is to show: the Jira board (its tickets and the filter as last read) and
// the Azure DevOps query, as far as each one is there. The board shows only Jira.
export function maintenanceItems({ azure = null, jira = null } = {}, { board = false } = {}) {
  const fromJira = jira?.tickets ? jiraItems(jira.tickets, jira.catalog ?? []) : [];
  return board ? fromJira : [...fromJira, ...(azure?.issues ?? []).map(issue => azureItem(issue, azure))];
}
function fieldsOf({ azure = null, jira = null }, board) {
  const common = new Set(COMMON_FIELDS.map(f => f.ref));
  return [...COMMON_FIELDS, ...(!board && azure ? (azure.fields ?? []).filter(f => !common.has(f.ref)) : []), ...(jira?.tickets ? JIRA_FIELDS : [])];
}
// How each field is filtered: dates by range, few values with a list, the rest by text.
function controlsOf(items, fields) {
  const result = new Map();
  for (const field of fields) {
    if (field.type === 'dateTime') { result.set(field.ref, { field, kind: 'date' }); continue; }
    const values = new Set();
    let empty = false;
    for (const item of items) {
      const value = valueOf(item, field.ref), many = valuesOf(item, field.ref);
      if (value === '') empty = true;
      else (many ?? [String(value)]).forEach(v => values.add(v));
    }
    if (!values.size && !empty) continue;
    const options = [...values].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    result.set(field.ref, options.length <= SELECT_LIMIT ? { field, kind: 'select', options, empty } : { field, kind: 'text' });
  }
  return result;
}
// Everything a view needs, computed once per drawing: the items, how each field is
// filtered and what the filters leave. The board ignores the origin: it is Jira's.
function sceneOf(sources, state, board) {
  useScope(state);
  const items = maintenanceItems(sources, { board }), controls = controlsOf(items, fieldsOf(sources, board));
  const conditions = filters.conditions.map((condition, index) => ({ condition, index, control: controls.get(condition.field) })).filter(c => c.control);
  const effective = { ...filters, ...(board ? { origin: '' } : {}), conditions: conditions.map(({ condition, control }) => ({ ...condition, kind: control.kind })) };
  return { sources, state, board, items, controls, conditions, effective, ...filterItems(items, effective) };
}
// What updating and Empezar act on: the filters as the server applies them, and the
// tickets of the board the person sees (null when nothing is filtered: all of them).
export function maintenanceScope(sources, state) {
  const scene = sceneOf(sources, state, true);
  return { filters: scene.effective, keys: narrowed(scene.effective) ? scene.rows.map(item => item.key) : null, rows: scene.rows };
}
// The tickets of the board that the filters leave, for the board to draw.
export const boardKeys = (sources, state) => new Set(sceneOf(sources, state, true).rows.map(item => item.key));

// Each state with its group and a tone, so states of the same group are told apart.
function statusOf(scene) {
  if (scene.status) return scene.status;
  const order = [...(scene.sources.azure?.states ?? []).map(s => s.name), ...scene.items.map(i => i.state)];
  const groups = new Map();
  for (const item of scene.items) if (item.state && !groups.has(item.state)) groups.set(item.state, item.group);
  const azure = scene.sources.azure;
  for (const s of azure?.states ?? []) if (!groups.has(s.name)) groups.set(s.name, azureItem({ id: 0, title: '', state: s.name, category: s.category }, azure).group);
  const names = [...new Set(order)].filter(name => groups.has(name));
  const tones = {}, result = new Map();
  for (const name of names.sort((a, b) => GROUPS.indexOf(groups.get(a)) - GROUPS.indexOf(groups.get(b)))) {
    const g = groups.get(name);
    tones[g] = (tones[g] ?? -1) + 1;
    result.set(name, { group: g, tone: tones[g] % 3, order: result.size });
  }
  return (scene.status = result);
}
const statusClass = (scene, name) => { const s = statusOf(scene).get(name); return s ? `st st-${s.group} st-t${s.tone}` : 'st st-new st-t0'; };
const statePill = (scene, item) => item.state ? `<span class="pill ${statusClass(scene, item.state)}" title="${escape(groupLabels[item.group] ?? '')}">${escape(item.state)}</span>` : '<span class="text-muted">—</span>';

// The head of every view: the views, the origins, updating and what the caller adds
// (the board's Empezar and settings); below, the filters and the summary by state.
const SYNC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 21v-5h5"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5"/></svg>';
// What updating brings, as the filters stand: on the board, Jira; in the list and the
// people view, each origin that is shown.
export function refreshTargets(state, board = view === 'board') {
  const azure = (!!state.config?.project || state.mode === 'demo') && !!state.maintenanceSettings;
  return { jira: !!state.jira && (board || filters.origin !== 'azure'), azure: !board && azure && filters.origin !== 'jira' };
}
function refreshButton(scene) {
  const targets = refreshTargets(scene.state, scene.board);
  if (!targets.jira && !targets.azure) return '';
  const jira = targets.jira && `Jira: lee el filtro y descarga ${narrowed(scene.effective) ? 'solo los tickets filtrados' : 'los nuevos y los que han cambiado'}; quita los terminados`;
  const azure = targets.azure && `Azure DevOps: consulta ${scene.state.maintenanceSettings.type}`;
  return `<button class="button jira-square" data-action="maintenance-refresh" title="${escape(`Actualizar · ${[jira, azure].filter(Boolean).join(' · ')}`)}" aria-label="Actualizar">${SYNC}</button>`;
}
export function maintenanceHead(sources, state, { board = false, tools = '' } = {}) {
  const scene = sceneOf(sources, state, board);
  const both = !!state.jira && (!!state.config?.project || state.mode === 'demo');
  const pressed = on => on ? 'true' : 'false';
  const views = `<span class="segmented" role="group" aria-label="Vista">${VIEWS.map(([id, label]) => `<button type="button" data-action="maintenance-view" data-view="${id}" aria-pressed="${pressed(view === id)}">${label}</button>`).join('')}</span>`;
  const origins = !board && both ? `<span class="segmented" role="group" aria-label="Origen">${[['', 'Todo'], ...Object.entries(ORIGINS)].map(([id, label]) => `<button type="button" data-action="maintenance-origin" data-origin="${id}" aria-pressed="${pressed(filters.origin === id)}">${label}</button>`).join('')}</span>` : '';
  const top = `<div class="maintenance-top"><h1>Mantenimiento</h1>${views}${origins}<span class="maintenance-actions">${refreshButton(scene)}${tools}</span></div>`;
  return `${top}${filterBar(scene)}${scene.items.length ? statusSummary(scene) : ''}`;
}

function filterBar(scene) {
  const used = new Set(filters.conditions.map(c => c.field));
  const available = [...scene.controls.values()].map(c => c.field).filter(f => !used.has(f.ref)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  const chips = scene.conditions.map(({ condition, index, control }) => {
    const name = escape(control.field.name), attrs = `data-maintenance-filter="condition" data-index="${index}" data-focus="maintenance-condition-${index}" aria-label="${name}"`;
    const option = (value, label) => `<option value="${escape(value)}" ${condition.value === value ? 'selected' : ''}>${escape(label)}</option>`;
    const input = control.kind === 'text' ? `<input type="search" ${attrs} value="${escape(condition.value)}" placeholder="Contiene…" autocomplete="off">`
      : `<select ${attrs}>${option('', 'Todos')}${control.kind === 'date' ? DATE_RANGES.map(([value, label]) => option(value, label)).join('') : control.options.map(value => option(value, value)).join('')}${control.kind === 'date' || control.empty ? option(EMPTY, '(vacío)') : ''}</select>`;
    return `<span class="field-chip${condition.value ? ' active' : ''}"><label><span>${name}</span>${input}</label><button type="button" class="chip-remove" data-action="maintenance-remove-condition" data-index="${index}" aria-label="Quitar ${name}">×</button></span>`;
  }).join('');
  const shown = scene.rows.length === scene.items.length ? `${scene.rows.length}` : `${scene.rows.length} de ${scene.items.length}`;
  const cleared = !narrowed(scene.effective) ? ' disabled' : '';
  return `<div class="maintenance-filters"><input type="search" data-maintenance-filter="text" data-focus="maintenance-text" aria-label="Buscar" placeholder="Buscar" value="${escape(filters.text)}" autocomplete="off" spellcheck="false">${chips}
    ${available.length ? `<select class="field-add" data-maintenance-add aria-label="Filtrar por campo"><option value="">+ Campo</option>${available.map(f => `<option value="${escape(f.ref)}">${escape(f.name)}</option>`).join('')}</select>` : ''}
    <span class="maintenance-tools"><span class="maintenance-count" role="status" title="Elementos que dejan los filtros">${shown}</span><label class="check-chip" title="Incluir los elementos cerrados"><input type="checkbox" data-maintenance-include-closed ${filters.includeClosed ? 'checked' : ''}>Cerrados</label>
    <button class="button small" data-action="maintenance-clear-filters"${cleared}>Limpiar filtros</button></span></div>`;
}

// The distribution of the items by state; each state filters the rest.
function statusBar(scene, rows, small = false) {
  const counts = new Map();
  for (const item of rows) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  const names = [...statusOf(scene).keys()].filter(name => counts.get(name));
  const label = names.map(name => `${name}: ${counts.get(name)}`).join(', ');
  return `<div class="status-bar${small ? ' small' : ''}${!small && filters.states.length ? ' filtered' : ''}" role="img" aria-label="${escape(label || 'Sin elementos')}">${names.map(name => `<span class="${statusClass(scene, name)}${filters.states.includes(name) ? ' on' : ''}" style="flex-grow:${counts.get(name)}" title="${escape(name)}: ${counts.get(name)}"></span>`).join('')}</div>`;
}
function statusSummary(scene) {
  const status = statusOf(scene), counts = new Map();
  for (const item of scene.base) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  const groups = GROUPS.map(group => {
    const names = [...status].filter(([name, s]) => s.group === group && (counts.get(name) || filters.states.includes(name))).map(([name]) => name);
    if (!names.length) return '';
    const total = names.reduce((sum, name) => sum + (counts.get(name) ?? 0), 0);
    return `<div class="status-group st-${group}"><span class="status-group-name">${groupLabels[group]}<b>${total}</b></span>${names.map(name => `<button type="button" class="status-key ${statusClass(scene, name)}" data-action="maintenance-state" data-state="${escape(name)}" aria-pressed="${filters.states.includes(name)}"><i></i>${escape(name)}<b>${counts.get(name) ?? 0}</b></button>`).join('')}</div>`;
  }).join('');
  return `<div class="maintenance-status${scene.board ? ' compact' : ''}">${statusBar(scene, scene.base)}<div class="status-legend">${groups}</div></div>`;
}

// The list and the people view of both origins. Azure DevOps is read when one of them
// opens; Jira, from the board.
export function maintenanceView(sources, state, { setup = null, tools = '' } = {}) {
  const scene = sceneOf(sources, state, false), demo = state.mode === 'demo';
  const azureOn = !!state.config?.project || demo, settings = state.maintenanceSettings;
  const page = content => `<section class="maintenance-page">${maintenanceHead(sources, state, { tools })}${notes(sources, state)}${content}</section>`;
  if (azureOn && setup) return page(setupView(settings, setup));
  if (!state.jira && !azureOn) return page('<div class="empty-panel"><h2>Sin Jira ni Azure DevOps</h2><div class="actions"><button class="button primary" data-action="maintenance-view" data-view="board">Conectar Jira</button><button class="button" data-action="connect">Conectar Azure DevOps</button></div></div>');
  return page(`<div id="maintenance-body">${body(scene)}</div>`);
}
// Where each origin stands, in one line: what was read and when, and what is missing.
function notes(sources, state) {
  const demo = state.mode === 'demo', settings = state.maintenanceSettings, azure = sources.azure, jira = sources.jira;
  const parts = [];
  if (state.jira && filters.origin !== 'azure') parts.push(`Jira · ${jira?.catalogAt ? `leído el ${escape(new Date(jira.catalogAt).toLocaleString('es'))}` : 'sin leer el filtro'}${jira?.catalogLimited ? ' · solo los primeros 1000' : ''}`);
  if ((state.config?.project || demo) && filters.origin !== 'jira') {
    const where = escape(demo ? 'Datos de ejemplo' : state.config.project);
    parts.push(!settings ? `Azure DevOps · ${where} · <button class="link-button" data-action="maintenance-edit-settings">Elegir los estados</button>`
      : `Azure DevOps · ${where} · ${escape(settings.type)} · cerrados: ${escape(settings.closedStates.join(', ') || 'ninguno')} · verificación: ${escape(settings.verifyStates?.join(', ') || 'ninguno')} <button class="link-button" data-action="maintenance-edit-settings">Cambiar</button>${azure ? ` · consultado el ${escape(new Date(azure.fetchedAt).toLocaleString('es'))}` : ''}${azure?.limited ? ` · solo los primeros ${azure.issues.length}` : ''}`);
  }
  return parts.length ? `<p class="maintenance-notes">${parts.join('<br>')}</p>` : '';
}

function body(scene) {
  if (!scene.items.length) return '<div class="empty-result">Sin elementos. Actualiza para traerlos.</div>';
  if (!scene.rows.length) return '<div class="empty-result" role="status"><p>Ningún elemento coincide con los filtros.</p><button class="button" data-action="maintenance-clear-filters">Mostrar todos los elementos</button></div>';
  return view === 'people' ? peopleView(scene, scene.rows) : itemsTable(scene, scene.rows);
}

// A ticket on the board opens its detail; the rest open in Jira or Azure DevOps.
function itemLink(item) {
  if (item.origin === 'jira' && item.ticket) return `<button type="button" class="link-button item-open" data-action="jira-open-ticket" data-key="${escape(item.key)}">${escape(item.title)}</button>`;
  return item.url ? `<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${escape(item.title)}</a>` : escape(item.title);
}
const label = item => item.origin === 'jira' && item.url ? `<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer" title="Abrir en Jira">${escape(item.label)}</a>` : escape(item.label);
function cell(item, field) {
  const value = valueOf(item, field.ref);
  if (value === '') return '<span class="text-muted">—</span>';
  return field.type === 'dateTime' ? day(value) : escape(value);
}
function itemsTable(scene, rows) {
  const extra = scene.conditions.map(c => c.control.field).filter(f => !SHOWN.has(f.ref));
  const jira = rows.some(i => i.origin === 'jira'), area = rows.some(i => i.areaPath);
  return `<div class="table-wrap"><table class="maintenance-table"><thead><tr><th>ID</th><th>Título</th><th>Estado</th>${jira ? '<th>Paso</th>' : ''}<th>Responsable</th><th>Prioridad</th>${area ? '<th>Área</th>' : ''}${extra.map(f => `<th>${escape(f.name)}</th>`).join('')}<th>Actualizado</th></tr></thead><tbody>${rows.map(i => `<tr class="${statusClass(scene, i.state)}${i.origin === 'jira' && !i.ticket ? ' not-downloaded' : ''}"><td>${label(i)}</td><td><span class="table-title">${itemLink(i)}</span>${i.tags.length ? `<span class="task-tags">${i.tags.slice(0, 3).map(t => `<span class="tag">${escape(t)}</span>`).join('')}</span>` : ''}</td><td>${statePill(scene, i)}</td>${jira ? `<td class="text-muted">${i.origin === 'jira' ? escape(valueOf(i, 'neo.stage')) : ''}</td>` : ''}<td>${i.assignedTo ? escape(i.assignedTo) : '<span class="text-muted">Sin asignar</span>'}</td><td>${escape(i.priority ?? '—')}</td>${area ? `<td class="text-muted">${escape(i.areaPath ?? '')}</td>` : ''}${extra.map(f => `<td>${cell(i, f)}</td>`).join('')}<td class="text-muted">${day(i.changedAt)}</td></tr>`).join('')}</tbody></table></div>`;
}

// What each person has assigned, with the people with more items first and the
// unassigned ones at the end; the same person in Jira and Azure DevOps goes together.
function peopleView(scene, rows) {
  const status = statusOf(scene), groups = new Map();
  for (const item of rows) groups.set(item.assignedTo, [...(groups.get(item.assignedTo) ?? []), item]);
  const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  const tint = name => [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4;
  return `<div class="maintenance-people">${[...groups].sort(([a, x], [b, y]) => (!a) - (!b) || y.length - x.length || a.localeCompare(b, 'es')).map(([name, items]) => {
    const sorted = [...items].sort((a, b) => (status.get(a.state)?.order ?? 0) - (status.get(b.state)?.order ?? 0));
    return `<section class="person-card"><header><span class="avatar${name ? ` c${tint(name)}` : ' none'}" aria-hidden="true">${name ? escape(initials(name)) : '?'}</span><strong>${name ? escape(name) : 'Sin asignar'}</strong><span class="count">${items.length}</span></header>${statusBar(scene, items, true)}
      <ul>${sorted.map(i => `<li class="${statusClass(scene, i.state)}${i.origin === 'jira' && !i.ticket ? ' not-downloaded' : ''}">${statePill(scene, i)}<span><span class="text-muted">${escape(i.label)}</span> ${itemLink(i)}</span></li>`).join('')}</ul></section>`;
  }).join('')}</div>`;
}

// The person decides, for each possible state of the type, whether it is open,
// waiting to be verified or closed.
function setupView(settings, setup) {
  const type = setup?.type ?? settings?.type ?? 'Functional Issue', states = setup?.states;
  const cancel = '<button type="button" class="button" data-action="maintenance-cancel-settings">Cancelar</button>';
  const typeField = `<div class="maintenance-setup-type"><label class="form-field">Tipo de elemento<input id="maintenance-type" value="${escape(type)}" maxlength="128" autocomplete="off"></label><button type="button" class="button ${states ? '' : 'primary'}" data-action="maintenance-load-states">${states ? 'Volver a cargar estados' : 'Cargar estados'}</button></div>`;
  if (!states) return `<div class="maintenance-setup"><h2>Estados de «${escape(type)}» en Azure DevOps</h2>${typeField}<div class="actions">${cancel}</div></div>`;
  const same = settings?.type === type;
  const closed = new Set(same ? settings.closedStates : states.filter(s => ['completed', 'removed'].includes(s.category)).map(s => s.name));
  const verify = new Set(same ? settings.verifyStates ?? [] : states.filter(s => s.category === 'resolved').map(s => s.name));
  const roles = [['open', 'Abierto'], ['verify', 'Verificación'], ['closed', 'Cerrado']];
  return `<div class="maintenance-setup"><h2>Estados de «${escape(type)}» en Azure DevOps</h2>${typeField}
    <p id="maintenance-type-hint" class="notice" role="status" hidden>Has cambiado el tipo de elemento. Vuelve a cargar sus estados antes de guardar.</p><form id="maintenance-settings-form" data-type="${escape(type)}"><div class="maintenance-states">${states.map((s, index) => {
      const role = closed.has(s.name) ? 'closed' : verify.has(s.name) ? 'verify' : 'open';
      return `<fieldset class="state-role"><legend><strong>${escape(s.name)}</strong><small>${escape(categoryLabels[s.category] || 'Sin categoría')}</small></legend><span class="segmented roles">${roles.map(([value, label]) => `<label class="role-${value}"><input type="radio" name="role-${index}" value="${value}" data-state="${escape(s.name)}" ${role === value ? 'checked' : ''}>${label}</label>`).join('')}</span></fieldset>`;
    }).join('')}</div><div class="actions">${cancel}<button class="button primary" type="submit">Guardar y consultar</button></div></form></div>`;
}
