// Mantenimiento: the tickets of the Jira filter and the items of a type in Azure
// DevOps in one shape, and the filters over them. The server applies the same
// filters, so updating and the agents act only on what the person sees.
export const ORIGINS = { jira: 'Jira', azure: 'Azure DevOps' };
export const groupLabels = { new: 'Sin empezar', active: 'En curso', verify: 'Verificación', closed: 'Cerrado' };
export const GROUPS = Object.keys(groupLabels);
export const EMPTY = '__empty__';
export const DATE_RANGES = [['last:7', 'Últimos 7 días'], ['last:30', 'Últimos 30 días'], ['last:90', 'Últimos 90 días'], ['older:30', 'Hace más de 30 días'], ['older:90', 'Hace más de 90 días']];
import { normalize, matchesQuery, compileQuery } from './search.js';
export { normalize };

// The fields both origins fill keep the references of Azure DevOps, so the filters
// saved before keep working; the rest belong to one origin only.
export const COMMON_FIELDS = [
  { ref: 'System.State', name: 'Estado', type: 'string' },
  { ref: 'System.AssignedTo', name: 'Asignado', type: 'identity' },
  { ref: 'Microsoft.VSTS.Common.Priority', name: 'Prioridad', type: 'string' },
  { ref: 'System.WorkItemType', name: 'Tipo', type: 'string' },
  { ref: 'System.Tags', name: 'Etiquetas', type: 'plainText' },
  { ref: 'System.CreatedDate', name: 'Creado', type: 'dateTime' },
  { ref: 'System.ChangedDate', name: 'Actualizado', type: 'dateTime' },
];
export const JIRA_FIELDS = [
  { ref: 'neo.stage', name: 'Paso', type: 'string' },
  { ref: 'neo.status', name: 'Situación', type: 'string' },
  { ref: 'jira.components', name: 'Componentes', type: 'plainText' },
  { ref: 'jira.fixVersions', name: 'Versión de corrección', type: 'plainText' },
  { ref: 'jira.reporter', name: 'Informador', type: 'identity' },
];
// Fields that hold several values separated by «;»: a value filters the items that have it.
const MULTI = new Set(['System.Tags', 'jira.components', 'jira.fixVersions']);
export const valuesOf = (item, ref) => MULTI.has(ref) ? String(item.values?.[ref] ?? '').split(';').map(v => v.trim()).filter(Boolean) : null;
export const valueOf = (item, ref) => item.values?.[ref] ?? '';
const compact = values => Object.fromEntries(Object.entries(values).filter(([, value]) => value !== '' && value !== null && value !== undefined));

// Where a ticket is on the board, and how it is doing there.
const STAGE_NAMES = { collect: 'Analizar', analyze: 'Analizar', reproduce: 'Reproducir', fix: 'Solucionar', build: 'Verificar', verify: 'Verificar', review: 'Revisar', done: 'Resueltos' };
const STATUS_NAMES = { pending: 'Pendiente', running: 'En curso', blocked: 'Necesita ayuda', done: 'Resuelto' };
export const NOT_DOWNLOADED = 'Sin descargar';
const JIRA_GROUPS = { new: 'new', indeterminate: 'active', done: 'closed' };

// An item of Azure DevOps, as the maintenance query returns it.
export function azureItem(issue, snapshot) {
  const closed = new Set(snapshot.closedStates ?? []), verify = new Set(snapshot.verifyStates ?? []);
  const group = closed.has(issue.state) ? 'closed' : verify.has(issue.state) ? 'verify' : ['inprogress', 'resolved'].includes(issue.category) ? 'active' : 'new';
  const url = snapshot.demo ? null : `https://dev.azure.com/${encodeURIComponent(snapshot.organization ?? '')}/${encodeURIComponent(snapshot.project ?? '')}/_workitems/edit/${issue.id}`;
  return {
    origin: 'azure', id: `azure:${issue.id}`, key: issue.id, label: `#${issue.id}`, title: issue.title, state: issue.state, group,
    assignedTo: issue.assignedTo ?? '', priority: issue.priority ?? null, tags: issue.tags ?? [], areaPath: issue.areaPath ?? '', changedAt: issue.changedAt ?? null, url,
    values: compact({ ...issue.values, 'System.State': issue.state, 'System.AssignedTo': issue.assignedTo, 'Microsoft.VSTS.Common.Priority': issue.priority ?? '', 'System.WorkItemType': snapshot.type,
      'System.Tags': (issue.tags ?? []).join('; '), 'System.AreaPath': issue.areaPath, 'System.IterationPath': issue.iterationPath, 'System.CreatedDate': issue.createdAt, 'System.ChangedDate': issue.changedAt }),
  };
}

// The tickets of Jira: those of the filter, as the last update read them, and those
// on the board, which may have left it. A ticket of the filter not on the board yet
// has not been downloaded.
export function jiraItems(tickets = [], catalog = []) {
  const board = new Map(tickets.map(t => [t.key, t])), seen = new Set(), items = [];
  const item = (entry, ticket) => {
    const status = entry?.status ?? ticket?.jiraStatus ?? '', category = entry?.category ?? ticket?.jiraCategory ?? '';
    const assignee = entry ? entry.assignee : ticket?.assignee ?? null, key = entry?.key ?? ticket.key;
    const where = !ticket ? NOT_DOWNLOADED : STAGE_NAMES[ticket.stage] ?? ticket.stage;
    const how = !ticket ? NOT_DOWNLOADED : STATUS_NAMES[ticket.status] ?? ticket.status;
    const labels = entry?.labels ?? [];
    return {
      origin: 'jira', id: `jira:${key}`, key, label: key, title: entry?.summary ?? ticket?.summary ?? key, state: status, group: JIRA_GROUPS[category] ?? 'new',
      assignedTo: assignee?.name ?? '', me: !!assignee?.me, priority: entry?.priority ?? ticket?.priority ?? null, tags: labels, changedAt: entry?.updated ?? ticket?.updated ?? null,
      url: ticket?.url ?? entry?.url ?? null, ticket: ticket ?? null,
      values: compact({ 'System.State': status, 'System.AssignedTo': assignee?.name ?? '', 'Microsoft.VSTS.Common.Priority': entry?.priority ?? ticket?.priority ?? '', 'System.WorkItemType': entry?.type ?? ticket?.type ?? '',
        'System.Tags': labels.join('; '), 'System.CreatedDate': entry?.created, 'System.ChangedDate': entry?.updated ?? ticket?.updated, 'jira.components': (entry?.components ?? []).join('; '),
        'jira.fixVersions': (entry?.fixVersions ?? []).join('; '), 'jira.reporter': entry?.reporter ?? '', 'neo.stage': where, 'neo.status': how }),
    };
  };
  for (const entry of catalog) { seen.add(entry.key); items.push(item(entry, board.get(entry.key))); }
  for (const ticket of tickets) if (!seen.has(ticket.key)) items.push(item(null, ticket));
  return items;
}

// What the person filters by. `kind` says how each field condition compares: dates by
// range, a value chosen from a list, or text it has to contain.
export const defaultFilters = () => ({ text: '', states: [], conditions: [], includeClosed: false, origin: '' });
export function filtersFrom(saved) {
  const base = defaultFilters();
  if (!saved || typeof saved !== 'object') return base;
  const kind = value => ['date', 'select', 'text'].includes(value) ? value : undefined;
  return {
    text: typeof saved.text === 'string' ? saved.text.slice(0, 200) : '',
    states: Array.isArray(saved.states) ? saved.states.filter(s => typeof s === 'string').slice(0, 100) : [],
    conditions: Array.isArray(saved.conditions) ? saved.conditions.filter(c => typeof c?.field === 'string' && typeof c.value === 'string').slice(0, 20).map(c => ({ field: c.field.slice(0, 200), value: c.value.slice(0, 200), ...(kind(c.kind) ? { kind: c.kind } : {}) })) : [],
    includeClosed: saved.includeClosed === true, origin: ORIGINS[saved.origin] ? saved.origin : '',
  };
}
// Whether anything narrows the items, beyond leaving out the closed ones.
export const narrowed = filters => !!(compileQuery(filters.text) || filters.states.length || filters.origin || filters.conditions.some(c => c.value));

export function matches(item, condition) {
  const value = valueOf(item, condition.field);
  if (condition.value === EMPTY) return value === '';
  if (condition.kind === 'date') {
    if (!value) return false;
    const [mode, days] = condition.value.split(':'), age = (Date.now() - new Date(value)) / 86400000;
    return mode === 'last' ? age <= Number(days) : age > Number(days);
  }
  if (condition.kind === 'text') return matchesQuery(condition.value, normalize(value));
  const many = valuesOf(item, condition.field);
  return many ? many.includes(condition.value) : String(value) === condition.value;
}
// What is typed is searched in the item (its key, title, person, state…) with the
// syntax of search.js: every word, unless OR offers alternatives.
const searchText = item => normalize(`${item.label} ${item.title} ${item.assignedTo} ${item.state} ${item.areaPath ?? ''} ${(item.tags ?? []).join(' ')} ${Object.values(item.values ?? {}).join(' ')}`);
export function matchesText(item, text) {
  const query = compileQuery(text);
  return !query || query(searchText(item));
}
// The items the filters leave: `base` before choosing states (the summary counts it)
// and `rows`, what is shown and acted on.
export function filterItems(items, filters) {
  const active = filters.conditions.filter(c => c.value);
  const base = items.filter(item => (!filters.origin || item.origin === filters.origin) && (filters.includeClosed || item.group !== 'closed')
    && matchesText(item, filters.text) && active.every(c => matches(item, c)));
  return { base, rows: filters.states.length ? base.filter(item => filters.states.includes(item.state)) : base };
}
