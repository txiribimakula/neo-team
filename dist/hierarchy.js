// Shared pure model: the browser and local API apply the same selection rules.
export const memberKey = member => (member.uniqueName || member.id || member.displayName || '').toLowerCase();
export const isExecutable = item => !item.contextOnly && ['task', 'bug', 'tarea'].includes(item.type.toLowerCase());
export const completedState = (item, workspace) => (workspace.sources ? workspace.sources.find(s=>s.id===item.sourceId)?.completedStates : workspace.completedStates)?.[item.type];
export const isCompleted = (item, workspace) => !!completedState(item,workspace) && item.state === completedState(item,workspace);
// The hour fields a task can be edited with, named as in Azure DevOps. Types read
// from Azure say which fields they have; otherwise the usual Task/Bug fields apply.
export function estimateFields(workspace, item) {
  const known=(workspace.sources ? workspace.sources.find(s=>s.id===item.sourceId)?.estimateFields : workspace.estimateFields)?.[item.type];
  if (known) return known;
  return {originalEstimate:item.originalEstimate!=null || item.type==='Task' ? 'Original Estimate' : null, remainingWork:item.canEstimateHours ? 'Remaining Work' : null};
}
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
// The snapshots received by the interface are never edited, so their trees are
// computed once per snapshot.
// Plans edited in place (the server's working copy) are never cached.
const snapshots = new WeakSet(), trees = new WeakMap();
export function markSnapshot(workspace) {
  if (workspace) { snapshots.add(workspace); if (workspace.effectiveItems) snapshots.add(workspace.effectiveItems); }
  return workspace;
}
export function hierarchy(items) {
  if (!snapshots.has(items)) return buildHierarchy(items);
  if (!trees.has(items)) trees.set(items, buildHierarchy(items));
  return trees.get(items);
}
function buildHierarchy(items) {
  const nodes = new Map(items.map(item => [item.id, {...item, children:[]} ]));
  const parents = new Map();
  for (const item of nodes.values()) {
    const parent = Number(item.parent);
    // Each project keeps an independent backlog: a link to another project's item is not a parent here.
    if (parent !== item.id && nodes.has(parent) && (nodes.get(parent).sourceId ?? null) === (item.sourceId ?? null)) parents.set(item.id,parent);
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
  roots.sort((a,b) => (a.project ?? '').localeCompare(b.project ?? '') || compare(a,b)); for (const node of nodes.values()) node.children.sort(compare);
  return {roots,nodes,parents};
}
export function ancestors(id, tree) {
  const result = []; let current = tree.parents.get(id);
  while (current !== undefined) { result.unshift(tree.nodes.get(current)); current=tree.parents.get(current); }
  return result;
}

export function hasPlanningCapacity(workspace, member, iterationId) {
  const person=workspace.members.find(m=>memberKey(m)===member);
  return !person || workspace.capacityHours?.[iterationId]?.[person.id] !== 0;
}
export function filterHierarchy(roots, predicate) {
  return roots.flatMap(node=>{
    const children=filterHierarchy(node.children,predicate);
    return predicate(node) || children.length ? [{...node,children}] : [];
  });
}

