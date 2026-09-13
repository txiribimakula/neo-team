import {sourcesOf,sourceFor,planningItem,remoteFields,mergeProjects} from './multi-project.js';
import {capacityEntry,workingCapacity} from './planner.js';
export async function refreshSection(workspace,section,azure,rules,report=()=>{}) {
  if(!workspace || workspace.mode!=='azure') throw new Error('Importa proyectos de Azure DevOps primero.');
  if(!['iterations','capacity','tasks'].includes(section)) throw new Error('Sección no válida.');
  const taskDrafts=Object.keys(workspace.drafts ?? {}).length;
  const capacityDrafts=Object.keys(workspace.capacityDrafts ?? {}).length;
  if(section==='tasks' && taskDrafts || section==='capacity' && capacityDrafts || section==='iterations' && (taskDrafts || capacityDrafts)) throw new Error('Sincroniza o descarta los cambios de esta sección antes de actualizarla.');
  const next=structuredClone(workspace), originals=sourcesOf(workspace), refreshed=[];
  for(const [index,source] of originals.entries()) {
    refreshed.push(await azure.import(source.config,p=>report({...p,message:`${source.config.project} (${index+1}/${originals.length}) · ${p.message}`}),rules,{section,snapshot:source}));
  }
  if(section==='tasks') {
    next.items=refreshed.flatMap((data,index)=>data.items.map(item=>planningItem(next,item,originals[index])));
    next.conflicts={};
    if(next.sources) next.sources.forEach((source,index)=>{source.backlogLevels=refreshed[index].backlogLevels;source.completedStates={...refreshed[index].completedStates,...source.completedStates};});
    else {next.backlogLevels=refreshed[0].backlogLevels;next.completedStates={...refreshed[0].completedStates,...next.completedStates};}
    next.warnings=refreshed.flatMap(data=>data.warnings ?? []);
  } else if(section==='capacity') {
    if(!next.sources) next.capacities=refreshed[0].capacities;
    else {
      next.sources.forEach((source,index)=>{source.capacities=refreshed[index].capacities;});
      // Azure holds the split budget: reconstruct availability by summing each
      // activity across projects, and union personal/project holidays.
      for(const iteration of next.iterations) {
        const teamMembers=next.members.map(member=>{
          const activities=new Map();let commonDays=null;
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
            commonDays=commonDays===null ? dates : new Set([...commonDays].filter(day=>dates.has(day)));
          }
          const daysOff=[...(commonDays ?? [])].sort().map(day=>({start:day,end:day}));
          const days=workingCapacity(iteration,{daysOff:[],teamMembers:[{teamMember:member,daysOff,activities:[{name:'',capacityPerDay:1}]}]},member.id,next.settings.workingDays);
          if(!days && [...activities.values()].some(hours=>hours>0)) throw new Error('El calendario global no permite representar la capacidad de Azure. Revisa los días laborables.');
          return {teamMember:member,activities:[...activities].map(([name,hours])=>({name,capacityPerDay:days ? Math.round(hours/days*100)/100 : 0})),daysOff};
        });
        next.capacities[iteration.id]={daysOff:[],teamMembers};
      }
    }
    next.capacityConflicts={};
  } else if(!next.sources) next.iterations=refreshed[0].iterations;
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
