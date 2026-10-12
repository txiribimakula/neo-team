import {sourcesOf,sourceFor,planningItem,remoteFields,mergeProjects,jointIteration} from './multi-project.js';
import {capacityEntry,workingCapacity,effectiveCapacity,sameCapacity,same} from './planner.js';
export async function refreshSection(workspace,section,azure,rules,report=()=>{}) {
  if(!workspace || workspace.mode!=='azure') throw new Error('Importa proyectos de Azure DevOps primero.');
  if(!['iterations','capacity','tasks'].includes(section)) throw new Error('Sección no válida.');
  const taskDrafts=Object.keys(workspace.drafts ?? {}).length;
  const capacityDrafts=Object.keys(workspace.capacityDrafts ?? {}).length;
  // Tasks can be downloaded with local changes: they are kept on top of what Azure has.
  // Iterations too, as long as Azure only adds new ones (see addNewIterations).
  if(section==='capacity' && capacityDrafts) throw new Error('Sincroniza o descarta los cambios de esta sección antes de actualizarla.');
  const onlyAdd=section==='iterations' && !!(taskDrafts || capacityDrafts);
  const next=structuredClone(workspace), originals=sourcesOf(workspace), refreshed=[];
  for(const [index,source] of originals.entries()) {
    refreshed.push(await azure.import(source.config,p=>report({...p,message:`${source.config.project} (${index+1}/${originals.length}) · ${p.message}`}),rules,{section,snapshot:source}));
  }
  if(section==='tasks') {
    // The latest finished iteration, whose open tasks are downloaded now, joins
    // the calendar so they can be decided. It is never planned.
    const finished=refreshed.map(data=>data.iterations.filter(i=>i.past));
    if(!next.sources) {
      if(finished[0].some(i=>!next.iterations.some(known=>known.id===i.id))) next.iterations=[...finished[0],...next.iterations.filter(i=>!i.past && !finished[0].some(p=>p.id===i.id))];
    } else {
      next.sources.forEach((source,index)=>{source.iterations=[...finished[index],...source.iterations.filter(i=>!i.past && !finished[index].some(p=>p.id===i.id))];});
      const calendar=next.iterations.filter(i=>!i.past);
      for(const source of next.sources) for(const iteration of source.iterations.filter(i=>i.past)) {
        if(calendar.some(j=>j.sourceIterations?.[source.id]===iteration.id)) continue;
        jointIteration(calendar,source,iteration).sourceIterations[source.id]=iteration.id;
      }
      next.iterations=calendar.sort((a,b)=>(a.attributes?.startDate ?? '').localeCompare(b.attributes?.startDate ?? ''));
    }
    const fresh=refreshed.flatMap((data,index)=>data.items.map(item=>planningItem(next,item,sourcesOf(next)[index]))), ids=new Set(fresh.map(item=>item.id));
    // Local work survives the download: items not created yet, and edited items that
    // Azure no longer lists as open, so their changes can still be reviewed.
    next.items=[...fresh,...workspace.items.filter(item=>!ids.has(item.id) && (item.localOnly || workspace.drafts?.[item.id]))];
    // A local change that Azure already has is no longer pending.
    for(const [id,draft] of Object.entries(next.drafts ?? {})) {
      const item=next.items.find(i=>i.id===Number(id));
      if(!item || item.localOnly) continue;
      for(const field of Object.keys(draft)) if(same(item[field],draft[field]) && !(field==='state' && next.stateChanges?.[id]?.length)) delete draft[field];
      if(!Object.keys(draft).length) delete next.drafts[id];
    }
    next.conflicts={};
    if(next.sources) next.sources.forEach((source,index)=>{source.backlogLevels=refreshed[index].backlogLevels;source.workItemStates=refreshed[index].workItemStates ?? source.workItemStates;source.completedStates={...refreshed[index].completedStates,...source.completedStates};source.estimateFields=refreshed[index].estimateFields ?? source.estimateFields;});
    else {next.backlogLevels=refreshed[0].backlogLevels;next.workItemStates=refreshed[0].workItemStates ?? next.workItemStates;next.completedStates={...refreshed[0].completedStates,...next.completedStates};next.estimateFields=refreshed[0].estimateFields ?? next.estimateFields;}
    next.warnings=[...new Set([...(next.warnings ?? []),...refreshed.flatMap(data=>data.warnings ?? [])])];
  } else if(section==='capacity') {
    if(!next.sources) next.capacities=refreshed[0].capacities;
    else {
      next.sources.forEach((source,index)=>{source.capacities=refreshed[index].capacities;});
      for(const iteration of next.iterations) next.capacities[iteration.id]=jointCapacity(next,iteration);
    }
    next.capacityConflicts={};
  } else if(onlyAdd) addNewIterations(next,originals,refreshed);
  else if(!next.sources) next.iterations=refreshed[0].iterations;
  else {
    // Rebuild only the shared calendar; keep every other section's payload.
    let calendar;
    for(const [index,data] of refreshed.entries()) {
      const source=originals[index];
      const items=workspace.items.filter(i=>i.sourceId===source.id).map(item=>({...item,...remoteFields(workspace,item,{iterationPath:item.iterationPath})}));
      const snapshot={...data,mode:'azure',config:source.config,items,drafts:{},conflicts:{},warnings:[]};
      calendar=calendar ? mergeProjects(calendar,snapshot) : snapshot;
    }
    next.sources.forEach((source,index)=>{source.iterations=refreshed[index].iterations;});
    next.iterations=calendar.iterations;
    next.items=workspace.items.map(item=>planningItem(next,{...item,...remoteFields(workspace,item,{iterationPath:item.iterationPath})},sourceFor(next,item)));
    const remapped={};
    for(const iteration of next.iterations) {
      const old=workspace.iterations.find(i=>Object.entries(iteration.sourceIterations).some(([source,id])=>i.sourceIterations[source]===id));
      if(old && workspace.capacities?.[old.id]) remapped[iteration.id]=workspace.capacities[old.id];
    }
    next.capacities=remapped;
  }
  next.refreshedAt={...next.refreshedAt,[section]:new Date().toISOString()};
  return next;
}
// With local changes pending, the calendar only grows: Azure's new iterations are
// added and the rest of the plan is left as it is. If an iteration already there
// changed its path or dates, or is gone, the changes are synchronized first.
function addNewIterations(next,originals,refreshed) {
  const day=value=>String(value ?? '').slice(0,10), dates=i=>[day(i.attributes?.startDate),day(i.attributes?.finishDate)];
  const unchanged=(a,b)=>a.path===b.path && !!a.past===!!b.past && dates(a).join()===dates(b).join();
  const blocked=()=>new Error('Sincroniza o descarta los cambios pendientes antes de actualizar: alguna iteración que ya tienes ha cambiado o ya no está en Azure. Mientras solo haya iteraciones nuevas, se añaden sin sincronizar.');
  const added=refreshed.map((data,index)=>{
    const known=originals[index].iterations;
    if(known.some(old=>{const now=data.iterations.find(i=>i.id===old.id);return !now || !unchanged(old,now);})) throw blocked();
    return data.iterations.filter(i=>!known.some(old=>old.id===i.id));
  });
  if(!next.sources) { next.iterations=[...next.iterations,...added[0]]; return; }
  next.sources.forEach((source,index)=>{
    source.iterations=[...source.iterations,...added[index]];
    for(const iteration of added[index]) {
      const [start,end]=dates(iteration);
      // A new date range that overlaps the shared calendar needs the full rebuild.
      if(!iteration.past && next.iterations.some(j=>!j.past && dates(j).join()!==[start,end].join() && start && end && dates(j)[0]<=end && start<=dates(j)[1])) throw blocked();
      jointIteration(next.iterations,source,iteration).sourceIterations[source.id]=iteration.id;
    }
  });
  next.iterations.sort((a,b)=>day(a.attributes?.startDate).localeCompare(day(b.attributes?.startDate)));
}
// Azure holds the split budget: reconstruct availability by summing each
// activity across projects. A day is off when it is off (for the person or the
// team) in every project where the person has hours; projects where they have
// none do not count, or their days would dilute the hours of the others.
function jointCapacity(next,iteration) {
  const teamMembers=next.members.map(member=>{
    const activities=new Map(),withHours=[],withoutHours=[];
    for(const source of next.sources) {
      const remoteIteration=source.iterations.find(i=>i.id===iteration.sourceIterations[source.id]);
      const capacity=source.capacities?.[remoteIteration?.id];
      if(!capacity || !source.members.some(m=>m.id===member.id)) continue;
      const entry=capacityEntry(capacity,member.id), dates=new Set();
      for(const activity of entry.activities) {
        const hours=workingCapacity(remoteIteration,{...capacity,teamMembers:[{teamMember:member,...entry,activities:[activity]}]},member.id,source.settings.workingDays);
        if(hours===null) throw new Error('La iteración necesita fechas para reunir la capacidad de los proyectos.');
        activities.set(activity.name,(activities.get(activity.name) ?? 0)+hours);
      }
      for(const range of [...entry.daysOff,...(capacity.daysOff ?? [])]) for(let date=new Date(range.start.slice(0,10)+'T00:00:00Z');date.toISOString().slice(0,10)<=range.end.slice(0,10);date.setUTCDate(date.getUTCDate()+1)) dates.add(date.toISOString().slice(0,10));
      (entry.activities.some(a=>Number(a.capacityPerDay)>0) ? withHours : withoutHours).push(dates);
    }
    const voting=withHours.length ? withHours : withoutHours;
    const commonDays=voting.length ? voting.reduce((common,dates)=>new Set([...common].filter(day=>dates.has(day)))) : new Set();
    const daysOff=[...commonDays].sort().map(day=>({start:day,end:day}));
    const days=workingCapacity(iteration,{daysOff:[],teamMembers:[{teamMember:member,daysOff,activities:[{name:'',capacityPerDay:1}]}]},member.id,next.settings.workingDays);
    if(!days && [...activities.values()].some(hours=>hours>0)) throw new Error('El calendario global no permite representar la capacidad de Azure. Revisa los días laborables.');
    return {teamMember:member,activities:[...activities].map(([name,hours])=>({name,capacityPerDay:days ? Math.round(hours/days*100)/100 : 0})),daysOff};
  });
  return {daysOff:[],teamMembers};
}
// Download one iteration's capacity: Azure replaces the local copy, including
// local drafts. What the person had locally is kept beside it, per person, so they
// can keep Azure's value, go back to theirs or set another one.
export async function downloadCapacity(workspace,iterationId,azure,report=()=>{}) {
  if(!workspace || workspace.mode!=='azure') throw new Error('Importa proyectos de Azure DevOps primero.');
  const iteration=workspace.iterations.find(i=>i.id===iterationId);
  if(!iteration) throw new Error('Elige una iteración del equipo.');
  const before=effectiveCapacity(workspace,iterationId), next=structuredClone(workspace);
  if(next.sources) {
    for(const [index,source] of next.sources.entries()) {
      const remoteId=iteration.sourceIterations?.[source.id];
      if(!remoteId) continue;
      report({phase:'capacity',message:`${source.config.project} (${index+1}/${next.sources.length}) · Descargando la capacidad de la iteración…`});
      await azure.open(source.config);
      source.capacities={...source.capacities,[remoteId]:await azure.capacity(source.config,remoteId)};
    }
    next.capacities={...next.capacities,[iterationId]:jointCapacity(next,iteration)};
  } else {
    report({phase:'capacity',message:`Descargando la capacidad de «${iteration.name}»…`});
    await azure.open(next.config);
    next.capacities={...next.capacities,[iterationId]:await azure.capacity(next.config,iterationId)};
  }
  delete next.capacityDrafts?.[iterationId];delete next.capacityConflicts?.[iterationId];
  const local={};
  for(const key of ['team',...next.members.map(m=>m.id)]) {
    const mine=capacityEntry(before,key);
    if(!sameCapacity(mine,capacityEntry(next.capacities[iterationId],key))) local[key]=mine;
  }
  next.capacityDownloads={...next.capacityDownloads,[iterationId]:{at:new Date().toISOString(),local}};
  if(!Object.keys(local).length) delete next.capacityDownloads[iterationId];
  next.refreshedAt={...next.refreshedAt,capacity:new Date().toISOString()};
  return next;
}
