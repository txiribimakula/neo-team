export const IMPORT_FIELDS = ['System.Id','System.Title','System.WorkItemType','System.State','System.TeamProject','System.AssignedTo','System.IterationPath','System.AreaPath','System.Parent','System.Tags','Microsoft.VSTS.Common.Priority','Microsoft.VSTS.Scheduling.RemainingWork','Microsoft.VSTS.Scheduling.StoryPoints','Microsoft.VSTS.Scheduling.Effort','Microsoft.VSTS.Scheduling.Size'];
export const wiqlQuote = value => `'${String(value).replace(/'/g,"''")}'`;
const key = value => String(value ?? '').trim().toLowerCase();
export function stateAction(config,type,state,rules=[]) {
  const rule=rules.find(r=>key(r.organization)===key(config.organization) && key(r.project)===key(config.project) && key(r.type)===key(type) && key(r.state)===key(state.name));
  if(rule) return rule.action;
  const name=key(state.name),category=key(state.category || state.stateCategory).replace(/\s/g,'');
  if(name==='discarded' || ['completed','removed'].includes(category)) return 'exclude';
  if(['proposed','inprogress','resolved'].includes(category)) return 'include';
  if(['closed','done','removed'].includes(name)) return 'exclude';
  return null;
}
export function importWiql(config,settings,pastPaths,type,states,after=0,ids=null) {
  const clauses=['[System.TeamProject] = @project',`[System.WorkItemType] = ${wiqlQuote(type)}`,`[System.State] IN (${states.map(wiqlQuote).join(',')})`,`[System.Id] > ${after}`];
  if(ids) clauses.push(`[System.Id] IN (${ids.join(',')})`);
  else {
    if(settings.areaPaths?.length) clauses.push(`(${settings.areaPaths.map(a=>`[System.AreaPath] ${a.includeChildren ? 'UNDER' : '='} ${wiqlQuote(a.value)}`).join(' OR ')})`);
    clauses.push(`([System.IterationPath] = ${wiqlQuote(settings.backlogIteration.path)}${(settings.importIterationPaths ?? []).map(path=>` OR [System.IterationPath] UNDER ${wiqlQuote(path)}`).join('')})`);
  }
  for(const path of pastPaths) clauses.push(`[System.IterationPath] NOT UNDER ${wiqlQuote(path)}`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(' AND ')} ORDER BY [System.Id] ASC`;
}
