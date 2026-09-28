import { sourcesOf, sourceFor, planningItem, remoteFields } from './multi-project.js';
import { randomUUID } from 'node:crypto';
import { isExecutable, completedState, estimateFields } from '../dist/hierarchy.js';

export const FIELD_LABELS = { title: 'Título', assignedTo: 'Responsable', iterationPath: 'Iteración', priority: 'Prioridad', originalEstimate: 'Original Estimate', remainingWork: 'Remaining Work', state: 'Estado' };
export function identityKey(identity) {
  if (!identity) return '';
  if (typeof identity === 'object') return (identity.uniqueName || identity.id || identity.displayName || '').toLowerCase();
  return (identity.match(/<([^<>]+)>$/)?.[1] || identity).trim().toLowerCase();
}
export function normalizeItem(raw) {
  if (!Number.isInteger(raw.id) || !Number.isInteger(raw.rev) || !raw.fields) throw new Error('La tarea no incluye un identificador y una revisión válidos.');
  const f = raw.fields;
  return {
    id: raw.id, rev: raw.rev, title: f['System.Title'] || `Tarea ${raw.id}`, type: f['System.WorkItemType'] || 'Task', state: f['System.State'] || '',
    assignedTo: identityKey(f['System.AssignedTo']), assigneeName: typeof f['System.AssignedTo'] === 'object' ? f['System.AssignedTo'].displayName : (f['System.AssignedTo'] || '').replace(/\s*<.*>$/, ''),
    iterationPath: f['System.IterationPath'] || '', areaPath: f['System.AreaPath'] || '',
    priority: f['Microsoft.VSTS.Common.Priority'] ?? null,
    remainingWork: f['Microsoft.VSTS.Scheduling.RemainingWork'] ?? null,
    originalEstimate: f['Microsoft.VSTS.Scheduling.OriginalEstimate'] ?? null,
    points: f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? f['Microsoft.VSTS.Scheduling.Effort'] ?? f['Microsoft.VSTS.Scheduling.Size'] ?? null,
    canEstimateHours: 'Microsoft.VSTS.Scheduling.RemainingWork' in f || f['System.WorkItemType'] === 'Task',
    canPrioritize: 'Microsoft.VSTS.Common.Priority' in f,
    tags: (f['System.Tags'] || '').split(';').map(s => s.trim()).filter(Boolean),
    parent: f['System.Parent'] || Number(raw.relations?.find(r => r.rel === 'System.LinkTypes.Hierarchy-Reverse')?.url?.split('/').at(-1)) || null,
  };
}
export const same = (a, b) => (a ?? null) === (b ?? null);
export const effectiveItems = workspace => workspace.items.map(item => ({ ...item, ...workspace.drafts[item.id], modified: !!workspace.drafts[item.id] || !!item.localOnly }));
export function createLocalItem(workspace, input, { duplicate = false } = {}) {
  if (!workspace) throw new Error('Importa una planificación primero.');
  const types=['Epic','Feature','User Story','Task','Bug'];
  if (!types.includes(input.type) || typeof input.title!=='string' || !input.title.trim() || input.title.trim().length>255) throw new Error('Indica un tipo y un título válido (máximo 255 caracteres).');
  const parent=input.parent ? workspace.items.find(i=>i.id===input.parent) : null;
  const allowed={Epic:[],Feature:['Epic'],'User Story':['Feature'],Task:['User Story','Product Backlog Item','Requirement'],Bug:['User Story','Product Backlog Item','Requirement']};
  // A duplicate keeps exactly the parent of its original, whatever it is.
  if (input.parent && (!parent || !duplicate && !allowed[input.type].includes(parent.type))) throw new Error('El padre no corresponde a este nivel de jerarquía.');
  if (input.type!=='Epic' && !parent && !duplicate) throw new Error('Elige un padre para mantener la jerarquía.');
  const id=Math.min(0,...workspace.items.map(i=>i.id),workspace.nextLocalId || 0)-1;
  const origin=workspace.sources ? (parent ? sourceFor(workspace,parent) : workspace.sources.find(s=>s.id===input.sourceId)) : null;
  if(workspace.sources && !origin) throw new Error('Elige el proyecto del nuevo elemento.');
  const item={...(origin ? {sourceId:origin.id,project:origin.config.project} : {}),id,rev:0,localOnly:true,creationKey:randomUUID(),title:input.title.trim(),type:input.type,parent:parent?.id || null,state:'New',assignedTo:'',iterationPath:workspace.settings.backlogIteration.path,areaPath:parent?.areaPath || origin?.settings.defaultValue || origin?.config.project || workspace.settings.defaultValue || workspace.settings.areaPaths?.[0]?.value || workspace.config.project,remainingWork:null,priority:2,points:null,tags:[],canEstimateHours:['Task','Bug'].includes(input.type),canPrioritize:true,...(duplicate ? {areaPath:input.areaPath ?? parent?.areaPath,tags:[...(input.tags ?? [])],...(input.copyFrom ? {copyFrom:input.copyFrom} : {})} : {})};
  workspace.items.push(item);workspace.nextLocalId=id;
  stageChanges(workspace,id,{title:item.title,...(input.assignedTo ? {assignedTo:input.assignedTo} : {}),...(input.iterationPath ? {iterationPath:input.iterationPath} : {}),...(input.remainingWork!==undefined ? {remainingWork:input.remainingWork} : {})});
  return id;
}
// Duplicates a task or bug as a new local item: same parent, project, area, owner,
// iteration, hours, priority, tags and description. It is created in Azure when
// synchronized; the description is read from the original then (a copy of a copy
// takes it from the same Azure item).
export function duplicateItem(workspace, id) {
  const item = workspace && effectiveItems(workspace).find(i => i.id === id);
  if (!item || !isExecutable(item) || item.contextOnly) throw new Error('Solo se pueden duplicar tareas y bugs.');
  const member = item.assignedTo && workspace.members.some(m => identityKey(m) === item.assignedTo) ? item.assignedTo : undefined;
  const copyFrom = item.id > 0 ? item.id : item.copyFrom;
  const copy = createLocalItem(workspace, { type: item.type, title: item.title, parent: item.parent, sourceId: item.sourceId, areaPath: item.areaPath, tags: item.tags, copyFrom,
    ...(member ? { assignedTo: member } : {}), iterationPath: item.iterationPath, ...(item.remainingWork != null ? { remainingWork: item.remainingWork } : {}) }, { duplicate: true });
  const extra = {};
  if (item.canPrioritize && item.priority != null && item.priority !== 2) extra.priority = item.priority;
  if (item.originalEstimate != null && estimateFields(workspace, item).originalEstimate) extra.originalEstimate = item.originalEstimate;
  if (Object.keys(extra).length) stageChanges(workspace, copy, extra);
  return copy;
}
// Some processes require a description to create an item. Azure only says so when
// validating the creation; the person then writes it in the review, and it is sent
// with the creation (bugs keep it in Repro Steps).
export const DESCRIPTION_FIELDS = { 'System.Description': 'Description', 'Microsoft.VSTS.TCM.ReproSteps': 'Repro Steps' };
export function requiredDescription(message) {
  const text = String(message ?? '');
  if (!/TF401320|\bRequired\b|InvalidEmpty/i.test(text)) return null;
  if (/Repro ?Steps|Pasos de reproducci[oó]n/i.test(text)) return 'Microsoft.VSTS.TCM.ReproSteps';
  if (/\bDescrip(tion|ción)\b/i.test(text)) return 'System.Description';
  return null;
}
export function setDescription(workspace, id, text, field = 'System.Description') {
  const item = workspace?.items.find(i => i.id === id);
  if (!item?.localOnly) throw new Error('Solo se puede escribir la descripción de un elemento nuevo.');
  if (workspace.creationAttempts?.[id]) throw new Error('Recupera primero el resultado de la creación enviada antes de editarla.');
  if (!Object.hasOwn(DESCRIPTION_FIELDS, field)) throw new Error('Campo no editable.');
  if (typeof text !== 'string' || text.length > 20000) throw new Error('La descripción no puede superar 20000 caracteres.');
  if (text.trim()) Object.assign(item, { description: text.trim(), descriptionField: field });
  else { delete item.description; delete item.descriptionField; }
  return item;
}
// Azure stores the description as HTML: the text is escaped and keeps its lines.
export const descriptionHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/\r?\n/g, '<br>');
// Comments are written locally and published in Azure DevOps when synchronizing.
// Mentions are kept as @<email>, which Azure turns into a real mention.
export function addComment(workspace, id, text) {
  const item = workspace && effectiveItems(workspace).find(i => i.id === id);
  if (!item || item.contextOnly) throw new Error('La tarea no pertenece a esta planificación.');
  const body = typeof text === 'string' ? text.trim() : '';
  if (!body || body.length > 4000) throw new Error('Escribe un comentario de hasta 4000 caracteres.');
  workspace.pendingComments = [...(workspace.pendingComments ?? []), { key: randomUUID(), id, text: body, createdAt: new Date().toISOString() }];
}
export function discardComment(workspace, key) {
  const before = workspace?.pendingComments?.length ?? 0;
  workspace.pendingComments = (workspace?.pendingComments ?? []).filter(c => c.key !== key);
  if (workspace.pendingComments.length === before) throw new Error('El comentario ya no está pendiente.');
}
export function discardLocal(workspace,id) {
  const ids=id===undefined ? workspace.items.filter(i=>i.localOnly).map(i=>i.id) : [id];
  if (ids.some(id=>workspace.creationAttempts?.[id])) throw new Error('Hay una creación enviada sin confirmar. Revisa y recupera su resultado antes de descartarla.');
  if (id<0 && workspace.items.some(i=>i.parent===id)) throw new Error('Descarta primero los elementos hijos nuevos.');
  workspace.items=workspace.items.filter(i=>!(i.localOnly && ids.includes(i.id)));
  // Comments on an item that will not be created go with it; discarding everything clears them.
  workspace.pendingComments=(workspace.pendingComments ?? []).filter(c=>id!==undefined && !(c.id<0 && ids.includes(c.id)));
  if(id===undefined){
    workspace.drafts={};workspace.conflicts={};workspace.capacityDrafts={};workspace.capacityConflicts={};
    // What remains is the project split recalculated from the imported data: keep Azure's.
    for(const plan of projectCapacityPlans(workspace).filter(allocationPending)) markAllocationDiscarded(workspace,plan);
  }
  else {delete workspace.drafts[id];delete workspace.conflicts[id];}
}
export function stageChanges(workspace, id, changes) {
  const item = workspace.items.find(i => i.id === id);
  if (!item) throw new Error('La tarea no pertenece a esta planificación.');
  if (workspace.creationAttempts?.[id]) throw new Error('Recupera primero el resultado de la creación enviada antes de editarla.');
  if (item.contextOnly) throw new Error('Este padre se ha importado solo como contexto.');
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw new Error('Indica algún cambio.');
  const current = { ...item, ...workspace.drafts[id] };
  const draft = { ...workspace.drafts[id] };
  for (const [field, value] of Object.entries(changes)) {
    if (!Object.hasOwn(FIELD_LABELS, field)) throw new Error('Campo no editable.');
    if (field === 'title' && (typeof value!=='string' || !value.trim() || value.length>255)) throw new Error('Indica un título válido.');
    if (workspace.sources && field === 'assignedTo' && value && !sourceFor(workspace,item).members.some(m=>identityKey(m)===value)) throw new Error('La persona debe pertenecer al equipo del proyecto de la tarea.');
    if (workspace.sources && field === 'iterationPath') remoteFields(workspace,item,{iterationPath:value});
    if (field === 'assignedTo' && (typeof value !== 'string' || (value !== '' && !workspace.members.some(m => identityKey(m) === value) && value !== item.assignedTo))) throw new Error('Elige una persona del equipo.');
    if (field === 'iterationPath' && ![workspace.settings.backlogIteration.path, ...workspace.iterations.map(i => i.path), item.iterationPath].includes(value)) throw new Error('Elige una iteración del equipo.');
    if (field === 'priority' && (!item.canPrioritize || !Number.isInteger(value) || value < 1 || value > 4)) throw new Error('La prioridad debe estar entre 1 y 4.');
    if (field === 'originalEstimate' && (!estimateFields(workspace,item).originalEstimate || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000)) throw new Error('Indica un número de horas válido para la estimación original.');
    if (field === 'remainingWork' && (!estimateFields(workspace,item).remainingWork || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000)) throw new Error('Indica un número de horas válido.');
    // The only state change is closing a task or bug with its type's completed state.
    if (field === 'state' && (typeof value !== 'string' || (value !== item.state && (!isExecutable(item) || !completedState(item,workspace) || value !== completedState(item,workspace))))) throw new Error('Solo se pueden marcar como completadas las tareas y bugs.');
    if (same(item[field], value)) delete draft[field]; else draft[field] = value;
  }
  // Moving a task whose owner has no capacity there (or is outside the team) is the
  // person's decision: the interface warns, the plan does not block it.
  if(workspace.sources) workspace.allocationIterations=[...new Set([...(workspace.allocationIterations ?? []),...workspace.iterations.filter(i=>i.path===item.iterationPath || i.path===draft.iterationPath).map(i=>i.id)])];
  if (item.localOnly) draft.title=changes.title ?? draft.title ?? item.title;
  if (Object.keys(draft).length) workspace.drafts[id] = draft; else delete workspace.drafts[id];
  delete workspace.conflicts[id];
}
export function planReview(workspace, remoteItems) {
  const remoteById = new Map(remoteItems.map(item => [item.id, item]));
  return Object.entries(workspace.drafts).filter(([id])=>Number(id)>0).map(([id, fields]) => {
    const base = workspace.items.find(item => item.id === Number(id));
    const remote = remoteById.get(Number(id));
    // A task that cannot be read is reported on its own and does not stop the rest.
    if (!remote) return { id: Number(id), title: base?.title ?? `#${id}`, remote: base, fields, updates: fields, conflicts: [], missing: true, changes: Object.entries(fields).map(([field, value]) => ({ field, label: FIELD_LABELS[field], before: base?.[field], original: base?.[field], after: value, conflict: false })) };
    const conflicts = Object.keys(fields).filter(key => !same(remote[key], base[key]) && !same(remote[key], fields[key]));
    const updates = Object.fromEntries(Object.entries(fields).filter(([key, value]) => !same(remote[key], value)));
    return { id: Number(id), title: base.title, remote, fields, updates, conflicts, changes: Object.entries(fields).map(([field, value]) => ({ field, label: FIELD_LABELS[field], before: remote[field], original: base[field], after: value, conflict: conflicts.includes(field) })) };
  });
}
export function resolveConflict(workspace, id, choice) {
  if (!workspace || !Number.isInteger(id) || id < 1) throw new Error('Tarea no válida.');
  const conflict = workspace.conflicts[id];
  if (!conflict) throw new Error('Revisa los cambios para obtener la versión actual de esta tarea.');
  if (!['remote', 'local'].includes(choice)) throw new Error('Resolución inválida.');
  const changes = { ...workspace.drafts[id] };
  workspace.items = workspace.items.map(i => i.id === id ? conflict.remote : i);
  delete workspace.drafts[id]; delete workspace.conflicts[id];
  if (choice === 'local' && Object.keys(changes).length) stageChanges(workspace, id, changes);
}
export function workingCapacity(iteration, capacity, memberId, workingDays = [1,2,3,4,5]) {
  const record = capacity?.teamMembers?.find(m => m.teamMember?.id === memberId);
  if (!record || !iteration.attributes?.startDate || !iteration.attributes?.finishDate) return null;
  const start = new Date(iteration.attributes.startDate.slice(0,10) + 'T00:00:00Z');
  const end = new Date(iteration.attributes.finishDate.slice(0,10) + 'T00:00:00Z');
  if (!Number.isFinite(+start) || !Number.isFinite(+end) || end < start || end - start > 366 * 86400000) return null;
  const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const days = workingDays.map(d => typeof d === 'number' ? d : dayMap[d.toLowerCase()]);
  const off = [...(capacity.daysOff ?? []), ...(record.daysOff ?? [])];
  let count = 0;
  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const key = date.toISOString().slice(0,10);
    if (days.includes(date.getUTCDay()) && !off.some(r => key >= r.start.slice(0,10) && key <= r.end.slice(0,10))) count++;
  }
  return Math.round(count * (record.activities ?? []).reduce((sum, a) => sum + (a.capacityPerDay ?? 0), 0) * 100) / 100;
}

// Capacity is staged like a work item: only what differs from the imported copy
// is kept, so undoing an edit leaves nothing pending. Each entry is keyed by the
// team member id, or by 'team' for the days off shared by the whole team.
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = value => value instanceof Date ? value.toISOString().slice(0,10) : typeof value === 'string' ? value.slice(0,10) : '';
const entryOf = value => ({
  activities: (value?.activities ?? []).map(a => ({ name: (a.name ?? '').trim(), capacityPerDay: Number(a.capacityPerDay ?? 0) })).sort((a, b) => a.name.localeCompare(b.name)),
  daysOff: (value?.daysOff ?? []).map(r => ({ start: dayOf(r.start), end: dayOf(r.end) })).sort((a, b) => a.start.localeCompare(b.start)),
});
export const sameCapacity = (a, b) => JSON.stringify(entryOf(a)) === JSON.stringify(entryOf(b));
export function capacityEntry(capacity, key) {
  return entryOf(key === 'team' ? { daysOff: capacity?.daysOff } : capacity?.teamMembers?.find(m => m.teamMember?.id === key));
}
function validActivities(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error('Indica hasta 20 actividades por persona.');
  const activities = value.map(activity => {
    const name = typeof activity?.name === 'string' ? activity.name.trim() : '';
    const hours = activity?.capacityPerDay;
    if (name.length > 128) throw new Error('El nombre de la actividad es demasiado largo.');
    if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > 24) throw new Error('Indica entre 0 y 24 horas por día.');
    return { name, capacityPerDay: Math.round(hours * 100) / 100 };
  });
  if (new Set(activities.map(a => a.name.toLowerCase())).size !== activities.length) throw new Error('No repitas la misma actividad.');
  return activities;
}
function validDaysOff(value, iteration) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Indica hasta 100 rangos de días libres.');
  const ranges = value.map(range => {
    const start = dayOf(range?.start), end = dayOf(range?.end);
    if (!DAY.test(start) || !DAY.test(end) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) throw new Error('Indica las fechas de los días libres con el formato AAAA-MM-DD.');
    if (end < start) throw new Error('El último día libre no puede ser anterior al primero.');
    return { start, end };
  }).sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < ranges.length; i++) if (ranges[i].start <= ranges[i-1].end) throw new Error('Los rangos de días libres no pueden solaparse.');
  // Azure only accepts days off inside the iteration, and days outside it would
  // not change the capacity either.
  const first = dayOf(iteration.attributes?.startDate), last = dayOf(iteration.attributes?.finishDate);
  if (DAY.test(first) && DAY.test(last) && ranges.some(r => r.start < first || r.end > last)) throw new Error(`Los días libres deben estar dentro de «${iteration.name}» (del ${first} al ${last}).`);
  return ranges;
}
export function stageCapacity(workspace, iterationId, change) {
  if (!workspace) throw new Error('Importa una planificación primero.');
  const iteration = workspace.iterations.find(i => i.id === iterationId);
  if (!iteration) throw new Error('Elige una iteración del equipo.');
  if(workspace.sources) workspace.allocationIterations=[...new Set([...(workspace.allocationIterations ?? []),iterationId])];
  const key = change?.key;
  if (key !== 'team' && !workspace.members.some(m => m.id === key)) throw new Error('Elige una persona del equipo.');
  if (!change || (change.activities === undefined && change.daysOff === undefined)) throw new Error('Indica algún cambio de capacidad.');
  const base = capacityEntry(workspace.capacities?.[iterationId], key);
  const current = workspace.capacityDrafts?.[iterationId]?.[key] ?? base;
  // Only what this change carries is validated: values kept from Azure or from
  // an earlier draft must not block an unrelated edit.
  const next = {
    activities: key === 'team' ? [] : change.activities === undefined ? entryOf(current).activities : validActivities(change.activities),
    daysOff: change.daysOff === undefined ? entryOf(current).daysOff : validDaysOff(change.daysOff, iteration),
  };
  workspace.capacityDrafts ??= {};
  const drafts = { ...workspace.capacityDrafts[iterationId] };
  if (sameCapacity(next, base)) delete drafts[key]; else drafts[key] = next;
  if (Object.keys(drafts).length) workspace.capacityDrafts[iterationId] = drafts; else delete workspace.capacityDrafts[iterationId];
  clearCapacityConflict(workspace, iterationId, key);
  clearDownloadedDifference(workspace, iterationId, key);
}
// After downloading capacity, each difference with what was local waits for a decision.
function clearDownloadedDifference(workspace, iterationId, key) {
  const download = workspace.capacityDownloads?.[iterationId];
  if (!download?.local?.[key]) return;
  delete download.local[key];
  if (!Object.keys(download.local).length) delete workspace.capacityDownloads[iterationId];
}
export function chooseDownloadedCapacity(workspace, iterationId, key, choice) {
  const mine = workspace?.capacityDownloads?.[iterationId]?.local?.[key];
  if (!mine) throw new Error('No hay diferencias de capacidad por validar para esta persona.');
  if (!['azure', 'local'].includes(choice)) throw new Error('Elige la capacidad de Azure DevOps o la local.');
  if (choice === 'local') stageCapacity(workspace, iterationId, { key, daysOff: mine.daysOff, ...(key === 'team' ? {} : { activities: mine.activities }) });
  clearDownloadedDifference(workspace, iterationId, key);
}
function clearCapacityConflict(workspace, iterationId, key) {
  const conflicts = workspace.capacityConflicts?.[iterationId];
  if (!conflicts) return;
  delete conflicts[key];
  if (!Object.keys(conflicts).length) delete workspace.capacityConflicts[iterationId];
}
export function discardCapacity(workspace, iterationId, key) {
  if (!workspace) throw new Error('No hay planificación.');
  if (iterationId === undefined) { workspace.capacityDrafts = {}; workspace.capacityConflicts = {}; return; }
  if (!workspace.iterations.some(i => i.id === iterationId)) throw new Error('Elige una iteración del equipo.');
  if (key === undefined) { delete workspace.capacityDrafts?.[iterationId]; delete workspace.capacityConflicts?.[iterationId]; return; }
  const drafts = workspace.capacityDrafts?.[iterationId];
  if (!drafts?.[key]) throw new Error('No hay cambios de capacidad pendientes para esta persona.');
  delete drafts[key];
  if (!Object.keys(drafts).length) delete workspace.capacityDrafts[iterationId];
  clearCapacityConflict(workspace, iterationId, key);
}
export function capacityChanges(workspace) {
  if (workspace?.sources) return projectCapacityPlans(workspace).filter(allocationPending);
  return Object.entries(workspace?.capacityDrafts ?? {}).flatMap(([iterationId, drafts]) => Object.entries(drafts).map(([key, entry]) => ({ iterationId, key, entry })));
}
export function effectiveCapacity(workspace, iterationId) {
  const base = workspace.capacities?.[iterationId] ?? {};
  const drafts = workspace.capacityDrafts?.[iterationId];
  if (!drafts) return base;
  const teamMembers = (base.teamMembers ?? []).map(record => drafts[record.teamMember?.id] ? { ...record, ...drafts[record.teamMember.id] } : record);
  for (const [key, entry] of Object.entries(drafts)) {
    // A person without capacity in Azure has no record to edit until now.
    if (key === 'team' || teamMembers.some(record => record.teamMember?.id === key)) continue;
    const member = workspace.members.find(m => m.id === key);
    teamMembers.push({ teamMember: { id: key, displayName: member?.displayName, uniqueName: member?.uniqueName }, ...entry });
  }
  return { ...base, teamMembers, daysOff: drafts.team?.daysOff ?? base.daysOff ?? [] };
}
export function planCapacityReview(workspace, remotes) {
  return capacityChanges(workspace).map(({ iterationId, key, entry }) => {
    const remote = capacityEntry(remotes?.[iterationId], key), original = capacityEntry(workspace.capacities?.[iterationId], key);
    return {
      iterationId, key, iteration: workspace.iterations.find(i => i.id === iterationId)?.name ?? iterationId,
      label: key === 'team' ? 'Días libres del equipo' : workspace.members.find(m => m.id === key)?.displayName ?? key,
      remote, original, after: entry,
      conflict: !sameCapacity(remote, original) && !sameCapacity(remote, entry),
      applied: sameCapacity(remote, entry),
    };
  });
}
export function applyCapacity(workspace, iterationId, key, entry) {
  workspace.capacities ??= {};
  const capacity = { teamMembers: [], daysOff: [], ...workspace.capacities[iterationId] };
  if (key === 'team') capacity.daysOff = entry.daysOff;
  else {
    const record = capacity.teamMembers.find(m => m.teamMember?.id === key);
    const member = workspace.members.find(m => m.id === key);
    if (record) Object.assign(record, { activities: entry.activities, daysOff: entry.daysOff });
    else capacity.teamMembers = [...capacity.teamMembers, { teamMember: { id: key, displayName: member?.displayName, uniqueName: member?.uniqueName }, ...entry }];
  }
  workspace.capacities[iterationId] = capacity;
  const drafts = workspace.capacityDrafts?.[iterationId];
  if (drafts) { delete drafts[key]; if (!Object.keys(drafts).length) delete workspace.capacityDrafts[iterationId]; }
  clearCapacityConflict(workspace, iterationId, key);
}
export function resolveCapacityConflict(workspace, iterationId, key, choice) {
  const remote = workspace?.capacityConflicts?.[iterationId]?.[key];
  if (!remote) throw new Error('Revisa los cambios para obtener la capacidad actual de Azure DevOps.');
  if (!['remote', 'local'].includes(choice)) throw new Error('Resolución inválida.');
  const mine = workspace.capacityDrafts?.[iterationId]?.[key];
  applyCapacity(workspace, iterationId, key, remote);
  if (choice === 'local' && mine) stageCapacity(workspace, iterationId, { key, ...mine });
}

// A project split is derived, not a draft: discarding it records the value that was
// proposed, so Azure's value is kept until something changes the split again.
const allocationKey = plan => JSON.stringify([plan.sourceId, plan.remoteIterationId, plan.key]);
export const allocationPending = plan => !plan.discarded && !sameCapacity(plan.original, plan.entry);
function markAllocationDiscarded(workspace, plan) {
  workspace.allocationDiscards = { ...workspace.allocationDiscards, [allocationKey(plan)]: plan.entry };
}
export function discardAllocation(workspace, sourceId, iterationId, key) {
  const plan = projectCapacityPlans(workspace ?? {}).find(p => p.sourceId === sourceId && p.iterationId === iterationId && p.key === key);
  if (!plan || !allocationPending(plan)) throw new Error('No hay cambios de capacidad pendientes para esta persona en ese proyecto.');
  markAllocationDiscarded(workspace, plan);
}
// Allocate the single availability budget by estimated work, including zeroing
// old project allocations when the person no longer has tasks there.
export function projectCapacityPlans(workspace) {
  if (!workspace.sources) return [];
  const plans=[];
  // Assigned tasks are grouped once by iteration and person instead of being
  // filtered again for every pair: large backlogs stay fast to recalculate.
  const assigned=new Map();
  for (const item of effectiveItems(workspace)) {
    if (!isExecutable(item) || !item.assignedTo) continue;
    if (!assigned.has(item.iterationPath)) assigned.set(item.iterationPath,new Map());
    const people=assigned.get(item.iterationPath);
    if (!people.has(item.assignedTo)) people.set(item.assignedTo,[]);
    people.get(item.assignedTo).push(item);
  }
  for (const iteration of workspace.iterations.filter(i=>(workspace.allocationIterations ?? []).includes(i.id) || assigned.has(i.path))) {
    const capacity=effectiveCapacity(workspace,iteration.id);
    for (const member of workspace.members) {
    const global=capacityEntry(capacity,member.id);
    const available=workingCapacity(iteration,capacity,member.id,workspace.settings.workingDays) ?? 0;
    const tasks=available===0 ? [] : assigned.get(iteration.path)?.get(identityKey(member)) ?? [];
    const total=tasks.reduce((sum,i)=>sum+(i.remainingWork ?? 0),0);
    const destinations=workspace.sources.filter(s=>iteration.sourceIterations[s.id] && s.members.some(m=>m.id===member.id));
    const offDates=new Set();
    for(const range of [...global.daysOff,...(capacity.daysOff ?? [])]) for(let date=new Date(range.start.slice(0,10)+'T00:00:00Z');date.toISOString().slice(0,10)<=range.end.slice(0,10);date.setUTCDate(date.getUTCDate()+1)) offDates.add(date.toISOString().slice(0,10));
    const daysOff=[...offDates].sort().map(date=>({start:date,end:date}));
    const globalDaily=global.activities.reduce((sum,a)=>sum+a.capacityPerDay,0);
    for (const source of destinations) {
      const remoteIterationId=iteration.sourceIterations[source.id], remoteIteration=source.iterations.find(i=>i.id===remoteIterationId);
      const hours=tasks.filter(i=>i.sourceId===source.id).reduce((sum,i)=>sum+(i.remainingWork ?? 0),0), ratio=total ? hours/total : 0;
      const original=capacityEntry(source.capacities?.[remoteIterationId],member.id);
      const unit={daysOff:source.capacities?.[remoteIterationId]?.daysOff ?? [],teamMembers:[{teamMember:member,activities:[{name:'',capacityPerDay:1}],daysOff}]};
      const days=workingCapacity(remoteIteration,unit,member.id,source.settings.workingDays) ?? 0;
      const entry={daysOff,activities:global.activities.map(a=>({name:a.name,capacityPerDay:Math.round((days && globalDaily ? available*ratio/days*a.capacityPerDay/globalDaily : 0)*100)/100}))};
      const kept=workspace.allocationDiscards?.[allocationKey({sourceId:source.id,remoteIterationId,key:member.id})], discarded=!!kept && sameCapacity(kept,entry);
      plans.push({discarded,iterationId:iteration.id,remoteIterationId,sourceId:source.id,config:source.config,key:member.id,entry,original,iteration:`${source.config.project} · ${remoteIteration.name}`,label:member.displayName,hours,ratio,available,allocated:Math.round(days*entry.activities.reduce((n,a)=>n+a.capacityPerDay,0)*100)/100,missingEstimate:tasks.some(i=>i.remainingWork==null),unavailable:hours>0 && !days});
    }
    }
  }
  return plans;
}

export function planningWorkspace(workspace) {
  const capacities = Object.fromEntries(workspace.iterations.map(i => [i.id, effectiveCapacity(workspace, i.id)]));
  const projectAllocations = projectCapacityPlans(workspace);
  // The same count the review uses, so the interface never offers an empty review.
  const capacityPending = workspace.sources ? projectAllocations.filter(allocationPending).length : Object.values(workspace.capacityDrafts ?? {}).reduce((sum, drafts) => sum + Object.keys(drafts).length, 0);
  const capacityPendingByIteration = {};
  if (workspace.sources) for (const plan of projectAllocations.filter(allocationPending)) capacityPendingByIteration[plan.iterationId] = (capacityPendingByIteration[plan.iterationId] ?? 0) + 1;
  else for (const [iterationId, drafts] of Object.entries(workspace.capacityDrafts ?? {})) capacityPendingByIteration[iterationId] = Object.keys(drafts).length;
  return {...workspace,projectAllocations,capacityPendingByIteration,pendingChanges:Object.keys(workspace.drafts ?? {}).length+capacityPending+(workspace.pendingComments?.length ?? 0),capacityPending,effectiveItems:effectiveItems(workspace),effectiveCapacities:capacities,capacityHours:Object.fromEntries(workspace.iterations.map(i=>[i.id,Object.fromEntries(workspace.members.map(m=>[m.id,workingCapacity(i,capacities[i.id],m.id,workspace.settings.workingDays)]))]))};
}

// The person planning decides which state closes each type of task. Tasks
// already marked with a previous choice move to the new one.
export function setCompletedState(workspace, type, state, sourceId) {
  if(workspace?.sources) {
    const source=workspace.sources.find(s=>s.id===sourceId);
    if(!source) throw new Error('Elige el proyecto cuyo estado completado quieres configurar.');
    const scoped={...workspace,sources:undefined,items:workspace.items.filter(i=>i.sourceId===sourceId),completedStates:source.completedStates};
    setCompletedState(scoped,type,state);source.completedStates=scoped.completedStates;return;
  }
  if (!workspace?.items.some(i => i.type === type && isExecutable(i))) throw new Error('Elige un tipo de tarea o bug de esta planificación.');
  const name = typeof state === 'string' ? state.trim() : '';
  if (!name || name.length > 128) throw new Error('Indica el estado que se considera completado.');
  const previous = workspace.completedStates?.[type];
  workspace.completedStates = { ...workspace.completedStates, [type]: name };
  if (!previous || previous === name) return;
  for (const [id, draft] of Object.entries(workspace.drafts)) {
    const item = workspace.items.find(i => i.id === Number(id));
    if (item?.type === type && draft.state === previous) stageChanges(workspace, item.id, { state: name });
  }
}
export function completeTask(workspace, id) {
  const item = workspace && effectiveItems(workspace).find(i => i.id === id);
  if (!item || !isExecutable(item)) throw new Error('Solo se pueden marcar como completadas las tareas y bugs.');
  if (!completedState(item,workspace)) throw new Error(`Indica primero qué estado de «${item.type}» se considera completado.`);
  stageChanges(workspace, id, { state: completedState(item,workspace) });
}

export class Planner {
  constructor(store, azure) { this.store = store; this.azure = azure; this.review = null; }
  workspace() { return this.store.data[this.store.data.mode]; }
  async readItems(workspace,ids) {
    if (!workspace.sources) return this.azure.getItems(workspace.config,ids);
    const result=[];
    for (const source of workspace.sources) {
      const own=ids.filter(id=>sourceFor(workspace,workspace.items.find(i=>i.id===id)).id===source.id);
      if(own.length) result.push(...(await this.azure.getItems(source.config,own)).map(i=>planningItem(workspace,i,source)));
    }
    return result;
  }
  async prepareReview() {
    const workspace = this.workspace();
    if (!workspace) throw new Error('Importa una planificación primero.');
    const ids = Object.keys(workspace.drafts).map(Number);
    const creations=effectiveItems(workspace).filter(i=>i.localOnly).sort((a,b)=>b.id-a.id);
    const capacityIterations = [...new Set([...capacityChanges(workspace).map(change => change.iterationId),...Object.keys(workspace.capacityDrafts ?? {})])];
    const comments = (workspace.pendingComments ?? []).map(c => ({ ...c, title: effectiveItems(workspace).find(i => i.id === c.id)?.title ?? `#${c.id}` }));
    if (!ids.length && !capacityIterations.length && !comments.length) throw new Error('No hay cambios pendientes.');
    if (workspace.mode === 'azure') await this.azure.open(workspace.config);
    // Local is the source of truth: only edited tasks are read, to show what changes.
    // If Azure cannot be read, the local copy stands in, but those writes are
    // guarded by the imported revision: nothing changed since then is overwritten
    // without having been shown in a review.
    const unreadable = [];
    const remoteItems = workspace.mode === 'demo' ? workspace.items : await this.readItems(workspace, ids.filter(id=>id>0)).catch(error => { unreadable.push(`Tareas: ${error.message}`); return workspace.items.filter(i => ids.includes(i.id)); });
    const plans = planReview(workspace, remoteItems);
    if (unreadable.length) for (const plan of plans) if (!plan.missing) plan.unverified = true;
    for(const item of creations) plans.push({id:item.id,title:item.title,creation:true,item,conflicts:[],updates:{title:item.title},changes:['type','title','parent','assignedTo','iterationPath','originalEstimate','remainingWork'].map(field=>({field,label:FIELD_LABELS[field] || ({type:'Tipo',parent:'Padre'})[field],before:null,after:item[field]}))});
    if (workspace.mode === 'azure') for (const plan of plans.filter(p => p.creation && !workspace.creationAttempts?.[p.id])) await this.validateCreation(workspace, plan);
    const { capacityPlans, incompleteAllocations } = await this.reviewCapacity(workspace, unreadable);
    const data = structuredClone(this.store.data);
    data[data.mode].conflicts = Object.fromEntries(plans.filter(p => p.conflicts.length).map(p => [p.id, p]));
    data[data.mode].capacityConflicts = capacityPlans.filter(p => p.conflict).reduce((all, plan) => ({ ...all, [plan.iterationId]: { ...all[plan.iterationId], [plan.key]: plan.remote } }), {});
    await this.store.save(data);
    this.review = { token: randomUUID(), version: this.store.data.version, mode: workspace.mode, plans, capacityPlans, comments, incompleteAllocations, unreadable: unreadable.map(text => text.slice(0, 300)) };
    // Conflicts are informative: synchronizing keeps the local version.
    return { ...this.review };
  }
  // Azure checks the creation without saving it. A missing required description is
  // offered to be written in the review; any other rule is shown as a warning.
  async validateCreation(workspace, plan) {
    const item = plan.item;
    try {
      const config = sourceFor(workspace, item).config;
      const remoteItem = { ...item, ...remoteFields(workspace, item, { iterationPath: item.iterationPath }), parent: item.parent > 0 ? item.parent : null };
      if (item.copyFrom) remoteItem.texts = await this.azure.itemTexts(config, item.copyFrom);
      await this.azure.create(config, remoteItem, true);
    } catch (error) {
      const field = requiredDescription(error.message);
      if (field) plan.needsDescription = { field, label: DESCRIPTION_FIELDS[field] };
      else plan.validationError = String(error.message).slice(0, 300);
    }
  }
  // Capacity changes compared with Azure, for every iteration or only one.
  async reviewCapacity(workspace, unreadable, iterationId) {
    const capacityIterations = [...new Set([...capacityChanges(workspace).map(change => change.iterationId),...Object.keys(workspace.capacityDrafts ?? {})])];
    const remoteCapacities = {};
    let capacityPlans, incompleteAllocations=[];
    if (workspace.sources) {
      const allocations=projectCapacityPlans(workspace);
      // Incomplete estimates or capacity do not block the sync: unestimated work counts
      // as 0 h and the split is corrected in a later sync once it is defined.
      incompleteAllocations=allocations.filter(p=>p.missingEstimate || p.unavailable).map(p=>({label:p.label,iteration:p.iteration,missingEstimate:p.missingEstimate,unavailable:p.unavailable}));
      capacityPlans=[];
      for (const plan of allocations.filter(p=>allocationPending(p) && (!iterationId || p.iterationId===iterationId))) {
        const cacheKey=JSON.stringify([plan.sourceId,plan.remoteIterationId]);
        // A capacity that cannot be read does not stop the review: the local copy
        // stands in and Azure is read again just before writing it.
        if (!(cacheKey in remoteCapacities)) remoteCapacities[cacheKey] = await this.azure.capacity(plan.config,plan.remoteIterationId).catch(error => { unreadable.push(`Capacidad de ${plan.iteration}: ${error.message}`); return null; });
        const teamDaysOff=capacityEntry(remoteCapacities[cacheKey],'team');
        const unverified=!remoteCapacities[cacheKey];
        const remote=unverified ? plan.original : capacityEntry(remoteCapacities[cacheKey],plan.key);
        capacityPlans.push({...plan,teamDaysOff,remote,after:plan.entry,unverified,conflict:!sameCapacity(remote,plan.original) && !sameCapacity(remote,plan.entry),applied:!unverified && sameCapacity(remote,plan.entry)});
      }
    } else {
      const unverified = new Set();
      for (const id of capacityIterations.filter(id => !iterationId || id === iterationId)) remoteCapacities[id] = workspace.mode === 'demo' ? workspace.capacities?.[id] : await this.azure.capacity(workspace.config, id).catch(error => {
        unverified.add(id);
        unreadable.push(`Capacidad de ${workspace.iterations.find(i => i.id === id)?.name ?? id}: ${error.message}`);
        return workspace.capacities?.[id];
      });
      capacityPlans = planCapacityReview(workspace, remoteCapacities).filter(plan => !iterationId || plan.iterationId === iterationId).map(plan => unverified.has(plan.iterationId) ? { ...plan, unverified: true, applied: false } : plan);
    }
    return { capacityPlans, incompleteAllocations };
  }
  // Uploads one iteration's capacity without a full review. A value someone changed
  // in Azure since the import is not overwritten: it is left as a conflict to decide.
  async uploadCapacity(iterationId) {
    const workspace = this.workspace();
    if (!workspace) throw new Error('Importa una planificación primero.');
    if (!workspace.iterations.some(i => i.id === iterationId)) throw new Error('Elige una iteración del equipo.');
    if (workspace.mode === 'azure') await this.azure.open(workspace.config);
    const { capacityPlans } = await this.reviewCapacity(workspace, [], iterationId);
    if (!capacityPlans.length) throw new Error('No hay cambios de capacidad pendientes en esta iteración.');
    const conflicts = capacityPlans.filter(plan => plan.conflict);
    const result = await this.syncCapacity({ capacityPlans: capacityPlans.filter(plan => !plan.conflict), scope: iterationId }, workspace);
    if (conflicts.length) {
      const data = structuredClone(this.store.data), next = data[data.mode];
      next.capacityConflicts ??= {};
      for (const plan of conflicts) next.capacityConflicts[plan.iterationId] = { ...next.capacityConflicts[plan.iterationId], [plan.key]: plan.remote };
      await this.store.save(data);
    }
    this.review = null;
    return { ...result, conflicts: conflicts.map(plan => `${plan.iteration} · ${plan.label}`) };
  }
  async sync(token) {
    const review = this.review;
    if (!review || !token || review.token !== token || review.version !== this.store.data.version) throw new Error('La revisión ha caducado. Revisa los cambios de nuevo.');
    this.review = null;
    const workspace = this.workspace();
    if (workspace.mode === 'azure') await this.azure.open(workspace.config);
    const successes = [], failures = [];
    const remapped=new Map();
    for (const plan of review.plans) {
      if(plan.creation) {
        try {
          const item={...plan.item,parent:remapped.get(plan.item.parent) || plan.item.parent};
          const origin=sourceFor(workspace,item), config=origin.config;
          const remoteItem={...item,...remoteFields(workspace,item,{iterationPath:item.iterationPath})};
          if(item.parent<0) throw new Error('El padre sigue pendiente de creación.');
          if(workspace.mode!=='demo' && item.copyFrom) remoteItem.texts=await this.azure.itemTexts(config,item.copyFrom);
          let updated;
          if(workspace.mode==='demo') updated={...item,id:Math.max(0,...this.workspace().items.map(i=>i.id))+1,rev:1};
          else {
            updated=await this.azure.findCreation(config,item.creationKey);
            // An uncertain earlier send is searched again (Azure may index it late) before sending it again.
            for(let check=0;!updated && this.workspace().creationAttempts?.[plan.id] && check<3;check++) {await new Promise(resolve=>setTimeout(resolve,this.retryDelay ?? 3000));updated=await this.azure.findCreation(config,item.creationKey);}
            if(!updated) {
              await this.azure.create(config,remoteItem,true);
              const attempt=structuredClone(this.store.data);attempt[attempt.mode].creationAttempts ??= {};attempt[attempt.mode].creationAttempts[plan.id]=item;await this.store.save(attempt);
              updated=await this.azure.create(config,remoteItem,false);
            }
          }
          if(updated) updated=planningItem(workspace,updated,origin);
          if(!updated || updated.id<1) throw new Error('La creación remota difiere del borrador. Se conserva para revisar sin sobrescribir Azure.');
          delete updated.localOnly;delete updated.creationKey;delete updated.modified;
          const data=structuredClone(this.store.data),next=data[data.mode];
          next.items=next.items.map(i=>i.id===plan.id ? updated : i.parent===plan.id ? {...i,parent:updated.id} : i);
          delete next.drafts[plan.id];delete next.conflicts[plan.id];delete next.creationAttempts?.[plan.id];next.lastSyncedAt=new Date().toISOString();
          await this.store.save(data);remapped.set(plan.id,updated.id);successes.push(updated.id);
        } catch(error) {failures.push({id:plan.id,error:error.message});}
        continue;
      }
      if (plan.missing) { failures.push({ id: plan.id, error: 'No se pudo leer esta tarea en Azure DevOps. Comprueba que existe y vuelve a sincronizar.' }); continue; }
      let updated;
      try {
        updated = workspace.mode === 'demo' ? { ...plan.remote, ...plan.fields, rev: plan.remote.rev + 1 }
          // A reviewed task keeps the local version; one that could not be read is
          // only written if Azure still has the revision of the local copy.
          : Object.keys(plan.updates).length ? planningItem(workspace, await this.azure.update(sourceFor(workspace,plan.remote).config, plan.id, plan.unverified ? plan.remote.rev : null, remoteFields(workspace,plan.remote,plan.updates)), sourceFor(workspace,plan.remote)) : plan.remote;
      } catch (error) { failures.push({ id: plan.id, error: error.message }); continue; }
      const data = structuredClone(this.store.data), next = data[data.mode];
      next.items = next.items.map(i => i.id === plan.id ? updated : i);
      delete next.drafts[plan.id]; delete next.conflicts[plan.id];
      next.lastSyncedAt = new Date().toISOString();
      // Persist each acknowledgement. If this fails, stop; a subsequent review
      // reconciles already-applied fields without replaying the write.
      await this.store.save(data);
      successes.push(plan.id);
    }
    const capacity = await this.syncCapacity(review, workspace);
    const comments = await this.syncComments(review, workspace, remapped);
    return { successes, failures, capacity, comments, demo: workspace.mode === 'demo' };
  }
  // Each reviewed comment is published once, after the task it belongs to exists.
  // A failed one stays pending; it is never repeated automatically.
  async syncComments(review, workspace, remapped) {
    const successes = [], failures = [];
    for (const comment of review.comments ?? []) {
      const id = remapped.get(comment.id) ?? comment.id;
      try {
        if (id < 1) throw new Error('La tarea todavía no existe en Azure DevOps.');
        const item = this.workspace().items.find(i => i.id === id);
        if (workspace.mode !== 'demo') await this.azure.addComment(sourceFor(this.workspace(), item).config, id, comment.text);
        const data = structuredClone(this.store.data), next = data[data.mode];
        next.pendingComments = (next.pendingComments ?? []).filter(c => c.key !== comment.key);
        await this.store.save(data);
        successes.push(id);
      } catch (error) { failures.push({ id, error: error.message }); }
    }
    return { successes, failures };
  }
  // Local capacity is the source of truth: each reviewed value is written as it
  // is. A value whose Azure version could not be read during the review is read
  // again first: a change nobody has reviewed is not overwritten. If Azure still
  // cannot be read, the local value is written as before.
  async syncCapacity(review, workspace) {
    const successes = [], failures = [];
    const byIteration = new Map();
    for (const plan of review.capacityPlans ?? []) byIteration.set(JSON.stringify([plan.sourceId,plan.iterationId]), [...(byIteration.get(JSON.stringify([plan.sourceId,plan.iterationId])) ?? []), plan]);
    for (const [, plans] of byIteration) {
      const iterationId=plans[0].remoteIterationId ?? plans[0].iterationId, config=plans[0].config ?? workspace.config;
      let current;
      for (const plan of plans) {
        try {
          let applied = plan.applied;
          if (workspace.mode !== 'demo' && !applied && plan.unverified) {
            if (current === undefined) current = await this.azure.capacity(config, iterationId).catch(() => null);
            if (current) {
              const now = capacityEntry(current, plan.key);
              applied = sameCapacity(now, plan.after);
              if (!applied && !sameCapacity(now, plan.original)) throw new Error('Ha cambiado en Azure DevOps y no se pudo comparar durante la revisión. No se ha modificado: vuelve a revisar los cambios.');
            }
          }
          if (workspace.mode !== 'demo' && !applied) {
            if (plan.key === 'team') await this.azure.updateTeamDaysOff(config, iterationId, plan.after.daysOff);
            else await this.azure.updateMemberCapacity(config, iterationId, plan.key, plan.after.activities, plan.after.daysOff);
          }
          const data = structuredClone(this.store.data), next = data[data.mode];
          if (plan.sourceId) {
            const source=next.sources.find(s=>s.id===plan.sourceId);
            applyCapacity(source,iterationId,plan.key,plan.after);
          } else applyCapacity(next, iterationId, plan.key, plan.after);
          next.lastSyncedAt = new Date().toISOString();
          await this.store.save(data);
          successes.push(`${plan.iteration} · ${plan.label}`);
        } catch (error) { failures.push({ label: `${plan.iteration} · ${plan.label}`, error: error.message }); }
      }
    }
    if (workspace.sources && !failures.length) {
      const data=structuredClone(this.store.data), next=data[data.mode];
      // An upload of one iteration leaves the drafts of the others untouched.
      for (const iteration of next.iterations.filter(i=>!review.scope || i.id===review.scope)) {
        next.capacities[iteration.id]=effectiveCapacity(next,iteration.id);
        delete next.capacityDrafts?.[iteration.id]; delete next.capacityConflicts?.[iteration.id];
      }
      await this.store.save(data);
    }
    return { successes, failures };
  }
}
