// Maintenance queries. Which items are still open is decided by the person, who
// chooses once per project the states of the type that count as closed and the
// ones that mean the item is waiting to be verified.
export const MAINTENANCE_LIMIT = 1000;
export const MAINTENANCE_FIELDS = ['System.Id', 'System.Title', 'System.State', 'System.AssignedTo', 'System.AreaPath', 'System.IterationPath', 'Microsoft.VSTS.Common.Priority', 'System.CreatedDate', 'System.ChangedDate', 'System.Tags'];
// Fields of the type that are read to filter by them: long texts and internal
// bookkeeping fields are left out.
const SKIPPED_TYPES = new Set(['html', 'history']);
const SKIPPED_FIELDS = new Set(['System.Id', 'System.Title', 'System.Rev', 'System.Watermark', 'System.TeamProject', 'System.WorkItemType', 'System.AreaId', 'System.IterationId', 'System.NodeName', 'System.PersonId', 'System.AuthorizedAs', 'System.AuthorizedDate', 'System.RevisedDate', 'System.IsDeleted', 'System.CommentCount', 'System.ExternalLinkCount', 'System.HyperLinkCount', 'System.AttachedFileCount', 'System.RelatedLinkCount', 'System.RemoteLinkCount', 'System.BoardColumnDone', 'System.AreaLevel1', 'System.AreaLevel2', 'System.AreaLevel3', 'System.AreaLevel4', 'System.AreaLevel5', 'System.AreaLevel6', 'System.AreaLevel7', 'System.IterationLevel1', 'System.IterationLevel2', 'System.IterationLevel3', 'System.IterationLevel4', 'System.IterationLevel5', 'System.IterationLevel6', 'System.IterationLevel7']);
const FIELD_LIMIT = 150;
const text = value => typeof value === 'string' ? value.trim() : '';
const quoteWiql = value => `'${String(value).replace(/'/g, "''")}'`;

export function maintenanceSettingsFrom(input) {
  const type = text(input?.type);
  if (!type || type.length > 128) throw new Error('Indica el tipo de elemento.');
  if (!Array.isArray(input.states) || !input.states.length || input.states.length > 100) throw new Error('Carga primero los estados posibles del tipo.');
  const states = input.states.map(state => ({ name: text(state?.name), category: text(state?.category).slice(0, 40) }));
  if (states.some(state => !state.name || state.name.length > 128)) throw new Error('La lista de estados no es válida.');
  const known = list => Array.isArray(list) && list.every(name => states.some(state => state.name === name));
  if (!known(input.closedStates)) throw new Error('Elige los estados cerrados de la lista cargada.');
  const verifyStates = input.verifyStates ?? [];
  if (!known(verifyStates)) throw new Error('Elige los estados pendientes de verificación de la lista cargada.');
  if (verifyStates.some(name => input.closedStates.includes(name))) throw new Error('Un estado no puede ser cerrado y pendiente de verificación a la vez.');
  return { type, states, closedStates: [...new Set(input.closedStates)], verifyStates: [...new Set(verifyStates)] };
}

// One WIQL over the whole project: every item of the type whose state is not
// closed, or every item when the closed ones are included too (newest first, so
// the limit leaves out the oldest closed items).
export function maintenanceWiql(settings, { includeClosed = false } = {}) {
  const closed = !includeClosed && settings.closedStates.length ? ` AND [System.State] NOT IN (${settings.closedStates.map(quoteWiql).join(', ')})` : '';
  const order = includeClosed ? '[System.ChangedDate] DESC' : '[Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC';
  return `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = ${quoteWiql(settings.type)}${closed} ORDER BY ${order}`;
}

// The fields of the type that can be filtered, in the order Azure lists them.
export function maintenanceFields(raw) {
  const seen = new Set();
  return (Array.isArray(raw) ? raw : []).map(f => ({ ref: text(f?.referenceName), name: text(f?.name) || text(f?.referenceName), type: text(f?.type) || 'string' }))
    .filter(f => f.ref && !SKIPPED_TYPES.has(f.type) && !SKIPPED_FIELDS.has(f.ref) && !seen.has(f.ref) && seen.add(f.ref))
    .slice(0, FIELD_LIMIT);
}

const identity = value => typeof value === 'object' && value ? value.displayName ?? value.uniqueName ?? '' : String(value ?? '').replace(/\s*<[^<>]*>$/, '');
// A value as the interface filters and shows it: names for people, Sí/No for
// booleans and short texts.
function fieldValue(value, type) {
  if (value === undefined || value === null || value === '') return '';
  if (type === 'identity' || (typeof value === 'object' && 'displayName' in value)) return identity(value);
  if (type === 'boolean' || typeof value === 'boolean') return value === true || value === 'true' ? 'Sí' : 'No';
  if (typeof value === 'object') return '';
  return typeof value === 'number' ? value : String(value).slice(0, 300);
}

export function maintenanceIssue(raw, states = [], fields = []) {
  const f = raw.fields ?? {}, state = f['System.State'] ?? '';
  const values = {};
  for (const field of fields) {
    const value = fieldValue(f[field.ref], field.type);
    if (value !== '') values[field.ref] = value;
  }
  return {
    id: raw.id, title: f['System.Title'] || `Elemento ${raw.id}`, state,
    category: states.find(s => s.name.toLowerCase() === String(state).toLowerCase())?.category ?? '',
    assignedTo: identity(f['System.AssignedTo']),
    areaPath: f['System.AreaPath'] ?? '', iterationPath: f['System.IterationPath'] ?? '',
    priority: f['Microsoft.VSTS.Common.Priority'] ?? null, createdAt: f['System.CreatedDate'] ?? null, changedAt: f['System.ChangedDate'] ?? null,
    tags: (f['System.Tags'] || '').split(';').map(s => s.trim()).filter(Boolean),
    values,
  };
}
