// Test plans: the test points of a plan of Azure Test Plans, summed up by
// outcome and by the person assigned to run them, with filters by person,
// suite, configuration and priority.
import { workDaysLeft } from './my-iteration.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('es').trim();
const day = value => value ? new Date(value).toLocaleDateString('es', { day: 'numeric', month: 'short' }) : '';
const percent = (part, total) => total ? `${Math.round(part / total * 100)} %` : '—';
export const OUTCOMES = [['passed', 'Superado'], ['failed', 'Fallido'], ['blocked', 'Bloqueado'], ['inconclusive', 'No concluyente'], ['notApplicable', 'No aplica'], ['inProgress', 'En curso'], ['notRun', 'Sin ejecutar']];
const OUTCOME_LABELS = Object.fromEntries(OUTCOMES);
// What still needs attention goes first in the lists of points.
const ATTENTION = ['failed', 'blocked', 'inProgress', 'notRun', 'inconclusive', 'notApplicable', 'passed'];
const executed = point => !['notRun', 'inProgress'].includes(point.outcome);
const NONE = '__none__', LIST_LIMIT = 1000, PERSON_LIMIT = 200;
const VIEWS = [['people', 'Personas'], ['suites', 'Suites'], ['matrix', 'Matriz'], ['list', 'Lista']];

// The filters, the view and the chosen plan are remembered per project in this browser.
const defaults = () => ({ text: '', tester: '', suite: '', configuration: '', priority: '', outcomes: [], view: 'people', planId: null });
let filters = defaults(), scopeKey = null;
const storageKey = key => `neo-team.test-plans.${key}`;
function restore(saved) {
  if (!saved || typeof saved !== 'object') return defaults();
  const text = (value, max = 200) => typeof value === 'string' ? value.slice(0, max) : '';
  return {
    text: text(saved.text), tester: text(saved.tester), suite: text(saved.suite, 20), configuration: text(saved.configuration), priority: text(saved.priority, 10),
    outcomes: Array.isArray(saved.outcomes) ? saved.outcomes.filter(o => OUTCOME_LABELS[o]) : [],
    view: VIEWS.some(([v]) => v === saved.view) ? saved.view : 'people', planId: Number.isInteger(saved.planId) ? saved.planId : null,
  };
}
function save() {
  if (!scopeKey) return;
  try { globalThis.localStorage?.setItem(storageKey(scopeKey), JSON.stringify(filters)); } catch {}
}
export function useTestPlansScope(key) {
  if (key === scopeKey) return;
  scopeKey = key;
  try { filters = restore(JSON.parse(globalThis.localStorage?.getItem(storageKey(key)) || 'null')); } catch { filters = defaults(); }
}
export const testPlansScopeOf = state => state.mode === 'demo' ? 'demo' : `${state.config?.organization ?? ''}/${state.config?.project ?? ''}`.toLowerCase();
export const rememberedTestPlan = () => filters.planId;
// Another plan has other suites: the suite filter is only kept within a plan.
export function chooseTestPlan(id) { if (filters.planId !== id) filters.suite = ''; filters.planId = id; save(); }
export function resetTestPlanFilters() { filters = { ...defaults(), view: filters.view, planId: filters.planId }; save(); }
export function setTestPlansView(view) { if (VIEWS.some(([v]) => v === view)) filters.view = view; save(); }
export function toggleTestPlanOutcome(snapshot, outcome) {
  filters.outcomes = filters.outcomes.includes(outcome) ? filters.outcomes.filter(o => o !== outcome) : [...filters.outcomes, outcome];
  save(); refresh(snapshot);
}
export function filterTestPlans(snapshot, name, value) {
  if (['text', 'tester', 'suite', 'configuration', 'priority'].includes(name)) filters[name] = String(value ?? '');
  save(); refresh(snapshot);
}
// A cell of the matrix, a person or a suite narrows the list to it.
export function focusTestPlans({ tester, suite, view }) {
  if (tester !== undefined) filters.tester = tester;
  if (suite !== undefined) filters.suite = suite;
  if (view) filters.view = view;
  save();
}
function refresh(snapshot) {
  const target = document.querySelector('#test-plans-body');
  if (target && snapshot) target.innerHTML = body(snapshot);
}

// The suites as a tree: the order to list them, their depth, path and the
// first-level suite under the root of the plan they belong to.
const treeCache = new WeakMap();
function treeOf(snapshot) {
  if (treeCache.has(snapshot)) return treeCache.get(snapshot);
  const byId = new Map(snapshot.suites.map(s => [s.id, s])), children = new Map();
  const root = snapshot.plan?.rootSuiteId ?? snapshot.suites.find(s => !s.parentId)?.id ?? null;
  for (const suite of snapshot.suites) if (suite.id !== root) {
    const parent = byId.has(suite.parentId) ? suite.parentId : root;
    children.set(parent, [...(children.get(parent) ?? []), suite.id]);
  }
  const order = [], depth = new Map(), top = new Map(), path = new Map();
  const visit = (id, level, first, trail) => {
    if (depth.has(id) || !byId.has(id)) return;
    const name = byId.get(id).name;
    order.push(id); depth.set(id, level); top.set(id, first ?? id); path.set(id, level ? [...trail, name].join(' › ') : name);
    for (const child of children.get(id) ?? []) visit(child, level + 1, level ? first : child, level ? [...trail, name] : []);
  };
  visit(root, 0, null, []);
  for (const suite of snapshot.suites) visit(suite.id, 1, suite.id, []);
  const descendants = new Map();
  const under = id => descendants.get(id) ?? (descendants.set(id, new Set([id, ...(children.get(id) ?? []).flatMap(c => [...under(c)])])), descendants.get(id));
  const tree = { root, byId, children, order, depth, top, path, under };
  treeCache.set(snapshot, tree);
  return tree;
}
const suiteName = (snapshot, id) => treeOf(snapshot).byId.get(id)?.name ?? '';

function visible(snapshot) {
  const tree = treeOf(snapshot), text = normalize(filters.text), suite = filters.suite && tree.byId.has(Number(filters.suite)) ? tree.under(Number(filters.suite)) : null;
  return snapshot.points.filter(p => (!filters.tester || (filters.tester === NONE ? !p.tester : p.tester === filters.tester))
    && (!suite || suite.has(p.suiteId))
    && (!filters.configuration || p.configuration === filters.configuration)
    && (!filters.priority || String(p.priority ?? '') === filters.priority)
    && (!text || normalize(`${p.caseId} ${p.title} ${p.tester} ${p.runBy} ${p.configuration} ${tree.path.get(p.suiteId) ?? ''}`).includes(text)));
}
const byOutcome = rows => filters.outcomes.length ? rows.filter(p => filters.outcomes.includes(p.outcome)) : rows;
function counts(rows) {
  const result = Object.fromEntries(OUTCOMES.map(([o]) => [o, 0]));
  for (const p of rows) result[p.outcome]++;
  return result;
}

const azureBase = snapshot => `https://dev.azure.com/${encodeURIComponent(snapshot.organization)}/${encodeURIComponent(snapshot.project)}`;
const caseLink = (snapshot, p) => snapshot.demo ? escape(p.title) : `<a href="${azureBase(snapshot)}/_workitems/edit/${p.caseId}" target="_blank" rel="noopener noreferrer">${escape(p.title)}</a>`;
const outcomePill = outcome => `<span class="pill st oc-${outcome}">${OUTCOME_LABELS[outcome]}</span>`;
const initials = name => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const tint = name => [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 4;
const avatar = name => `<span class="avatar${name ? ` c${tint(name)}` : ' none'}" aria-hidden="true">${name ? escape(initials(name)) : '?'}</span>`;

export function testPlansView(snapshot, state) {
  const demo = state.mode === 'demo';
  useTestPlansScope(testPlansScopeOf(state));
  const plan = snapshot?.plan, details = [escape(demo ? 'Datos de ejemplo' : state.config?.project || 'Conecta un proyecto para consultar sus planes de prueba.')];
  if (plan?.iteration) details.push(escape(plan.iteration.split('\\').pop()));
  if (plan?.startDate || plan?.endDate) details.push(`${day(plan.startDate) || '…'} – ${day(plan.endDate) || '…'}`);
  if (plan?.owner) details.push(escape(plan.owner));
  if (snapshot) details.push(`consultado el ${escape(new Date(snapshot.fetchedAt).toLocaleString('es'))}`);
  const name = !plan ? 'Planes de prueba' : snapshot.demo ? escape(plan.name) : `<a href="${azureBase(snapshot)}/_testPlans/execute?planId=${plan.id}" target="_blank" rel="noopener noreferrer" title="Abrir en Azure Test Plans">${escape(plan.name)}</a>`;
  const picker = snapshot?.plans?.length ? `<select data-test-plan aria-label="Plan de pruebas">${planOptions(snapshot)}</select>` : '';
  const heading = `<header class="maintenance-heading"><div><p class="eyebrow">PLANES DE PRUEBA</p><h1>${name}</h1><p>${details.join(' · ')}</p></div>${snapshot ? `<div class="tp-heading-tools">${picker}<button class="button" data-action="test-plans-refresh">Actualizar</button></div>` : ''}</header>`;
  const page = content => `<section class="maintenance-page test-plans-page">${heading}${content}</section>`;
  if (!state.config?.project && !demo) return page('<div class="empty-panel"><h2>Sin proyecto conectado</h2><p>Conecta Azure DevOps para consultar los planes de prueba del proyecto.</p><button class="button primary" data-action="connect">Conectar Azure DevOps</button></div>');
  if (!snapshot) return page('<div class="empty-panel"><h2>Sin consultar</h2><button class="button primary" data-action="test-plans-refresh">Consultar Azure DevOps</button></div>');
  if (!plan) return page('<div class="empty-result">No hay planes de prueba en el proyecto.</div>');
  if (!snapshot.points.length) return page('<div class="empty-result">El plan no tiene puntos de prueba.</div>');
  return page(`${snapshot.limited ? `<div class="notice warning">Se muestran los primeros ${snapshot.points.length} puntos. Hay más en Azure DevOps.</div>` : ''}${filterBar(snapshot)}<div id="test-plans-body">${body(snapshot)}</div>`);
}

function planOptions(snapshot) {
  const option = p => `<option value="${p.id}" ${p.id === snapshot.plan?.id ? 'selected' : ''}>${escape(p.name)}</option>`;
  const inactive = p => String(p.state).toLowerCase() === 'inactive';
  const active = snapshot.plans.filter(p => !inactive(p)), closed = snapshot.plans.filter(inactive);
  return `${active.map(option).join('')}${closed.length ? `<optgroup label="Inactivos">${closed.map(option).join('')}</optgroup>` : ''}`;
}

function filterBar(snapshot) {
  const tree = treeOf(snapshot), select = (name, label, options) => `<select data-test-plans-filter="${name}" aria-label="${label}" class="${filters[name] ? 'active' : ''}"><option value="">${label}</option>${options.map(([value, text]) => `<option value="${escape(value)}" ${filters[name] === String(value) ? 'selected' : ''}>${escape(text)}</option>`).join('')}</select>`;
  const testers = [...new Set(snapshot.points.map(p => p.tester).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const used = new Set(snapshot.points.map(p => p.suiteId)), withPoints = tree.order.filter(id => [...tree.under(id)].some(s => used.has(s)) && id !== tree.root);
  const configurations = [...new Set(snapshot.points.map(p => p.configuration).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  const priorities = [...new Set(snapshot.points.map(p => p.priority).filter(p => p !== null && p !== undefined))].sort((a, b) => a - b);
  const view = name => filters.view === name ? 'true' : 'false';
  return `<div class="maintenance-filters"><input type="search" data-test-plans-filter="text" aria-label="Buscar casos" placeholder="Buscar" value="${escape(filters.text)}">
    ${select('tester', 'Todas las personas', [...testers.map(t => [t, t]), ...(snapshot.points.some(p => !p.tester) ? [[NONE, 'Sin asignar']] : [])])}
    ${withPoints.length ? select('suite', 'Todas las suites', withPoints.map(id => [id, `${' '.repeat(Math.max(0, tree.depth.get(id) - 1))}${tree.byId.get(id).name}`])) : ''}
    ${configurations.length > 1 ? select('configuration', 'Todas las configuraciones', configurations.map(c => [c, c])) : ''}
    ${priorities.length > 1 ? select('priority', 'Todas las prioridades', priorities.map(p => [p, `Prioridad ${p}`])) : ''}
    <span class="maintenance-tools"><span class="segmented" role="group" aria-label="Vista">${VIEWS.map(([value, label]) => `<button type="button" data-action="test-plans-view" data-view="${value}" aria-pressed="${view(value)}">${label}</button>`).join('')}</span>
    <button class="button small" data-action="test-plans-clear-filters">Limpiar filtros</button></span></div>`;
}

function body(snapshot) {
  const base = visible(snapshot), rows = byOutcome(base);
  const content = !rows.length ? '<div class="empty-result" role="status"><p>Ningún punto coincide con los filtros.</p><button class="button" data-action="test-plans-clear-filters">Mostrar todos los puntos</button></div>'
    : ({ people: peopleView, suites: suitesView, matrix: matrixView, list: listView })[filters.view](snapshot, rows);
  return summary(snapshot, base) + content;
}

// Progress of the points in view: how many have been run and passed, how many
// people take part, what nobody has assigned and the pace needed to finish.
function summary(snapshot, rows) {
  const count = counts(rows), done = rows.filter(executed).length, pending = rows.length - done, people = new Set(rows.map(p => p.tester).filter(Boolean)).size;
  const unassigned = rows.filter(p => !p.tester).length, end = snapshot.plan?.endDate, left = end && !String(snapshot.plan.state).match(/inactive/i) ? workDaysLeft(end) : null;
  const tile = (label, value, detail = '', extra = '') => `<div class="tp-kpi"${extra}><span class="tp-kpi-label">${label}</span><strong>${value}</strong>${detail ? `<small>${detail}</small>` : ''}</div>`;
  const kpis = [
    `<div class="tp-kpi"><span class="tp-kpi-label">Ejecutado</span><strong>${percent(done, rows.length)}</strong><small>${done} de ${rows.length}</small><span class="tp-progress" aria-hidden="true"><i style="width:${rows.length ? done / rows.length * 100 : 0}%"></i></span></div>`,
    tile('Superado', percent(count.passed, done), done ? `${count.passed} de ${done} ejecutados` : ''),
    tile('Personas', people, people ? `${(rows.length - unassigned) && Math.round((rows.length - unassigned) / people)} puntos de media` : ''),
    unassigned ? `<button type="button" class="tp-kpi warn" data-action="test-plans-focus" data-tester="${NONE}" aria-pressed="${filters.tester === NONE}"><span class="tp-kpi-label">Sin asignar</span><strong>${unassigned}</strong><small>${percent(unassigned, rows.length)}</small></button>` : tile('Sin asignar', 0),
    left !== null && left >= 0 ? tile('Quedan', `${left} días`, pending ? `${Math.ceil(pending / Math.max(left, 1))} puntos al día` : 'Todo ejecutado', ' title="Días laborables hasta el final del plan"') : '',
  ].join('');
  const shown = OUTCOMES.filter(([o]) => count[o] || filters.outcomes.includes(o));
  const bar = `<div class="status-bar${filters.outcomes.length ? ' filtered' : ''}" role="img" aria-label="${escape(shown.map(([o, l]) => `${l}: ${count[o]}`).join(', ') || 'Sin puntos')}">${shown.filter(([o]) => count[o]).map(([o, l]) => `<span class="st oc-${o}${filters.outcomes.includes(o) ? ' on' : ''}" style="flex-grow:${count[o]}" title="${l}: ${count[o]}"></span>`).join('')}</div>`;
  const keys = shown.map(([o, l]) => `<button type="button" class="status-key st oc-${o}" data-action="test-plans-outcome" data-outcome="${o}" aria-pressed="${filters.outcomes.includes(o)}"><i></i>${l}<b>${count[o]}</b></button>`).join('');
  return `<div class="tp-kpis">${kpis}</div><div class="maintenance-status">${bar}<div class="status-legend"><div class="status-group">${keys}</div></div></div>`;
}

function miniBar(points) {
  const count = counts(points), shown = OUTCOMES.filter(([o]) => count[o]);
  return `<div class="status-bar small" role="img" aria-label="${escape(shown.map(([o, l]) => `${l}: ${count[o]}`).join(', '))}">${shown.map(([o, l]) => `<span class="st oc-${o}" style="flex-grow:${count[o]}" title="${l}: ${count[o]}"></span>`).join('')}</div>`;
}
const groupBy = (rows, key) => { const groups = new Map(); for (const p of rows) groups.set(key(p), [...(groups.get(key(p)) ?? []), p]); return groups; };
const attention = (a, b) => ATTENTION.indexOf(a.outcome) - ATTENTION.indexOf(b.outcome) || (a.priority ?? 9) - (b.priority ?? 9) || a.title.localeCompare(b.title, 'es');

// What each person has to run, with whoever has the most left on top and the
// points without anybody at the end.
function peopleView(snapshot, rows) {
  const groups = [...groupBy(rows, p => p.tester)].map(([name, points]) => ({ name, points, done: points.filter(executed).length }))
    .sort((a, b) => (!a.name) - (!b.name) || (b.points.length - b.done) - (a.points.length - a.done) || b.points.length - a.points.length || a.name.localeCompare(b.name, 'es'));
  return `<div class="maintenance-people">${groups.map(({ name, points, done }) => {
    const count = counts(points), sorted = [...points].sort(attention);
    const stats = OUTCOMES.filter(([o]) => count[o]).map(([o, l]) => `<span class="tp-stat st oc-${o}" title="${l}"><i></i>${count[o]}</span>`).join('');
    return `<section class="person-card"><header>${avatar(name)}<button type="button" class="link-button tp-person" data-action="test-plans-focus" data-tester="${escape(name || NONE)}" data-view="list" title="Ver sus puntos en la lista">${name ? escape(name) : 'Sin asignar'}</button><span class="tp-person-done" title="Ejecutados de asignados">${done}/${points.length}</span></header>${miniBar(points)}<div class="tp-stats">${stats}<span class="tp-rate" title="Superados de ejecutados">${done ? `${percent(count.passed, done)} superado` : ''}</span></div>
      <details class="tp-points"><summary>${points.length - done ? `${points.length - done} por ejecutar` : 'Puntos'}</summary><ul>${sorted.slice(0, PERSON_LIMIT).map(p => `<li class="st oc-${p.outcome}">${outcomePill(p.outcome)}<span><span class="text-muted">#${p.caseId}</span> ${caseLink(snapshot, p)}<small class="text-muted">${escape(suiteName(snapshot, p.suiteId))}${p.configuration ? ` · ${escape(p.configuration)}` : ''}</small></span></li>`).join('')}</ul>${sorted.length > PERSON_LIMIT ? `<p class="local-note">Y ${sorted.length - PERSON_LIMIT} más en la lista.</p>` : ''}</details></section>`;
  }).join('')}</div>`;
}

// Every suite with the points of its branch: progress, results and who runs them.
function suitesView(snapshot, rows) {
  const tree = treeOf(snapshot), bySuite = groupBy(rows, p => p.suiteId);
  const lines = tree.order.map(id => ({ id, points: [...tree.under(id)].flatMap(s => bySuite.get(s) ?? []) })).filter(l => l.points.length);
  return `<div class="table-wrap"><table class="maintenance-table tp-suites"><thead><tr><th>Suite</th><th>Puntos</th><th>Resultado</th><th>Ejecutado</th><th>Superado</th><th>Personas</th></tr></thead><tbody>${lines.map(({ id, points }) => {
    const done = points.filter(executed).length, passed = points.filter(p => p.outcome === 'passed').length, suite = tree.byId.get(id);
    const people = [...groupBy(points, p => p.tester)].sort(([a, x], [b, y]) => (!a) - (!b) || y.length - x.length);
    return `<tr class="${id === tree.root ? 'tp-root' : ''}"><td style="padding-left:${12 + tree.depth.get(id) * 18}px">${id === tree.root ? `<strong>${escape(suite.name)}</strong>` : `<button type="button" class="link-button" data-action="test-plans-focus" data-suite="${id}" title="Filtrar por esta suite">${escape(suite.name)}</button>`}${suite.type === 'requirementTestSuite' && suite.requirementId ? ` <span class="text-muted" title="Suite de requisito">#${suite.requirementId}</span>` : ''}</td>
      <td>${points.length}</td><td class="tp-bar-cell">${miniBar(points)}</td><td>${percent(done, points.length)}</td><td>${percent(passed, done)}</td>
      <td><span class="tp-avatars">${people.slice(0, 6).map(([name, list]) => `<span title="${escape(name || 'Sin asignar')}: ${list.length}">${avatar(name)}</span>`).join('')}${people.length > 6 ? `<span class="text-muted">+${people.length - 6}</span>` : ''}</span></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

// People by first-level suites: how the work of the plan is spread among the
// testers. Each cell opens its points in the list.
function matrixView(snapshot, rows) {
  const tree = treeOf(snapshot), column = p => tree.top.get(p.suiteId) ?? tree.root;
  const columns = tree.order.filter(id => rows.some(p => column(p) === id));
  const people = [...groupBy(rows, p => p.tester)].sort(([a, x], [b, y]) => (!a) - (!b) || y.length - x.length || a.localeCompare(b, 'es'));
  const cell = (points, tester, suite) => {
    if (!points.length) return '<td class="tp-cell-empty">·</td>';
    const done = points.filter(executed).length, count = counts(points);
    const title = OUTCOMES.filter(([o]) => count[o]).map(([o, l]) => `${l}: ${count[o]}`).join(', ');
    return `<td><button type="button" class="tp-cell" data-action="test-plans-focus" data-tester="${escape(tester || NONE)}"${suite !== null ? ` data-suite="${suite}"` : ''} data-view="list" title="${escape(title)}"><span>${done}/${points.length}</span>${miniBar(points)}</button></td>`;
  };
  const head = columns.map(id => `<th title="${escape(tree.path.get(id))}">${escape(tree.byId.get(id)?.name ?? '')}</th>`).join('');
  const body = people.map(([name, points]) => `<tr><th scope="row"><span class="tp-matrix-person">${avatar(name)}${name ? escape(name) : 'Sin asignar'}</span></th>${columns.map(id => cell(points.filter(p => column(p) === id), name, id === tree.root ? null : id)).join('')}${cell(points, name, null)}</tr>`).join('');
  const totals = `<tr class="tp-total"><th scope="row">Total</th>${columns.map(id => { const points = rows.filter(p => column(p) === id); return `<td><span class="tp-cell static"><span>${points.filter(executed).length}/${points.length}</span>${miniBar(points)}</span></td>`; }).join('')}<td><span class="tp-cell static"><span>${rows.filter(executed).length}/${rows.length}</span>${miniBar(rows)}</span></td></tr>`;
  return `<div class="table-wrap"><table class="tp-matrix"><thead><tr><th></th>${head}<th>Total</th></tr></thead><tbody>${body}${totals}</tbody></table></div>`;
}

function listView(snapshot, rows) {
  const tree = treeOf(snapshot), sorted = [...rows].sort(attention), shown = sorted.slice(0, LIST_LIMIT);
  return `<p class="local-note" role="status">${rows.length === snapshot.points.length ? `${rows.length} puntos` : `${rows.length} de ${snapshot.points.length} puntos`}${rows.length > LIST_LIMIT ? ` · se muestran ${LIST_LIMIT}` : ''}</p>
    <div class="table-wrap"><table class="maintenance-table tp-list"><thead><tr><th>Caso</th><th>Título</th><th>Resultado</th><th>Asignado</th><th>Suite</th><th>Configuración</th><th>Prioridad</th><th>Ejecutado</th></tr></thead><tbody>${shown.map(p => `<tr class="st oc-${p.outcome}"><td>#${p.caseId}</td><td><span class="table-title">${caseLink(snapshot, p)}</span>${p.automated ? ' <span class="tag">Automatizado</span>' : ''}</td><td>${outcomePill(p.outcome)}</td>
      <td>${p.tester ? escape(p.tester) : '<span class="text-muted">Sin asignar</span>'}</td><td class="text-muted" title="${escape(tree.path.get(p.suiteId) ?? '')}">${escape(suiteName(snapshot, p.suiteId))}</td><td class="text-muted">${escape(p.configuration)}</td><td>${p.priority ?? '—'}</td>
      <td class="text-muted">${p.runAt ? `${day(p.runAt)}${p.runBy && p.runBy !== p.tester ? ` · ${escape(p.runBy)}` : ''}` : '—'}</td></tr>`).join('')}</tbody></table></div>`;
}
