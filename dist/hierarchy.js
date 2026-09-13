// Shared pure model: the browser and local API apply the same selection rules.
export const memberKey = member => (member.uniqueName || member.id || member.displayName || '').toLowerCase();
export const isExecutable = item => !item.contextOnly && ['task', 'bug', 'tarea'].includes(item.type.toLowerCase());
export const completedState = (item, workspace) => (workspace.sources ? workspace.sources.find(s=>s.id===item.sourceId)?.completedStates : workspace.completedStates)?.[item.type];
export const isCompleted = (item, workspace) => !!completedState(item,workspace) && item.state === completedState(item,workspace);
// The iteration that starts right before the given one. Dates decide when they
// exist; undated iterations keep the order in which Azure DevOps listed them.
export function previousIteration(iterations, iterationId) {
  const index = iterations.findIndex(i => i.id === iterationId);
  if (index < 0) return null;
  const startOf = iteration => String(iteration.attributes?.startDate ?? '').slice(0,10);
  const start = startOf(iterations[index]), before = iterations[index-1];
  const earlier = start ? iterations.filter(i => startOf(i) && startOf(i) < start).sort((a,b) => startOf(b).localeCompare(startOf(a))) : [];
  return earlier[0] ?? (before && !(start && startOf(before)) ? before : null);
}
export const typeRank = item => ({epic:0,feature:1,'user story':2,'product backlog item':2,requirement:2,task:3,tarea:3,bug:3}[item.type.toLowerCase()] ?? 4);
export function hierarchy(items) {
  const nodes = new Map(items.map(item => [item.id, {...item, children:[]} ]));
  const parents = new Map();
  for (const item of nodes.values()) {
    const parent = Number(item.parent);
    if (parent !== item.id && nodes.has(parent)) parents.set(item.id,parent);
  }
  // Invalid/cyclic links never hide tasks or cause unbounded traversal.
  for (const id of nodes.keys()) {
    const seen = new Set(); let current = id;
    while (parents.has(current)) {
      if (seen.has(current)) { parents.delete(current); break; }
      seen.add(current); current = parents.get(current);
    }
  }
  const roots = [];
  for (const node of nodes.values()) {
    if (parents.has(node.id)) nodes.get(parents.get(node.id)).children.push(node);
    else roots.push(node);
  }
  const compare = (a,b) => typeRank(a)-typeRank(b) || (a.priority ?? 5)-(b.priority ?? 5) || a.id-b.id;
  roots.sort(compare); for (const node of nodes.values()) node.children.sort(compare);
  return {roots,nodes,parents};
}
export function ancestors(id, tree) {
  const result = []; let current = tree.parents.get(id);
  while (current !== undefined) { result.unshift(tree.nodes.get(current)); current=tree.parents.get(current); }
  return result;
}
export function participantSources(item, workspace, tree = hierarchy(workspace.effectiveItems || workspace.items)) {
  const sources = new Map(), blocked=new Set();
  for (const node of [...ancestors(item.id,tree),item]) {
    for (const member of workspace.participantExclusions?.[node.id] || []) {sources.delete(member);blocked.add(member);}
    const direct=workspace.participants?.[node.id] || [];
    for (const member of direct) blocked.delete(member);
    for (const member of new Set([...direct, ...(node.assignedTo && !blocked.has(node.assignedTo) ? [node.assignedTo] : [])])) {
      if (!sources.has(member)) sources.set(member,[]);
      sources.get(member).push({id:node.id,title:node.title,inherited:node.id !== item.id,assigned:node.assignedTo === member});
    }
  }
  return sources;
}

export function capacityStatus(summary) {
  const {plannedHours:hours,capacity,unknownPlanned:unknown}=summary;
  const percent=capacity===null ? 0 : capacity===0 ? (hours>0 ? 100 : 0) : Math.min(100,hours/capacity*100);
  const status=capacity!==null && hours>capacity+0.005 ? 'over' : capacity===null || unknown>0 ? 'unknown' : capacity===0 ? 'zero' : Math.abs(hours-capacity)<0.005 ? 'full' : 'open';
  return {status,percent,hours,capacity,unknown};
}
export function personPlanningStatus(workspace, member, iterationId) {
  const summary=selectionSummary(workspace,member,iterationId), meter=capacityStatus(summary);
  const covered=['full','over'].includes(meter.status);
  const signature=JSON.stringify([summary.capacity,summary.planned.map(i=>[i.id,i.remainingWork ?? null,i.title,i.priority]).sort((a,b)=>a[0]-b[0])]);
  const canConfirm=covered && meter.unknown===0;
  return {covered,canConfirm,signature,confirmed:canConfirm && workspace.confirmations?.[iterationId]?.[member]===signature};
}
export function orderedPlanningMembers(workspace, iterationId) {
  return workspace.members.map((member,index)=>({member,index,...personPlanningStatus(workspace,memberKey(member),iterationId)}))
    .sort((a,b)=>Number(a.covered)-Number(b.covered) || a.index-b.index);
}
export function eligibleTasks(workspace, member) {
  const items=workspace.effectiveItems || workspace.items.map(i=>({...i,...workspace.drafts?.[i.id]}));
  const tree=hierarchy(items);
  return items.filter(item=>isExecutable(item) && !isCompleted(item,workspace) && participantSources(item,workspace,tree).has(member));
}
export function filterHierarchy(roots, predicate) {
  return roots.flatMap(node=>{
    const children=filterHierarchy(node.children,predicate);
    return predicate(node) || children.length ? [{...node,children}] : [];
  });
}

export function selectionSummary(workspace, member, iterationId, selectedIds = []) {
  const iteration=workspace.iterations.find(i=>i.id===iterationId);
  const person=workspace.members.find(m=>memberKey(m)===member);
  const items=workspace.effectiveItems || workspace.items.map(i=>({...i,...workspace.drafts?.[i.id]}));
  const planned=items.filter(i=>isExecutable(i) && i.assignedTo===member && i.iterationPath===iteration?.path);
  const eligible=eligibleTasks(workspace,member);
  const available=eligible.filter(i=>(!i.assignedTo || i.assignedTo===member) && !(i.assignedTo===member && i.iterationPath===iteration?.path));
  const wanted=new Set(selectedIds), selected=available.filter(i=>wanted.has(i.id));
  const hours=list=>list.reduce((sum,i)=>sum+(i.remainingWork ?? 0),0);
  const unknown=list=>list.filter(i=>i.remainingWork===null || i.remainingWork===undefined).length;
  const capacity=person ? workspace.capacityHours?.[iterationId]?.[person.id] ?? null : null;
  const plannedHours=hours(planned), selectedHours=hours(selected), projectedHours=plannedHours+selectedHours;
  return {planned,available,eligible,selected,plannedHours,selectedHours,projectedHours,capacity,
    unknownPlanned:unknown(planned),unknownSelected:unknown(selected),
    freeHours:capacity===null ? null : capacity-projectedHours,
    invalidIds:[...wanted].filter(id=>!selected.some(i=>i.id===id))};
}
