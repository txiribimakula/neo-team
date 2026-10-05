// My iteration: the work items assigned to the signed-in account (@Me) in the
// team's current iteration, laid out like the Azure DevOps sprint taskboard.
export const MY_ITERATION_LIMIT = 1000;
export const MY_ITERATION_FIELDS = ['System.Id', 'System.Title', 'System.WorkItemType', 'System.State', 'System.AssignedTo', 'System.Parent', 'System.Tags', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Common.StackRank', 'Microsoft.VSTS.Common.BacklogPriority', 'Microsoft.VSTS.Scheduling.RemainingWork', 'Microsoft.VSTS.Scheduling.CompletedWork'];
const CARD_TYPES = new Set(['task', 'bug', 'tarea']);
const key = value => String(value ?? '').trim().toLowerCase();
const quoteWiql = value => `'${String(value).replace(/'/g, "''")}'`;

// The iteration Azure marks as current or, without that mark, the one whose
// dates (inclusive) contain today.
export function currentIteration(iterations, today = new Date().toISOString().slice(0, 10)) {
  const marked = iterations.find(i => [1, 'current'].includes(typeof i.attributes?.timeFrame === 'string' ? i.attributes.timeFrame.toLowerCase() : i.attributes?.timeFrame));
  return marked ?? iterations.find(i => {
    const start = i.attributes?.startDate?.slice(0, 10), finish = i.attributes?.finishDate?.slice(0, 10);
    return start && finish && start <= today && today <= finish;
  }) ?? null;
}

export const myIterationWiql = path => `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.IterationPath] = ${quoteWiql(path)} AND [System.AssignedTo] = @Me ORDER BY [System.Id] ASC`;
export const parentsWiql = ids => `SELECT [System.Id] FROM WorkItems WHERE [System.Id] IN (${ids.join(',')})`;

export function boardItem(raw) {
  const f = raw.fields ?? {}, assigned = f['System.AssignedTo'];
  return {
    id: raw.id, type: f['System.WorkItemType'] || '', title: f['System.Title'] || `Elemento ${raw.id}`, state: f['System.State'] || '',
    assignedTo: typeof assigned === 'object' ? assigned?.displayName ?? '' : String(assigned ?? '').replace(/\s*<[^<>]*>$/, ''),
    parent: f['System.Parent'] || null, priority: f['Microsoft.VSTS.Common.Priority'] ?? null,
    rank: f['Microsoft.VSTS.Common.BacklogPriority'] ?? f['Microsoft.VSTS.Common.StackRank'] ?? null,
    remainingWork: f['Microsoft.VSTS.Scheduling.RemainingWork'] ?? null, completedWork: f['Microsoft.VSTS.Scheduling.CompletedWork'] ?? null,
    tags: (f['System.Tags'] || '').split(';').map(s => s.trim()).filter(Boolean),
  };
}

const byRank = (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (a.priority ?? Infinity) - (b.priority ?? Infinity) || a.id - b.id;

// Rows are the parents (backlog items) and columns the task states, as in the
// taskboard. Tasks and bugs are cards unless another of my items hangs from
// them; my backlog items are rows even without cards. Cards without a parent
// share a last row. Removed items are left out, as Azure does.
export function myIterationBoard(mine, parents, states) {
  const category = (type, state) => states[type]?.find(s => key(s.name) === key(state))?.category ?? '';
  const visible = mine.filter(item => category(item.type, item.state) !== 'removed');
  const parentIds = new Set(visible.map(i => i.parent).filter(Boolean));
  const isCard = item => CARD_TYPES.has(key(item.type)) && !parentIds.has(item.id);
  const cards = visible.filter(isCard);
  const reference = states.Task ?? states[cards[0]?.type] ?? [];
  const columns = reference.filter(s => s.category !== 'removed').map(s => ({ name: s.name, category: s.category }));
  const column = card => {
    const named = columns.find(c => key(c.name) === key(card.state));
    if (named) return named.name;
    const cat = category(card.type, card.state), same = cat && columns.find(c => c.category === cat);
    if (same) return same.name;
    if (!columns.some(c => key(c.name) === key(card.state))) columns.push({ name: card.state, category: cat });
    return card.state;
  };
  const heads = new Map([...parents.map(p => [p.id, { ...p, mine: false }]), ...visible.filter(i => !isCard(i)).map(i => [i.id, { ...i, mine: true }])]);
  const lanes = new Map([...heads.values()].filter(head => head.mine || cards.some(c => c.parent === head.id)).sort(byRank).map(head => [head.id, { parent: head, cards: [] }]));
  const orphans = { parent: null, cards: [] };
  for (const card of cards.sort(byRank)) (lanes.get(card.parent) ?? orphans).cards.push({ ...card, column: column(card) });
  return { columns, lanes: [...lanes.values(), ...(orphans.cards.length ? [orphans] : [])] };
}
