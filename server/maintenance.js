// Maintenance queries. Which items are still open is decided by the person, who
// chooses once per project the states of the type that count as closed.
export const MAINTENANCE_LIMIT = 1000;
export const MAINTENANCE_FIELDS = ['System.Id', 'System.Title', 'System.State', 'System.AssignedTo', 'System.AreaPath', 'System.IterationPath', 'Microsoft.VSTS.Common.Priority', 'System.CreatedDate', 'System.ChangedDate', 'System.Tags'];
const text = value => typeof value === 'string' ? value.trim() : '';
const quoteWiql = value => `'${String(value).replace(/'/g, "''")}'`;

export function maintenanceSettingsFrom(input) {
  const type = text(input?.type);
  if (!type || type.length > 128) throw new Error('Indica el tipo de elemento.');
  if (!Array.isArray(input.states) || !input.states.length || input.states.length > 100) throw new Error('Carga primero los estados posibles del tipo.');
  const states = input.states.map(state => ({ name: text(state?.name), category: text(state?.category).slice(0, 40) }));
  if (states.some(state => !state.name || state.name.length > 128)) throw new Error('La lista de estados no es válida.');
  if (!Array.isArray(input.closedStates) || input.closedStates.some(name => !states.some(state => state.name === name))) throw new Error('Elige los estados cerrados de la lista cargada.');
  return { type, states, closedStates: [...new Set(input.closedStates)] };
}

// One WIQL over the whole project: every item of the type whose state is not closed.
export function maintenanceWiql(settings) {
  const closed = settings.closedStates.length ? ` AND [System.State] NOT IN (${settings.closedStates.map(quoteWiql).join(', ')})` : '';
  return `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = ${quoteWiql(settings.type)}${closed} ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC`;
}

export function maintenanceIssue(raw, states = []) {
  const f = raw.fields ?? {}, state = f['System.State'] ?? '', assigned = f['System.AssignedTo'];
  return {
    id: raw.id, title: f['System.Title'] || `Elemento ${raw.id}`, state,
    category: states.find(s => s.name.toLowerCase() === String(state).toLowerCase())?.category ?? '',
    assignedTo: typeof assigned === 'object' ? assigned?.displayName ?? '' : String(assigned ?? '').replace(/\s*<[^<>]*>$/, ''),
    areaPath: f['System.AreaPath'] ?? '', iterationPath: f['System.IterationPath'] ?? '',
    priority: f['Microsoft.VSTS.Common.Priority'] ?? null, createdAt: f['System.CreatedDate'] ?? null, changedAt: f['System.ChangedDate'] ?? null,
    tags: (f['System.Tags'] || '').split(';').map(s => s.trim()).filter(Boolean),
  };
}
