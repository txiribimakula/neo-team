import { randomUUID } from 'node:crypto';
import { eligibleTasks, isExecutable, hierarchy, ancestors, participantSources, personPlanningStatus } from '../dist/hierarchy.js';

export const FIELD_LABELS = { title: 'Título', assignedTo: 'Responsable', iterationPath: 'Iteración', priority: 'Prioridad', remainingWork: 'Horas pendientes' };
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
  const item={id,rev:0,localOnly:true,creationKey:randomUUID(),title:input.title.trim(),type:input.type,parent:parent?.id || null,state:'New',assignedTo:'',iterationPath:workspace.settings.backlogIteration.path,areaPath:parent?.areaPath || workspace.settings.defaultValue || workspace.settings.areaPaths?.[0]?.value || workspace.config.project,remainingWork:null,priority:2,points:null,tags:[],canEstimateHours:['Task','Bug'].includes(input.type),canPrioritize:true};
  workspace.items.push(item);workspace.nextLocalId=id;
  stageChanges(workspace,id,{title:item.title,...(input.assignedTo ? {assignedTo:input.assignedTo} : {}),...(input.iterationPath ? {iterationPath:input.iterationPath} : {}),...(input.remainingWork!==undefined ? {remainingWork:input.remainingWork} : {})});
  return id;
}
export function discardLocal(workspace,id) {
  const ids=id===undefined ? workspace.items.filter(i=>i.localOnly).map(i=>i.id) : [id];
  if (ids.some(id=>workspace.creationAttempts?.[id])) throw new Error('Hay una creación enviada sin confirmar. Revisa y recupera su resultado antes de descartarla.');
  if (id<0 && workspace.items.some(i=>i.parent===id)) throw new Error('Descarta primero los elementos hijos nuevos.');
  workspace.items=workspace.items.filter(i=>!(i.localOnly && ids.includes(i.id)));
  if(id===undefined){workspace.drafts={};workspace.conflicts={};}
  else {delete workspace.drafts[id];delete workspace.conflicts[id];}
  for(const localId of ids) if(localId<0){delete workspace.participants?.[localId];delete workspace.participantExclusions?.[localId];}
}
export function setParticipants(workspace, assignments) {
  if (!workspace || !Array.isArray(assignments) || !assignments.length || assignments.length > 200) throw new Error('Reparto no válido.');
  const next = { ...workspace.participants };
  for (const assignment of assignments) {
    if (!workspace.items.some(i=>i.id === assignment.id)) throw new Error('El elemento no pertenece a este backlog.');
    if (!Array.isArray(assignment.members) || assignment.members.some(key=>!workspace.members.some(m=>identityKey(m) === key))) throw new Error('Elige integrantes de este equipo.');
    const keys = [...new Set(assignment.members)];
    if (keys.length) next[assignment.id] = keys; else delete next[assignment.id];
  }
  workspace.participants = next;
}
export function planTasks(workspace, member, ids, iterationId) {
  if (!workspace || !workspace.members.some(m=>identityKey(m) === member)) throw new Error('Elige una persona del equipo.');
  const iteration = workspace.iterations.find(i=>i.id === iterationId);
  if (!iteration) throw new Error('Elige una iteración del equipo.');
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length) throw new Error('Selecciona entre 1 y 200 tareas distintas.');
  const eligible = new Map(eligibleTasks(workspace,member).map(i=>[i.id,i]));
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
  const draft = { ...workspace.drafts[id] };
  for (const [field, value] of Object.entries(changes)) {
    if (!Object.hasOwn(FIELD_LABELS, field)) throw new Error('Campo no editable.');
    if (field === 'title' && (typeof value!=='string' || !value.trim() || value.length>255)) throw new Error('Indica un título válido.');
    if (field === 'assignedTo' && (typeof value !== 'string' || (value !== '' && !workspace.members.some(m => identityKey(m) === value) && value !== item.assignedTo))) throw new Error('Elige una persona del equipo.');
    if (field === 'iterationPath' && ![workspace.settings.backlogIteration.path, ...workspace.iterations.map(i => i.path), item.iterationPath].includes(value)) throw new Error('Elige una iteración del equipo.');
    if (field === 'priority' && (!item.canPrioritize || !Number.isInteger(value) || value < 1 || value > 4)) throw new Error('La prioridad debe estar entre 1 y 4.');
    if (field === 'remainingWork' && (!item.canEstimateHours || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100000)) throw new Error('Indica un número de horas válido.');
    if (same(item[field], value)) delete draft[field]; else draft[field] = value;
  }
  if (item.localOnly) draft.title=changes.title ?? draft.title ?? item.title;
  if (Object.keys(draft).length) workspace.drafts[id] = draft; else delete workspace.drafts[id];
  delete workspace.conflicts[id];
}
export function planReview(workspace, remoteItems) {
  const remoteById = new Map(remoteItems.map(item => [item.id, item]));
  return Object.entries(workspace.drafts).filter(([id])=>Number(id)>0).map(([id, fields]) => {
    const base = workspace.items.find(item => item.id === Number(id));
    const remote = remoteById.get(Number(id));
    if (!remote) throw new Error(`No se pudo leer la tarea #${id}. No se enviará ningún cambio.`);
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

export function planningWorkspace(workspace) {
  return {...workspace,effectiveItems:effectiveItems(workspace),capacityHours:Object.fromEntries(workspace.iterations.map(i=>[i.id,Object.fromEntries(workspace.members.map(m=>[m.id,workingCapacity(i,workspace.capacities[i.id],m.id,workspace.settings.workingDays)]))]))};
}
export function confirmPerson(workspace, member, iterationId) {
  if (!workspace?.members.some(m=>identityKey(m)===member) || !workspace.iterations.some(i=>i.id===iterationId)) throw new Error('Persona o iteración no válida.');
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

export class Planner {
  constructor(store, azure) { this.store = store; this.azure = azure; this.review = null; }
  workspace() { return this.store.data[this.store.data.mode]; }
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
    if (!ids.length) throw new Error('No hay cambios pendientes.');
    if (workspace.mode === 'azure') await this.azure.open(workspace.config);
    const remoteItems = workspace.mode === 'demo' ? workspace.items : await this.azure.getItems(workspace.config, ids.filter(id=>id>0));
    const plans = planReview(workspace, remoteItems);
    const parentIds=[...new Set(creations.map(i=>i.parent).filter(id=>id>0))];
    const parents=workspace.mode==='demo' ? workspace.items.filter(i=>parentIds.includes(i.id)) : await this.azure.getItems(workspace.config,parentIds);
    if(parentIds.some(id=>!parents.find(i=>i.id===id))) throw new Error('No se pudo comprobar el padre. No se enviará ningún cambio.');
    for(const item of creations) plans.push({id:item.id,title:item.title,creation:true,item,conflicts:[],updates:{title:item.title},changes:['type','title','parent','assignedTo','iterationPath','remainingWork'].map(field=>({field,label:FIELD_LABELS[field] || ({type:'Tipo',parent:'Padre'})[field],before:null,after:item[field]}))});
    const data = structuredClone(this.store.data);
    data[data.mode].conflicts = Object.fromEntries(plans.filter(p => p.conflicts.length).map(p => [p.id, p]));
    await this.store.save(data);
    this.review = { token: randomUUID(), version: this.store.data.version, mode: workspace.mode, plans, parents };
    return { ...this.review, token: plans.some(p => p.conflicts.length) ? null : this.review.token };
  }
  async sync(token) {
    const review = this.review;
    if (!review || !token || review.token !== token || review.version !== this.store.data.version) throw new Error('La revisión ha caducado. Revisa los cambios de nuevo.');
    this.review = null;
    if (review.plans.some(p => p.conflicts.length)) throw new Error('Resuelve los conflictos antes de sincronizar.');
    const workspace = this.workspace();
    if (workspace.mode === 'azure') {
      await this.azure.open(workspace.config);
      const current = await this.azure.getItems(workspace.config, [...new Set([...review.plans.filter(p=>!p.creation).map(p=>p.id),...(review.parents || []).map(p=>p.id)])]);
      if (review.plans.filter(p=>!p.creation).some(p => current.find(i => i.id === p.id)?.rev !== p.remote.rev) || (review.parents || []).some(p=>current.find(i=>i.id===p.id)?.rev!==p.rev)) throw new Error('Azure DevOps ha cambiado desde la revisión. Revisa de nuevo antes de sincronizar.');
    }
    const successes = [], failures = [];
    const remapped=new Map();
    for (const plan of review.plans) {
      if(plan.creation) {
        try {
          const item={...plan.item,parent:remapped.get(plan.item.parent) || plan.item.parent};
          if(item.parent<0) throw new Error('El padre sigue pendiente de creación.');
          let updated;
          if(workspace.mode==='demo') updated={...item,id:Math.max(0,...this.workspace().items.map(i=>i.id))+1,rev:1};
          else {
            updated=await this.azure.findCreation(workspace.config,item.creationKey);
            if(!updated) {
              if(this.workspace().creationAttempts?.[plan.id]) throw new Error('Resultado de creación incierto. No se reenvía para evitar duplicados; vuelve a revisar para recuperar el elemento si aparece en Azure.');
              await this.azure.create(workspace.config,item,true);
              const attempt=structuredClone(this.store.data);attempt[attempt.mode].creationAttempts ??= {};attempt[attempt.mode].creationAttempts[plan.id]=item;await this.store.save(attempt);
              updated=await this.azure.create(workspace.config,item,false);
            }
          }
          if(!updated || updated.id<1 || ['title','type','parent','assignedTo','iterationPath','priority','areaPath'].some(field=>!same(updated[field],item[field])) || (item.remainingWork!==null && !same(updated.remainingWork,item.remainingWork))) throw new Error('La creación remota difiere del borrador. Se conserva para revisar sin sobrescribir Azure.');
          delete updated.localOnly;delete updated.creationKey;delete updated.modified;
          const data=structuredClone(this.store.data),next=data[data.mode];
          next.items=next.items.map(i=>i.id===plan.id ? updated : i.parent===plan.id ? {...i,parent:updated.id} : i);
          for(const field of ['participants','participantExclusions']) if(next[field]?.[plan.id]){next[field][updated.id]=next[field][plan.id];delete next[field][plan.id];}
          delete next.drafts[plan.id];delete next.conflicts[plan.id];delete next.creationAttempts?.[plan.id];next.lastSyncedAt=new Date().toISOString();
          await this.store.save(data);remapped.set(plan.id,updated.id);successes.push(updated.id);
        } catch(error) {failures.push({id:plan.id,error:error.message});}
        continue;
      }
      let updated;
      try {
        updated = workspace.mode === 'demo' ? { ...plan.remote, ...plan.fields, rev: plan.remote.rev + 1 }
          : Object.keys(plan.updates).length ? await this.azure.update(workspace.config, plan.id, plan.remote.rev, plan.updates) : plan.remote;
        if (updated.id !== plan.id || Object.entries(plan.fields).some(([field, value]) => !same(updated[field], value))) throw new Error('La respuesta no confirma todos los cambios. Vuelve a revisar esta tarea.');
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
    return { successes, failures, demo: workspace.mode === 'demo' };
  }
}
