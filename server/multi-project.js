// The planner uses one calendar. Azure paths and capacity baselines stay attached
// to their project so local edits can always be translated back without guessing.
const key = value => String(value ?? '').trim().toLowerCase();
export const sourceId = config => JSON.stringify([key(config.organization), key(config.project), key(config.team)]);
const period = iteration => {
  const start = iteration.attributes?.startDate?.slice(0,10), end = iteration.attributes?.finishDate?.slice(0,10);
  return start && end ? `${start}/${end}` : null;
};
export function sourcesOf(workspace) {
  return workspace?.sources ?? (workspace ? [{ id: sourceId(workspace.config), config: workspace.config, settings: workspace.settings, backlogLevels:workspace.backlogLevels, iterations: workspace.iterations, members: workspace.members, capacities: workspace.capacities, completedStates: workspace.completedStates }] : []);
}
export function sourceFor(workspace, item) {
  const source = sourcesOf(workspace).find(s => s.id === item?.sourceId) ?? (!workspace.sources ? sourcesOf(workspace)[0] : null);
  if (!source) throw new Error('No se pudo determinar el proyecto de la tarea.');
  return source;
}
export function planningItem(workspace, item, source) {
  if (!workspace.sources) return item;
  const remoteIteration = source.iterations.find(i => i.path === item.iterationPath);
  const iteration = remoteIteration && workspace.iterations.find(i => i.sourceIterations?.[source.id] === remoteIteration.id);
  return { ...item, sourceId: source.id, project: source.config.project, iterationPath: item.iterationPath === source.settings.backlogIteration.path ? workspace.settings.backlogIteration.path : iteration?.path ?? item.iterationPath };
}
export function remoteFields(workspace, item, fields) {
  if (!workspace.sources || fields.iterationPath === undefined) return fields;
  const source = sourceFor(workspace,item), path = fields.iterationPath;
  if (path === workspace.settings.backlogIteration.path) return { ...fields, iterationPath: source.settings.backlogIteration.path };
  const iteration = workspace.iterations.find(i => i.path === path);
  if (!iteration) return fields;
  const remote = source.iterations.find(i => i.id === iteration.sourceIterations[source.id]);
  if (!remote) throw new Error(`«${source.config.project}» no tiene una iteración con estas fechas. Elige otra iteración.`);
  return { ...fields, iterationPath: remote.path };
}
export function mergeProjects(previous, imported) {
  if (!previous) return imported;
  if (key(previous.config.organization) !== key(imported.config.organization)) throw new Error('Los proyectos de una planificación deben pertenecer a la misma organización.');
  const incoming = sourceId(imported.config), sources = structuredClone(sourcesOf(previous)).filter(s => s.id !== incoming);
  if (sources.some(s => key(s.config.project) === key(imported.config.project))) throw new Error('Este proyecto ya está importado con otro equipo. Usa el equipo importado para evitar duplicar capacidad.');
  sources.push(...structuredClone(sourcesOf(imported)));
  const members = [...new Map(sources.flatMap(s => s.members).map(m => [m.id,m])).values()];
  const iterations = [], periods = new Map();
  for (const source of sources) for (const iteration of source.iterations.filter(i=>!i.past)) {
    const dates = period(iteration), group = dates ?? `${source.id}/${iteration.id}`;
    let joint = periods.get(group);
    if (!joint) {
      joint = { ...iteration, id: `joint:${group}`, path: `Planificación\\${group}`, name: dates ? `${dates.split('/').join(' → ')}` : `${source.config.project} · ${iteration.name}`, sourceIterations: {} };
      periods.set(group,joint); iterations.push(joint);
    }
    if (joint.sourceIterations[source.id]) {
      const first = source.iterations.find(i => i.id === joint.sourceIterations[source.id]);
      throw new Error(`«${source.config.project}» tiene dos iteraciones con las mismas fechas (${dates.replace('/',' → ')}): «${first?.name}» y «${iteration.name}». Corrige el calendario del equipo antes de unirlo.`);
    }
    joint.sourceIterations[source.id] = iteration.id;
  }
  iterations.sort((a,b)=>(a.attributes?.startDate ?? '').localeCompare(b.attributes?.startDate ?? ''));
  // Name every conflicting sprint with its project and dates, so the calendar to fix is clear.
  const describe = joint => Object.entries(joint.sourceIterations).map(([id, iterationId]) => {
    const source = sources.find(s => s.id === id), iteration = source.iterations.find(i => i.id === iterationId);
    return `«${source.config.project}» · ${iteration.name} (${period(iteration).replace('/',' → ')})`;
  }).join(' y ');
  const overlaps = [];
  for (const [index, a] of iterations.entries()) for (const b of iterations.slice(index + 1)) {
    if(!period(a) || !period(b)) continue;
    if(a.attributes.startDate.slice(0,10)<=b.attributes.finishDate.slice(0,10) && b.attributes.startDate.slice(0,10)<=a.attributes.finishDate.slice(0,10)) overlaps.push(`${describe(a)} se solapa con ${describe(b)}`);
  }
  if (overlaps.length) throw new Error(`Los proyectos tienen iteraciones solapadas con fechas distintas. Alinea sus fechas para compartir una única capacidad: ${overlaps.slice(0,5).join('; ')}${overlaps.length > 5 ? `; y ${overlaps.length - 5} solapamientos más` : ''}.`);
  const workspace = { ...structuredClone(previous), config: previous.config, sources, members, iterations, settings: { ...previous.settings, backlogIteration: { path: 'Planificación' } }, capacities: {}, items: [], warnings: [...new Set([...(previous.warnings ?? []),...(imported.warnings ?? [])])], importedAt: imported.importedAt };
  // Convert the previous projection to remote paths before projecting onto the new calendar.
  const retained = previous.items.filter(item=>!previous.iterations.some(i=>i.past && i.path===item.iterationPath)).filter(item => (item.sourceId ?? sourceId(previous.config)) !== incoming).map(item => {
    const source = sourcesOf(previous).find(s=>s.id===(item.sourceId ?? sourceId(previous.config)));
    return planningItem(workspace,{...item,...remoteFields(previous,item,{iterationPath:item.iterationPath})},source);
  });
  workspace.items = [...retained,...imported.items.map(item=>planningItem(workspace,item,sources.find(s=>s.id===incoming)))];
  if (new Set(workspace.items.map(i=>i.id)).size !== workspace.items.length) throw new Error('Hay elementos duplicados entre los proyectos importados.');
  for (const iteration of iterations) {
    const old = previous.iterations.find(i => period(i) && period(i) === period(iteration));
    const oldCapacity = old && previous.capacities?.[old.id];
    const teamMembers = members.map(member => {
      const existing = oldCapacity?.teamMembers?.find(r=>r.teamMember.id===member.id);
      if (existing) return structuredClone(existing);
      const records = sources.flatMap(s => s.capacities?.[iteration.sourceIterations[s.id]]?.teamMembers ?? []).filter(r=>r.teamMember.id===member.id);
      // An imported person's capacity is a starting point, never a sum of their
      // availability in several projects. They edit it once in the capacity step.
      return structuredClone(records.sort((a,b)=>b.activities.reduce((s,a)=>s+a.capacityPerDay,0)-a.activities.reduce((s,a)=>s+a.capacityPerDay,0))[0] ?? {teamMember:member,activities:[],daysOff:[]});
    });
    workspace.capacities[iteration.id] = { teamMembers, daysOff: structuredClone(oldCapacity?.daysOff ?? []) };
  }
  workspace.capacityDrafts = {}; workspace.capacityConflicts = {}; workspace.confirmations = {};
  // Adding a source is only permitted without drafts; participation is local and retained.
  workspace.drafts = {}; workspace.conflicts = {};
  return workspace;
}
