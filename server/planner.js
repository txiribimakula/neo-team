import { sourcesOf, sourceFor, planningItem, remoteFields } from './multi-project.js';
import { randomUUID } from 'node:crypto';
import { eligibleTasks, isExecutable, completedState, hierarchy, ancestors, participantSources, personPlanningStatus } from '../dist/hierarchy.js';

export const FIELD_LABELS = { title: 'Título', assignedTo: 'Responsable', iterationPath: 'Iteración', priority: 'Prioridad', remainingWork: 'Horas pendientes', state: 'Estado' };
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
    points: f['Microsoft.VSTS.Scheduling.StoryPoints'] ?? f['Microsoft.VSTS.Scheduling.Effort'] ?? f['Microsoft.VSTS.Scheduling.Size'] ?? null,
    canEstimateHours: 'Microsoft.VSTS.Scheduling.RemainingWork' in f || f['System.WorkItemType'] === 'Task',
    canPrioritize: 'Microsoft.VSTS.Common.Priority' in f,
    tags: (f['System.Tags'] || '').split(';').map(s => s.trim()).filter(Boolean),
    parent: f['System.Parent'] || Number(raw.relations?.find(r => r.rel === 'System.LinkTypes.Hierarchy-Reverse')?.url?.split('/').at(-1)) || null,
  };
}
export const same = (a, b) => (a ?? null) === (b ?? null);
export const effectiveItems = workspace => workspace.items.map(item => ({ ...item, ...workspace.drafts[item.id], modified: !!workspace.drafts[item.id] || !!item.localOnly }));
export function createLocalItem(workspace, input) {
  if (!workspace) throw new Error('Importa una planificación primero.');
  const types=['Epic','Feature','User Story','Task','Bug'];
  if (!types.includes(input.type) || typeof input.title!=='string' || !input.title.trim() || input.title.trim().length>255) throw new Error('Indica un tipo y un título válido (máximo 255 caracteres).');
  const parent=input.parent ? workspace.items.find(i=>i.id===input.parent) : null;
  const allowed={Epic:[],Feature:['Epic'],'User Story':['Feature'],Task:['User Story','Product Backlog Item','Requirement'],Bug:['User Story','Product Backlog Item','Requirement']};
  if (input.parent && (!parent || !allowed[input.type].includes(parent.type))) throw new Error('El padre no corresponde a este nivel de jerarquía.');
  if (input.type!=='Epic' && !parent) throw new Error('Elige un padre para mantener la jerarquía.');
  const id=Math.min(0,...workspace.items.map(i=>i.id),workspace.nextLocalId || 0)-1;
  const origin=workspace.sources ? (parent ? sourceFor(workspace,parent) : workspace.sources.find(s=>s.id===input.sourceId)) : null;
  if(workspace.sources && !origin) throw new Error('Elige el proyecto del nuevo elemento.');
  const item={...(origin ? {sourceId:origin.id,project:origin.config.project} : {}),id,rev:0,localOnly:true,creationKey:randomUUID(),title:input.title.trim(),type:input.type,parent:parent?.id || null,state:'New',assignedTo:'',iterationPath:workspace.settings.backlogIteration.path,areaPath:parent?.areaPath || origin?.settings.defaultValue || origin?.config.project || workspace.settings.defaultValue || workspace.settings.areaPaths?.[0]?.value || workspace.config.project,remainingWork:null,priority:2,points:null,tags:[],canEstimateHours:['Task','Bug'].includes(input.type),canPrioritize:true};
  workspace.items.push(item);workspace.nextLocalId=id;
  stageChanges(workspace,id,{title:item.title,...(input.assignedTo ? {assignedTo:input.assignedTo} : {}),...(input.iterationPath ? {iterationPath:input.iterationPath} : {}),...(input.remainingWork!==undefined ? {remainingWork:input.remainingWork} : {})});
  return id;
}
export function discardLocal(workspace,id) {
  const ids=id===undefined ? workspace.items.filter(i=>i.localOnly).map(i=>i.id) : [id];
  if (ids.some(id=>workspace.creationAttempts?.[id])) throw new Error('Hay una creación enviada sin confirmar. Revisa y recupera su resultado antes de descartarla.');
  if (id<0 && workspace.items.some(i=>i.parent===id)) throw new Error('Descarta primero los elementos hijos nuevos.');
  workspace.items=workspace.items.filter(i=>!(i.localOnly && ids.includes(i.id)));
  if(id===undefined){workspace.drafts={};workspace.conflicts={};workspace.capacityDrafts={};workspace.capacityConflicts={};}
  else {delete workspace.drafts[id];delete workspace.conflicts[id];}
  for(const localId of ids) if(localId<0){delete workspace.participants?.[localId];delete workspace.participantExclusions?.[localId];}
}
export function setParticipants(workspace, assignments, iterationId) {
  if (!workspace || !Array.isArray(assignments) || !assignments.length || assignments.length > 200) throw new Error('Reparto no válido.');
  const next = { ...workspace.participants };
  for (const assignment of assignments) {
    if (!workspace.items.some(i=>i.id === assignment.id)) throw new Error('El elemento no pertenece a este backlog.');
    if (!Array.isArray(assignment.members) || assignment.members.some(key=>!workspace.members.some(m=>identityKey(m) === key))) throw new Error('Elige integrantes de este equipo.');
    if (iterationId && assignment.members.some(member=>!memberHasCapacity(workspace,member,iterationId))) throw new Error('Las personas con capacidad 0 quedan fuera del reparto de esta iteración.');
    const keys = [...new Set(assignment.members)];
    if (keys.length) next[assignment.id] = keys; else delete next[assignment.id];
  }
  workspace.participants = next;
}
export function planTasks(workspace, member, ids, iterationId) {
  if (!workspace || !workspace.members.some(m=>identityKey(m) === member)) throw new Error('Elige una persona del equipo.');
  const iteration = workspace.iterations.find(i=>i.id === iterationId);
  if (!iteration) throw new Error('Elige una iteración del equipo.');
  if (!memberHasCapacity(workspace,member,iterationId)) throw new Error('Esta persona tiene capacidad 0 y queda fuera del reparto de esta iteración.');
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length) throw new Error('Selecciona entre 1 y 200 tareas distintas.');
  const eligible = new Map(eligibleTasks(planningWorkspace(workspace),member,iterationId).map(i=>[i.id,i]));
  for (const id of ids) {
    const item = eligible.get(id);
    if (!item || !isExecutable(item)) throw new Error(`La tarea #${id} no forma parte del trabajo de esta persona.`);
    if (item.assignedTo && item.assignedTo !== member) throw new Error(`La tarea #${id} ya tiene otro responsable. Abre su ficha para reasignarla expresamente.`);
  }
  for (const id of ids) stageChanges(workspace,id,{assignedTo:member,iterationPath:iteration.path});
}
export function selectTasks(workspace, member, ids, iterationId, selected) {
  if (typeof selected!=='boolean') throw new Error('Selección no válida.');
  if (selected) {planTasks(workspace,member,ids,iterationId);return;}
  if (!workspace || !workspace.members.some(m=>identityKey(m)===member)) throw new Error('Elige una persona del equipo.');
  const iteration=workspace.iterations.find(i=>i.id===iterationId);
  if (!iteration || !Array.isArray(ids) || !ids.length || ids.length>200 || new Set(ids).size!==ids.length) throw new Error('Selección no válida.');
  const items=effectiveItems(workspace),tree=hierarchy(items);
  const tasks=ids.map(id=>items.find(i=>i.id===id));
  for (const item of tasks) if (!item || !isExecutable(item) || item.assignedTo!==member || item.iterationPath!==iteration.path) throw new Error('Solo puedes desmarcar tareas de esta persona en esta iteración.');
  for (const item of tasks) {
    // Retain eligibility for a task that was available only through AssignedTo,
    // so unchecking it does not make it disappear from the person's choices.
    const unassigned={...item,assignedTo:''};
    if (!participantSources(unassigned,workspace,tree).has(member)) {
      workspace.participants ??= {};
      workspace.participants[item.id]=[...new Set([...(workspace.participants[item.id] || []),member])];
      if(workspace.participantExclusions?.[item.id]) workspace.participantExclusions[item.id]=workspace.participantExclusions[item.id].filter(m=>m!==member);
    }
    stageChanges(workspace,item.id,{assignedTo:'',iterationPath:workspace.settings.backlogIteration.path});
  }
}
export function toggleParticipation(workspace,id,member,selected,iterationId) {
  if (!workspace || !workspace.items.some(i=>i.id===id) || !workspace.members.some(m=>identityKey(m)===member) || typeof selected!=='boolean') throw new Error('Reparto no válido.');
  const iteration=workspace.iterations.find(i=>i.id===iterationId);
  if (iterationId && !iteration) throw new Error('Iteración no válida.');
  if(selected && iterationId && !memberHasCapacity(workspace,member,iterationId)) throw new Error('Esta persona tiene capacidad 0 y queda fuera del reparto de esta iteración.');
  workspace.participants ??= {}; workspace.participantExclusions ??= {};
  if(selected) {
    workspace.participants[id]=[...new Set([...(workspace.participants[id] || []),member])];
    workspace.participantExclusions[id]=(workspace.participantExclusions[id] || []).filter(m=>m!==member);
    return;
  }
  const items=effectiveItems(workspace),tree=hierarchy(items);
  const branch=items.filter(item=>item.id===id || ancestors(item.id,tree).some(p=>p.id===id));
  for (const item of branch) {
    if(workspace.participants[item.id]) workspace.participants[item.id]=workspace.participants[item.id].filter(m=>m!==member);
    if(iteration && isExecutable(item) && item.assignedTo===member && item.iterationPath===iteration.path) stageChanges(workspace,item.id,{assignedTo:'',iterationPath:workspace.settings.backlogIteration.path});
  }
  workspace.participantExclusions[id]=[...new Set([...(workspace.participantExclusions[id] || []),member])];
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
    if (field === 'remainingWork' && (!item.canEstimateHours || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000)) throw new Error('Indica un número de horas válido.');
    // The only state change is closing a task or bug with its type's completed state.
    if (field === 'state' && (typeof value !== 'string' || (value !== item.state && (!isExecutable(item) || !completedState(item,workspace) || value !== completedState(item,workspace))))) throw new Error('Solo se pueden marcar como completadas las tareas y bugs.');
    if (same(item[field], value)) delete draft[field]; else draft[field] = value;
  }
  if (['assignedTo','iterationPath'].some(field=>Object.hasOwn(changes,field) && !same(current[field],changes[field]))) {
    const assignee=draft.assignedTo ?? item.assignedTo;
    const iteration=workspace.iterations.find(i=>i.path===(draft.iterationPath ?? item.iterationPath));
    if(assignee && iteration && !memberHasCapacity(workspace,assignee,iteration.id)) throw new Error('Esta persona tiene capacidad 0 y queda fuera del reparto de esta iteración.');
  }
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
function memberHasCapacity(workspace, member, iterationId) {
  const person=workspace.members.find(m=>identityKey(m)===member);
  const iteration=workspace.iterations.find(i=>i.id===iterationId);
  if(!person || !iteration) return false;
  return workingCapacity(iteration,effectiveCapacity(workspace,iterationId),person.id,workspace.settings.workingDays) !== 0;
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
  if (workspace?.sources) return projectCapacityPlans(workspace).filter(p=>!sameCapacity(p.original,p.entry));
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

// Allocate the single availability budget by estimated work, including zeroing
// old project allocations when the person no longer has tasks there.
export function projectCapacityPlans(workspace) {
  if (!workspace.sources) return [];
  const plans=[];
  for (const iteration of workspace.iterations.filter(i=>(workspace.allocationIterations ?? []).includes(i.id) || effectiveItems(workspace).some(t=>isExecutable(t) && t.assignedTo && t.iterationPath===i.path))) for (const member of workspace.members) {
    const capacity=effectiveCapacity(workspace,iteration.id), global=capacityEntry(capacity,member.id);
    const available=workingCapacity(iteration,capacity,member.id,workspace.settings.workingDays) ?? 0;
    const tasks=available===0 ? [] : effectiveItems(workspace).filter(i=>isExecutable(i) && !i.contextOnly && i.assignedTo===identityKey(member) && i.iterationPath===iteration.path);
    const total=tasks.reduce((sum,i)=>sum+(i.remainingWork ?? 0),0);
    const destinations=workspace.sources.filter(s=>iteration.sourceIterations[s.id] && s.members.some(m=>m.id===member.id));
    for (const source of destinations) {
      const remoteIterationId=iteration.sourceIterations[source.id], remoteIteration=source.iterations.find(i=>i.id===remoteIterationId);
      const hours=tasks.filter(i=>i.sourceId===source.id).reduce((sum,i)=>sum+(i.remainingWork ?? 0),0), ratio=total ? hours/total : 0;
      const original=capacityEntry(source.capacities?.[remoteIterationId],member.id);
      const offDates=new Set();
      for(const range of [...global.daysOff,...(capacity.daysOff ?? [])]) for(let date=new Date(range.start.slice(0,10)+'T00:00:00Z');date.toISOString().slice(0,10)<=range.end.slice(0,10);date.setUTCDate(date.getUTCDate()+1)) offDates.add(date.toISOString().slice(0,10));
      const daysOff=[...offDates].sort().map(date=>({start:date,end:date}));
      const unit={daysOff:source.capacities?.[remoteIterationId]?.daysOff ?? [],teamMembers:[{teamMember:member,activities:[{name:'',capacityPerDay:1}],daysOff}]};
      const days=workingCapacity(remoteIteration,unit,member.id,source.settings.workingDays) ?? 0;
      const globalDaily=global.activities.reduce((sum,a)=>sum+a.capacityPerDay,0);
      const entry={daysOff,activities:global.activities.map(a=>({name:a.name,capacityPerDay:Math.round((days && globalDaily ? available*ratio/days*a.capacityPerDay/globalDaily : 0)*100)/100}))};
      plans.push({iterationId:iteration.id,remoteIterationId,sourceId:source.id,config:source.config,key:member.id,entry,original,iteration:`${source.config.project} · ${remoteIteration.name}`,label:member.displayName,hours,ratio,available,allocated:Math.round(days*entry.activities.reduce((n,a)=>n+a.capacityPerDay,0)*100)/100,missingEstimate:tasks.some(i=>i.remainingWork==null),unavailable:hours>0 && !days});
    }
  }
  return plans;
}

export function planningWorkspace(workspace) {
  const capacities = Object.fromEntries(workspace.iterations.map(i => [i.id, effectiveCapacity(workspace, i.id)]));
  return {...workspace,projectAllocations:projectCapacityPlans(workspace),effectiveItems:effectiveItems(workspace),effectiveCapacities:capacities,capacityHours:Object.fromEntries(workspace.iterations.map(i=>[i.id,Object.fromEntries(workspace.members.map(m=>[m.id,workingCapacity(i,capacities[i.id],m.id,workspace.settings.workingDays)]))]))};
}
export function confirmPerson(workspace, member, iterationId) {
  if (!workspace?.members.some(m=>identityKey(m)===member) || !workspace.iterations.some(i=>i.id===iterationId)) throw new Error('Persona o iteración no válida.');
  if (!memberHasCapacity(workspace,member,iterationId)) throw new Error('Esta persona tiene capacidad 0 y queda fuera del reparto de esta iteración.');
  const status=personPlanningStatus(planningWorkspace(workspace),member,iterationId);
  if (!status.canConfirm) throw new Error('Completa las horas y estima las tareas antes de confirmar.');
  workspace.confirmations ??= {};
  workspace.confirmations[iterationId] ??= {};
  workspace.confirmations[iterationId][member]=status.signature;
}
export function invalidateConfirmations(workspace) {
  if (!workspace?.confirmations) return;
  const current=planningWorkspace(workspace);
  for (const [iterationId,members] of Object.entries(workspace.confirmations)) {
    for (const member of Object.keys(members)) {
      if (!personPlanningStatus(current,member,iterationId).confirmed) delete members[member];
    }
    if (!Object.keys(members).length) delete workspace.confirmations[iterationId];
  }
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
  async planBatch(member, ids, iterationId) {
    const data=structuredClone(this.store.data), workspace=data[data.mode];
    const before=structuredClone({drafts:workspace?.drafts,conflicts:workspace?.conflicts});
    planTasks(workspace,member,ids,iterationId);
    await this.store.save(data); this.review=null;
    this.lastBatch={token:randomUUID(),version:this.store.data.version,mode:data.mode,ids,before};
    return {token:this.lastBatch.token,version:this.lastBatch.version,count:ids.length};
  }
  async undoPlan(token) {
    const batch=this.lastBatch;
    if (!batch || batch.token!==token || batch.version!==this.store.data.version || batch.mode!==this.store.data.mode) throw new Error('El plan ha cambiado. Ya no se puede deshacer este lote automáticamente.');
    const data=structuredClone(this.store.data), workspace=data[data.mode];
    for (const id of batch.ids) {
      for (const field of ['drafts','conflicts']) {
        if (Object.hasOwn(batch.before[field],id)) workspace[field][id]=batch.before[field][id];
        else delete workspace[field][id];
      }
    }
    await this.store.save(data); this.lastBatch=null; this.review=null;
  }
  async prepareReview() {
    const workspace = this.workspace();
    if (!workspace) throw new Error('Importa una planificación primero.');
    const ids = Object.keys(workspace.drafts).map(Number);
    const creations=effectiveItems(workspace).filter(i=>i.localOnly).sort((a,b)=>b.id-a.id);
    const capacityIterations = [...new Set([...capacityChanges(workspace).map(change => change.iterationId),...Object.keys(workspace.capacityDrafts ?? {})])];
    if (!ids.length && !capacityIterations.length) throw new Error('No hay cambios pendientes.');
    if (workspace.mode === 'azure') await this.azure.open(workspace.config);
    // Local is the source of truth: only edited tasks are read, to show what changes.
    // If Azure cannot be read, the local copy stands in so every draft is still written.
    const remoteItems = workspace.mode === 'demo' ? workspace.items : await this.readItems(workspace, ids.filter(id=>id>0)).catch(() => workspace.items.filter(i => ids.includes(i.id)));
    const plans = planReview(workspace, remoteItems);
    for(const item of creations) plans.push({id:item.id,title:item.title,creation:true,item,conflicts:[],updates:{title:item.title},changes:['type','title','parent','assignedTo','iterationPath','remainingWork'].map(field=>({field,label:FIELD_LABELS[field] || ({type:'Tipo',parent:'Padre'})[field],before:null,after:item[field]}))});
    const remoteCapacities = {};
    let capacityPlans, incompleteAllocations=[];
    if (workspace.sources) {
      const allocations=projectCapacityPlans(workspace);
      // Incomplete estimates or capacity do not block the sync: unestimated work counts
      // as 0 h and the split is corrected in a later sync once it is defined.
      incompleteAllocations=allocations.filter(p=>p.missingEstimate || p.unavailable).map(p=>({label:p.label,iteration:p.iteration,missingEstimate:p.missingEstimate,unavailable:p.unavailable}));
      capacityPlans=[];
      for (const plan of allocations.filter(p=>!sameCapacity(p.original,p.entry))) {
        const cacheKey=JSON.stringify([plan.sourceId,plan.remoteIterationId]);
        // A capacity that cannot be read does not stop the sync: the local copy stands in.
        if (!(cacheKey in remoteCapacities)) remoteCapacities[cacheKey] = await this.azure.capacity(plan.config,plan.remoteIterationId).catch(() => null);
        const teamDaysOff=capacityEntry(remoteCapacities[cacheKey],'team');
        const remote=remoteCapacities[cacheKey] ? capacityEntry(remoteCapacities[cacheKey],plan.key) : plan.original;
        capacityPlans.push({...plan,teamDaysOff,remote,after:plan.entry,conflict:!sameCapacity(remote,plan.original) && !sameCapacity(remote,plan.entry),applied:sameCapacity(remote,plan.entry)});
      }
    } else {
      for (const iterationId of capacityIterations) remoteCapacities[iterationId] = workspace.mode === 'demo' ? workspace.capacities?.[iterationId] : await this.azure.capacity(workspace.config, iterationId).catch(() => workspace.capacities?.[iterationId]);
      capacityPlans = planCapacityReview(workspace, remoteCapacities);
    }
    const data = structuredClone(this.store.data);
    data[data.mode].conflicts = Object.fromEntries(plans.filter(p => p.conflicts.length).map(p => [p.id, p]));
    data[data.mode].capacityConflicts = capacityPlans.filter(p => p.conflict).reduce((all, plan) => ({ ...all, [plan.iterationId]: { ...all[plan.iterationId], [plan.key]: plan.remote } }), {});
    await this.store.save(data);
    this.review = { token: randomUUID(), version: this.store.data.version, mode: workspace.mode, plans, capacityPlans, incompleteAllocations };
    // Conflicts are informative: synchronizing keeps the local version.
    return { ...this.review };
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
          for(const field of ['participants','participantExclusions']) if(next[field]?.[plan.id]){next[field][updated.id]=next[field][plan.id];delete next[field][plan.id];}
          delete next.drafts[plan.id];delete next.conflicts[plan.id];delete next.creationAttempts?.[plan.id];next.lastSyncedAt=new Date().toISOString();
          await this.store.save(data);remapped.set(plan.id,updated.id);successes.push(updated.id);
        } catch(error) {failures.push({id:plan.id,error:error.message});}
        continue;
      }
      if (plan.missing) { failures.push({ id: plan.id, error: 'No se pudo leer esta tarea en Azure DevOps. Comprueba que existe y vuelve a sincronizar.' }); continue; }
      let updated;
      try {
        updated = workspace.mode === 'demo' ? { ...plan.remote, ...plan.fields, rev: plan.remote.rev + 1 }
          : Object.keys(plan.updates).length ? planningItem(workspace, await this.azure.update(sourceFor(workspace,plan.remote).config, plan.id, null, remoteFields(workspace,plan.remote,plan.updates)), sourceFor(workspace,plan.remote)) : plan.remote;
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
    return { successes, failures, capacity, demo: workspace.mode === 'demo' };
  }
  // Local capacity is the source of truth: each value is written as it is,
  // without reading and comparing Azure again.
  async syncCapacity(review, workspace) {
    const successes = [], failures = [];
    const byIteration = new Map();
    for (const plan of review.capacityPlans ?? []) byIteration.set(JSON.stringify([plan.sourceId,plan.iterationId]), [...(byIteration.get(JSON.stringify([plan.sourceId,plan.iterationId])) ?? []), plan]);
    for (const [, plans] of byIteration) {
      const iterationId=plans[0].remoteIterationId ?? plans[0].iterationId, config=plans[0].config ?? workspace.config;
      for (const plan of plans) {
        try {
          if (workspace.mode !== 'demo' && !plan.applied) {
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
      for (const iteration of next.iterations) next.capacities[iteration.id]=effectiveCapacity(next,iteration.id);
      next.capacityDrafts={}; next.capacityConflicts={}; await this.store.save(data);
    }
    return { successes, failures };
  }
}
