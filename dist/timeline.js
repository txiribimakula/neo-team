// Timelines: chosen user stories laid out over the calendar, with their open tasks
// below. Each person works through their own tasks one after another, in the order
// of the timeline; tasks of different people run in parallel unless one is set to
// go after another. Owners changed here are only a scenario until they are applied.
import { memberKey, isExecutable, isCompleted, typeRank, hierarchy, ancestors, filterHierarchy } from './hierarchy.js';
import { matchesQuery, normalize } from './search.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = value => new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(value);
const dayOf = value => String(value ?? '').slice(0, 10);
const EPSILON = 1e-9;
export const addDay = (day, count) => new Date(Date.parse(`${day}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
const shortDate = day => new Date(`${day}T00:00:00Z`).toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const initials = name => String(name).trim().split(/\s+/).slice(0, 2).map(s => s[0] ?? '').join('').toUpperCase();
const closedStates = new Set(['closed', 'done', 'removed', 'resolved', 'cerrado', 'hecho', 'eliminado']);
const isClosed = (item, ws) => isCompleted(item, ws) || closedStates.has(String(item.state ?? '').toLowerCase());

// A story is what holds the tasks: user stories, PBIs or requirements, whatever the
// process calls them, and any other item with tasks or bugs right below it. Those
// imported only as context of another team count too: their tasks may be ours.
const storyName = /story|historia|backlog item|requirement|requisito/i;
export const isStory = node => !isExecutable(node) && !['task', 'bug', 'tarea'].includes(String(node.type).toLowerCase()) && (typeRank(node) === 2 || storyName.test(node.type) || !!node.children?.some(isExecutable));
export const hoursOf = item => item.remainingWork ?? item.originalEstimate ?? null;
function openTasks(tree, id, ws) {
  const result = [], walk = node => { for (const child of node.children) { if (isExecutable(child) && !isClosed(child, ws)) result.push(child); walk(child); } };
  const node = tree.nodes.get(id);
  if (node) walk(node);
  return result;
}
export function newTimeline(id, name, start) {
  return { id, name, start, stories: [], order: [], owners: {}, after: {}, storyAfter: {}, rates: {} };
}

// The stories of the timeline in its order, each with its open tasks in their order.
export function timelineGroups(ws, timeline) {
  const tree = hierarchy(ws.effectiveItems), rank = new Map(timeline.order.map((id, index) => [id, index]));
  return timeline.stories.map(id => tree.nodes.get(id)).filter(Boolean).map(story => ({
    story, after: timeline.storyAfter?.[story.id] ?? '',
    tasks: openTasks(tree, story.id, ws).sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9)).map(item => {
      const owner = Object.hasOwn(timeline.owners ?? {}, item.id) ? timeline.owners[item.id] : item.assignedTo || '';
      return { id: item.id, item, story: story.id, hours: hoursOf(item) ?? 0, estimated: hoursOf(item) !== null, owner, changed: owner !== (item.assignedTo || ''), after: timeline.after?.[item.id] ?? '' };
    }),
  }));
}

// Holidays and vacations. Until someone writes their own, each year has invented
// ones, as an average employee in Spain would have: the national holidays for the
// whole team and, for each person, Holy Week, two weeks in August (every other
// person takes the second half) and Christmas. A year, once edited, is kept as it is.
export function easter(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = (h + l - 7 * m + 114) % 31 + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const one = (day, name) => ({ start: day, end: day, name });
export function defaultHolidays(year) {
  const sunday = easter(year);
  return [one(`${year}-01-01`, 'Año Nuevo'), one(`${year}-01-06`, 'Reyes'), one(addDay(sunday, -3), 'Jueves Santo'), one(addDay(sunday, -2), 'Viernes Santo'), one(`${year}-05-01`, 'Día del Trabajo'), one(`${year}-08-15`, 'Asunción'), one(`${year}-10-12`, 'Fiesta Nacional'), one(`${year}-11-01`, 'Todos los Santos'), one(`${year}-12-06`, 'Constitución'), one(`${year}-12-08`, 'Inmaculada'), one(`${year}-12-25`, 'Navidad')];
}
export function defaultVacations(year, index = 0) {
  const sunday = easter(year), first = new Date(Date.UTC(year, 7, 1)).getUTCDay(), august = addDay(`${year}-08-01`, (8 - first) % 7);
  const summer = index % 2 ? addDay(august, 14) : august;
  return [{ start: addDay(sunday, -6), end: addDay(sunday, 1), name: 'Semana Santa' }, { start: summer, end: addDay(summer, 11), name: 'Verano' }, { start: `${year}-12-24`, end: `${year + 1}-01-06`, name: 'Navidad' }];
}
// Whose ranges: 'holidays' for the team, otherwise a person; each saved by the year it starts in.
const savedYears = (saved, who) => who === 'holidays' ? saved?.holidays : saved?.people?.[who];
export function rangesOf(saved, who, index, year) {
  return savedYears(saved, who)?.[year] ?? (who === 'holidays' ? defaultHolidays(year) : who ? defaultVacations(year, index) : []);
}
export const isDefault = (saved, who, years) => years.every(year => !savedYears(saved, who)?.[year]);
export const yearsOf = (start, days) => { const first = Number(start.slice(0, 4)), last = Number(addDay(start, days - 1).slice(0, 4)), years = []; for (let y = first; y <= last; y++) years.push(y); return years; };
// The ranges of some years in one list, and back: each goes to the year it starts in.
export const editableRanges = (saved, who, index, years) => years.flatMap(year => rangesOf(saved, who, index, year).map(r => ({ ...r })));
export function storeRanges(saved, who, years, ranges) {
  const next = structuredClone(saved ?? {}), byYear = Object.fromEntries(years.map(year => [year, ranges.filter(r => Number(r.start.slice(0, 4)) === year).sort((a, b) => a.start.localeCompare(b.start))]));
  if (who === 'holidays') next.holidays = { ...next.holidays, ...byYear };
  else next.people = { ...next.people, [who]: { ...next.people?.[who], ...byYear } };
  return next;
}
export function resetRanges(saved, who, years) {
  const next = structuredClone(saved ?? {}), own = who === 'holidays' ? next.holidays : next.people?.[who];
  for (const year of years) if (own) delete own[year];
  return next;
}

// Hours each person can work on each day of the timeline: working days only, without
// holidays, vacations or the days off of Azure DevOps. On a day covered by iterations of
// several projects their capacities add up, so a shared person counts whole. A rate set
// in the timeline replaces it; outside any iteration the person's usual one applies.
export function capacityModel(ws, timeline, vacations = {}) {
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const workingDays = ws.settings?.workingDays?.length ? ws.settings.workingDays : [1, 2, 3, 4, 5];
  const isWorking = day => { const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); return workingDays.some(d => d === weekday || String(d).toLowerCase() === names[weekday]); };
  const capacities = ws.effectiveCapacities ?? ws.capacities ?? {};
  const iterations = (ws.iterations ?? []).filter(i => dayOf(i.attributes?.startDate) && dayOf(i.attributes?.finishDate))
    .map(i => ({ start: dayOf(i.attributes.startDate), end: dayOf(i.attributes.finishDate), capacity: capacities[i.id] ?? {} }));
  const within = (ranges, day) => (ranges ?? []).some(r => day >= dayOf(r.start) && day <= dayOf(r.end));
  const daily = record => (record?.activities ?? []).reduce((sum, a) => sum + Number(a.capacityPerDay || 0), 0);
  const memberOf = owner => owner ? ws.members?.find(m => memberKey(m) === owner) : null;
  const indexOf = owner => Math.max(0, (ws.members ?? []).findIndex(m => memberKey(m) === owner));
  const recordOf = (capacity, member) => member ? capacity.teamMembers?.find(m => m.teamMember?.id === member.id) : null;
  // The capacity of a day across every iteration that covers it, and whether it is a day off.
  const onDay = (member, day) => {
    let hours = 0, off = false;
    for (const iteration of iterations.filter(i => day >= i.start && day <= i.end)) {
      const record = recordOf(iteration.capacity, member);
      if (!record && member) continue;
      if (within(iteration.capacity.daysOff, day) || within(record?.daysOff, day)) { off = true; continue; }
      hours += daily(record);
    }
    return { hours, off };
  };
  const usual = new Map();
  const usualOf = owner => {
    if (usual.has(owner)) return usual.get(owner);
    const total = member => Math.max(0, ...iterations.map(i => onDay(member, i.start).hours));
    let value = total(memberOf(owner));
    if (!value) {
      const team = (ws.members ?? []).map(total).filter(v => v > 0);
      value = team.length ? Math.round(team.reduce((a, b) => a + b, 0) / team.length * 100) / 100 : 6;
    }
    usual.set(owner, value);
    return value;
  };
  const yearly = new Map();
  const offRanges = (owner, year) => {
    const cacheKey = `${owner}|${year}`;
    if (!yearly.has(cacheKey)) yearly.set(cacheKey, [year - 1, year].flatMap(y => [...rangesOf(vacations, 'holidays', 0, y), ...(owner ? rangesOf(vacations, owner, indexOf(owner), y) : [])]));
    return yearly.get(cacheKey);
  };
  const cache = new Map();
  const capacity = (owner, index) => {
    const cacheKey = `${owner}|${index}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const day = addDay(timeline.start, index);
    let value = 0;
    if (isWorking(day) && !within(offRanges(owner, Number(day.slice(0, 4))), day)) {
      const { hours, off } = onDay(memberOf(owner), day), rate = Number(timeline.rates?.[owner]);
      if (!(off && !hours)) value = rate > 0 ? rate : hours > 0 ? hours : usualOf(owner);
    }
    cache.set(cacheKey, value);
    return value;
  };
  capacity.usual = usualOf;
  capacity.isWorking = isWorking;
  // A day the team works: neither weekend nor holiday.
  capacity.isWorkday = day => isWorking(day) && !within(offRanges('', Number(day.slice(0, 4))), day);
  return capacity;
}

// Places some hours from a moment on: days count from the start of the timeline, and
// the fraction of a day is the share of that person's hours already used.
function place(capacity, owner, from, hours, limit = 1500) {
  let day = Math.floor(from + EPSILON), part = Math.max(0, from - day), left = hours, start = null;
  if (part > 1 - EPSILON) { day++; part = 0; }
  for (let n = 0; n < limit; n++, day++, part = 0) {
    const perDay = capacity(owner, day);
    if (!(perDay > 0)) continue;
    start ??= day + part;
    const room = (1 - part) * perDay;
    if (left <= room + EPSILON) return { start, end: day + part + left / perDay };
    left -= room;
  }
  return { start: start ?? from, end: day, overflow: true };
}

// What a reference ("t:12" a task, "s:7" every task of a story) makes a task wait for.
function waitsFor(ref, task, rank, ofStory) {
  const [kind, raw] = String(ref || '').split(':'), id = Number(raw);
  if (kind === 't') return rank.has(id) && id !== task.id ? [id] : [];
  if (kind === 's') return id === task.story ? [] : ofStory.get(id) ?? [];
  return [];
}
// Every person (and every unassigned task on its own) is a queue in the timeline's
// order. The next task to start is the first in that order whose queue is free and
// whose predecessors are placed. A loop of predecessors is broken where it starts.
export function scheduleTimeline(groups, capacity) {
  const tasks = groups.flatMap(g => g.tasks.map(t => ({ ...t, storyAfter: g.after })));
  const rank = new Map(tasks.map((t, index) => [t.id, index]));
  const ofStory = new Map(groups.map(g => [g.story.id, g.tasks.map(t => t.id)]));
  const before = new Map(tasks.map(t => [t.id, [...new Set([...waitsFor(t.after, t, rank, ofStory), ...waitsFor(t.storyAfter, t, rank, ofStory)])]]));
  const queueOf = t => t.owner || `#${t.id}`, queues = new Map();
  for (const t of tasks) { if (!queues.has(queueOf(t))) queues.set(queueOf(t), []); queues.get(queueOf(t)).push(t); }
  const placed = new Map(), free = new Map(), next = new Map([...queues.keys()].map(q => [q, 0]));
  while (placed.size < tasks.length) {
    const heads = [...queues].map(([q, list]) => list[next.get(q)]).filter(Boolean).sort((a, b) => rank.get(a.id) - rank.get(b.id));
    const ready = heads.find(t => before.get(t.id).every(id => placed.has(id))), task = ready ?? heads[0];
    const queue = queueOf(task), idle = free.get(queue) ?? 0;
    const from = Math.max(idle, ...before.get(task.id).filter(id => placed.has(id)).map(id => placed.get(id).end));
    const slot = place(capacity, task.owner, from, task.hours);
    placed.set(task.id, { ...slot, loop: !ready, waits: from > idle + EPSILON });
    free.set(queue, slot.end); next.set(queue, next.get(queue) + 1);
  }
  const span = list => list.length ? { start: Math.min(...list.map(p => p.start)), end: Math.max(...list.map(p => p.end)) } : null;
  const stories = new Map(groups.map(g => [g.story.id, { ...span(g.tasks.map(t => placed.get(t.id))), hours: g.tasks.reduce((sum, t) => sum + t.hours, 0) }]));
  const people = new Map();
  for (const t of tasks) {
    const person = people.get(t.owner) ?? { hours: 0, count: 0, start: Infinity, end: 0 }, p = placed.get(t.id);
    people.set(t.owner, { hours: person.hours + t.hours, count: person.count + 1, start: Math.min(person.start, p.start), end: Math.max(person.end, p.end) });
  }
  const all = span([...placed.values()]);
  return { tasks: placed, stories, people, start: all?.start ?? 0, end: all?.end ?? 0, hours: tasks.reduce((sum, t) => sum + t.hours, 0), unestimated: tasks.filter(t => !t.estimated).length, loops: [...placed.values()].filter(p => p.loop).length };
}

// The calendar day on which a moment of the timeline falls: the end of a day's work
// belongs to that day, not to the next one.
export const dayAt = (start, moment) => addDay(start, Math.max(0, Math.ceil(moment - EPSILON) - 1));
export const dayFrom = (start, moment) => addDay(start, Math.max(0, Math.floor(moment + EPSILON)));

// Zoom: pixels per day. Below the width of a day number the calendar shows weeks, and
// further out only months; "fit" spreads the work over the width on screen.
export const DAY_WIDTH = 26;
export const ZOOM_LEVELS = [2, 3, 4, 6, 9, 13, 19, 26, 38];
// The next level out (step < 0) or in from the width on screen, which may be a fitted one.
export function zoomStep(width, step) {
  const next = step < 0 ? ZOOM_LEVELS.filter(level => level < width - 0.01).at(-1) : ZOOM_LEVELS.find(level => level > width + 0.01);
  return next ?? (step < 0 ? ZOOM_LEVELS[0] : ZOOM_LEVELS.at(-1));
}
const searchable = item => normalize(`${item.id} #${item.id} ${item.title} ${(item.tags ?? []).join(' ')} ${item.type} ${item.project ?? ''}`);
// The backlog as in Planificación: projects, epics and features open down to the
// stories, which are chosen one by one or all those below a branch at once. The
// search keeps what matches and everything below a branch that matches.
export function timelinePicker(ws, timeline, search = '', collapsed = new Set()) {
  const tree = hierarchy(ws.effectiveItems), chosen = new Set(timeline.stories), query = search.trim();
  const matches = node => !query || matchesQuery(query, searchable(node)) || ancestors(node.id, tree).some(parent => matchesQuery(query, searchable(parent)));
  const roots = filterHierarchy(tree.roots, node => isStory(node) && (chosen.has(node.id) || !isClosed(node, ws)) && matches(node));
  const below = node => isStory(node) ? [node.id] : node.children.flatMap(below);
  const branch = (id, label, node, ids, children) => {
    const all = ids.length && ids.every(i => chosen.has(i)), some = ids.some(i => chosen.has(i));
    return `<details class="tl-branch" data-tl-branch="${escape(id)}" ${query || !collapsed.has(String(id)) ? 'open' : ''}><summary><span class="branch-chevron" aria-hidden="true">›</span><input type="checkbox" data-tl-stories="${ids.join(',')}" ${all ? 'checked' : ''} class="${some && !all ? 'partial' : ''}" aria-label="Todas las de ${escape(node?.title ?? label)}">${label}<small>${node ? `#${node.id} · ` : ''}${ids.length} US</small></summary><div class="tl-branch-children">${children}</div></details>`;
  };
  const row = node => {
    const type = `<span class="node-type kind-${typeRank(node)}">${escape(node.type)}</span>`;
    if (isStory(node)) {
      const tasks = openTasks(tree, node.id, ws), hours = tasks.reduce((sum, t) => sum + (hoursOf(t) ?? 0), 0);
      return `<label class="tl-choice ${chosen.has(node.id) ? 'chosen' : ''}"><input type="checkbox" data-tl-story="${node.id}" ${chosen.has(node.id) ? 'checked' : ''}>${type}<span class="tl-choice-title">${escape(node.title)}</span><small>#${node.id}${node.contextOnly ? ' · contexto' : ''}</small><span class="tl-choice-hours">${tasks.length ? `${tasks.length} · ${number(hours)} h` : 'Sin tareas'}</span></label>`;
    }
    return branch(node.id, `${type}<span class="tl-choice-title">${escape(node.title)}</span>`, node, below(node), node.children.map(row).join(''));
  };
  const empty = `<p class="tl-none">${query ? `Nada coincide con «${escape(query)}».` : 'No hay user stories abiertas en la planificación importada.'}</p>`;
  if (!ws.sources) return roots.map(row).join('') || empty;
  // With several projects, each project is the top parent of its own backlog.
  const projects = ws.sources.map(source => {
    const own = roots.filter(node => node.sourceId === source.id);
    return own.length ? branch(`project:${source.id}`, `<span class="node-type kind-project">Proyecto</span><span class="tl-choice-title">${escape(source.config.project)}</span>`, null, own.flatMap(below), own.map(row).join('')) : '';
  }).join('');
  return projects + roots.filter(node => !ws.sources.some(source => source.id === node.sourceId)).map(row).join('') || empty;
}

function afterOptions(groups, self, story, value) {
  const option = (ref, label) => `<option value="${ref}" ${ref === value ? 'selected' : ''}>${escape(label)}</option>`;
  return `<option value="">—</option>${groups.filter(g => self || g.story.id !== story).map(g => `<optgroup label="#${g.story.id} ${escape(g.story.title)}">${g.story.id !== story ? option(`s:${g.story.id}`, `Toda #${g.story.id}`) : ''}${self ? g.tasks.filter(t => t.id !== self).map(t => option(`t:${t.id}`, `#${t.id} ${t.item.title}`)).join('') : ''}</optgroup>`).join('')}`;
}

// The page: the timelines, the stories to choose, the people and the Gantt.
export function timelineView(ws, ui, { memberName, taskLink }) {
  const timelines = ui.list ?? [], timeline = timelines.find(t => t.id === ui.id) ?? timelines[0];
  const tabs = `<nav class="tl-tabs" aria-label="Líneas temporales">${timelines.map(t => `<button type="button" class="tl-tab ${t === timeline ? 'active' : ''}" data-action="tl-open" data-timeline="${escape(t.id)}" ${t === timeline ? 'aria-current="page"' : ''}>${escape(t.name || 'Sin nombre')}</button>`).join('')}<button type="button" class="tl-tab tl-add" data-action="tl-new" aria-label="Nueva línea temporal" title="Nueva línea temporal">+</button></nav>`;
  if (!ws) return `<section class="timeline-page">${tabs}<div class="empty-panel"><h2>Sin planificación importada</h2><button class="button primary" data-action="open-planning">Ir a Planificación</button></div></section>`;
  if (!timeline) return `<section class="timeline-page">${tabs}<div class="empty-panel"><h2>Sin líneas temporales</h2><button class="button primary" data-action="tl-new">Nueva línea temporal</button></div></section>`;
  const groups = timelineGroups(ws, timeline), capacity = capacityModel(ws, timeline, ui.vacations), plan = scheduleTimeline(groups, capacity);
  const owners = [...new Set([...groups.flatMap(g => g.tasks.map(t => t.owner))])].sort((a, b) => (a === '') - (b === '') || memberName(a).localeCompare(memberName(b)));
  const hue = new Map(owners.map((owner, index) => [owner, owner ? (index * 67 + 145) % 360 : -1]));
  const style = owner => hue.get(owner) < 0 ? '--tl-hue:0;--tl-sat:0%' : `--tl-hue:${hue.get(owner)}`;
  const changed = groups.flatMap(g => g.tasks).filter(t => t.changed).length;
  // A week more than the work, and enough days to fill the screen at this zoom.
  // Fitted, just the work and a day more, as wide as the space there is.
  const fit = ui.zoom === 'fit', zoomed = Number(ui.zoom) || DAY_WIDTH;
  const days = fit ? Math.min(730, Math.max(7, Math.ceil(plan.end) + 1)) : Math.min(730, Math.max(42, Math.ceil(plan.end) + 7, Math.ceil((ui.fitWidth || 0) / zoomed)));
  const dayWidth = fit ? Math.max(0.5, Math.min(60, (ui.fitWidth || 900) / days)) : zoomed;
  ui.dayWidth = dayWidth;
  const narrow = dayWidth < 16, firstMonday = (8 - new Date(`${timeline.start}T00:00:00Z`).getUTCDay()) % 7;
  // The years on screen are those whose holidays and vacations can be edited here.
  const years = yearsOf(timeline.start, days), offsetOf = day => Math.round((Date.parse(day) - Date.parse(timeline.start)) / 86400000);
  ui.years = years;
  const indexOf = owner => Math.max(0, (ws.members ?? []).findIndex(m => memberKey(m) === owner));
  // Working days in a range: holidays count on weekdays, vacations only on days the team works.
  const workdays = (from, to, holidays = ui.vacationsFor === 'holidays') => { let count = 0; for (let day = from, n = 0; day <= to && n < 400; day = addDay(day, 1), n++) if (holidays ? capacity.isWorking(day) : capacity.isWorkday(day)) count++; return count; };
  const shown = (who, index) => [years[0] - 1, ...years].flatMap(year => rangesOf(ui.vacations, who, index, year)).map(r => ({ ...r, from: Math.max(0, offsetOf(r.start)), to: Math.min(days, offsetOf(r.end) + 1) })).filter(r => r.to > r.from);
  const shownDays = (list, holidays = false) => list.reduce((sum, r) => sum + workdays(addDay(timeline.start, r.from), addDay(timeline.start, r.to - 1), holidays), 0);
  const vacationSpans = owner => owner ? shown(owner, indexOf(owner)) : [];
  const today = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(timeline.start)) / 86400000);
  const range = (from, to) => from === to ? shortDate(from) : `${shortDate(from)} → ${shortDate(to)}`;
  const facts = groups.length ? [plan.hours ? `Fin ${shortDate(dayAt(timeline.start, plan.end))}` : '', `${number(plan.hours)} h`, plan.unestimated ? `${plan.unestimated} sin estimar` : '', plan.loops ? `${plan.loops} en bucle` : ''].filter(Boolean) : [];

  const toolbar = `<div class="tl-toolbar"><input class="tl-name" data-tl-field="name" value="${escape(timeline.name)}" maxlength="120" aria-label="Nombre de la línea temporal"><label class="tl-start">Inicio <input type="date" data-tl-field="start" value="${escape(timeline.start)}" required></label><span class="tl-facts">${facts.map(f => `<span>${escape(f)}</span>`).join('')}</span>${changed ? `<button type="button" class="button small primary" data-action="tl-apply-owners" title="Guardar los responsables cambiados como cambios locales, pendientes de sincronizar">Aplicar responsables · ${changed}</button>` : ''}<button type="button" class="button small ${ui.confirmDelete ? 'danger' : ''}" data-action="tl-delete">${ui.confirmDelete ? '¿Eliminar?' : 'Eliminar'}</button></div>`;
  const picker = `<details class="tl-picker" ${ui.pickerOpen ?? !groups.length ? 'open' : ''} data-tl-picker><summary>User stories <span class="count">${groups.length}</span></summary><div class="tl-picker-tools"><input class="search" data-tl-search placeholder="Buscar rama o user story" aria-label="Buscar en el backlog" value="${escape(ui.search ?? '')}"><button type="button" class="button small" data-action="tl-expand">Expandir</button><button type="button" class="button small" data-action="tl-collapse">Plegar</button>${ws.mode === 'azure' ? '<button type="button" class="button small" data-action="download-hierarchy" title="Trae de Azure DevOps las tareas y la jerarquía. Tus cambios locales se conservan y siguen pendientes de sincronizar.">Descargar jerarquía</button>' : ''}</div>${ws.mode === 'azure' ? '<div id="backlog-progress" hidden></div>' : ''}<div class="tl-choices" id="tl-choices">${timelinePicker(ws, timeline, ui.search ?? '', ui.collapsed)}</div></details>`;
  const people = owners.length ? `<div class="tl-people" aria-label="Personas">${owners.map(owner => {
    const p = plan.people.get(owner), rate = timeline.rates?.[owner];
    return `<div class="tl-person" style="${style(owner)}"><span class="tl-avatar" aria-hidden="true">${owner ? escape(initials(memberName(owner))) : '?'}</span><span class="tl-person-name">${escape(owner ? memberName(owner) : 'Sin asignar')}<small>${number(p.hours)} h · ${p.hours ? shortDate(dayAt(timeline.start, p.end)) : '—'}</small></span><label class="tl-rate" title="Horas al día en esta línea temporal; vacío usa su capacidad"><input type="number" min="0" max="24" step="0.5" data-tl-rate="${escape(owner)}" value="${rate ?? ''}" placeholder="${number(capacity.usual(owner))}" aria-label="Horas al día de ${escape(owner ? memberName(owner) : 'sin asignar')}">h/d</label>${owner ? `<button type="button" class="tl-vac-button ${ui.vacationsFor === owner ? 'active' : ''}" data-action="tl-vacations" data-who="${escape(owner)}" aria-pressed="${ui.vacationsFor === owner}" title="Vacaciones de ${escape(memberName(owner))} en estas fechas">☀ ${shownDays(vacationSpans(owner))} d</button>` : ''}</div>`;
  }).join('')}<button type="button" class="tl-vac-button tl-holidays ${ui.vacationsFor === 'holidays' ? 'active' : ''}" data-action="tl-vacations" data-who="holidays" aria-pressed="${ui.vacationsFor === 'holidays'}" title="Festivos de todo el equipo en estas fechas">Festivos · ${shownDays(shown('holidays', 0), true)} d</button></div>` : '';
  const editor = (() => {
    const who = ui.vacationsFor;
    if (!who || who !== 'holidays' && !owners.includes(who)) return '';
    const list = editableRanges(ui.vacations, who, indexOf(who), years), label = who === 'holidays' ? 'Festivos del equipo' : `Vacaciones · ${memberName(who)}`;
    const rows = list.map((r, i) => `<div class="tl-vac-row"><input data-tl-vac="name" data-index="${i}" value="${escape(r.name)}" maxlength="60" placeholder="Motivo" aria-label="Motivo"><input type="date" data-tl-vac="start" data-index="${i}" value="${r.start}" aria-label="Desde"><span aria-hidden="true">→</span><input type="date" data-tl-vac="end" data-index="${i}" value="${r.end}" aria-label="Hasta"><small>${workdays(r.start, r.end)} d</small><button type="button" class="tl-remove" data-action="tl-vac-remove" data-index="${i}" aria-label="Quitar ${escape(r.name || r.start)}">×</button></div>`).join('');
    return `<section class="tl-vacations" aria-label="${escape(label)}"><header><strong>${escape(label)}</strong><small>${years.join('–')}</small>${isDefault(ui.vacations, who, years) ? '<span class="pill" title="Inventadas: cámbialas por las reales">Por defecto</span>' : '<button type="button" class="button small" data-action="tl-vac-reset">Restablecer</button>'}<button type="button" class="close" data-action="tl-vac-close" aria-label="Cerrar">×</button></header>${rows ? `<div class="tl-vac-list">${rows}</div>` : '<p class="tl-none">Sin días</p>'}<button type="button" class="button small" data-action="tl-vac-add">+ Añadir</button></section>`;
  })();

  const header = (() => {
    let months = '', daysHtml = '';
    for (let i = 0; i < days; i++) {
      const day = addDay(timeline.start, i), date = new Date(`${day}T00:00:00Z`), weekday = date.getUTCDay();
      if (i === 0 || date.getUTCDate() === 1) months += `<span class="tl-month" style="left:${i * dayWidth}px">${escape(date.toLocaleDateString('es', dayWidth < 6 ? { month: 'short', year: '2-digit', timeZone: 'UTC' } : { month: 'long', year: 'numeric', timeZone: 'UTC' }))}</span>`;
      if (!narrow) daysHtml += `<span class="tl-day ${capacity('', i) ? '' : 'off'} ${weekday === 1 ? 'week' : ''}" title="${escape(shortDate(day))}">${date.getUTCDate()}</span>`;
      else if (weekday === 1 && dayWidth * 7 >= 20) daysHtml += `<span class="tl-week" style="left:${i * dayWidth}px" title="Semana del ${escape(shortDate(day))}">${date.getUTCDate()}</span>`;
    }
    return `<div class="tl-row tl-header"><div class="tl-label"><span></span><span>Tarea</span><span>h</span><span>Quién</span><span>Después de</span></div><div class="tl-track"><div class="tl-months">${months}</div><div class="tl-days">${daysHtml}</div></div></div>`;
  })();
  const offDays = Array.from({ length: days }, (_, i) => capacity('', i) ? '' : `<span style="left:${i * dayWidth}px"></span>`).join('');
  const bar = (p, owner, label, title, classes = '') => { const px = Math.max(3, (p.end - p.start) * dayWidth); return `<div class="tl-bar ${classes}" style="${style(owner)};left:${p.start * dayWidth}px;width:${px}px" title="${escape(title)}">${px >= 18 ? label : ''}</div>`; };
  const memberOptions = owner => `<option value="" ${owner === '' ? 'selected' : ''}>Sin asignar</option>${(ws.members ?? []).map(m => `<option value="${escape(memberKey(m))}" ${memberKey(m) === owner ? 'selected' : ''}>${escape(m.displayName)}</option>`).join('')}${owner && !(ws.members ?? []).some(m => memberKey(m) === owner) ? `<option value="${escape(owner)}" selected>${escape(memberName(owner))}</option>` : ''}`;
  const rows = groups.map(g => {
    const s = plan.stories.get(g.story.id);
    const storyRow = `<div class="tl-row tl-story-row" data-tl-row="story:${g.story.id}"><div class="tl-label"><button type="button" class="tl-handle" draggable="true" data-tl-drag="story:${g.story.id}" aria-label="Mover #${g.story.id}; flechas arriba y abajo" title="Arrastra para cambiar el orden">⋮⋮</button><span class="tl-title" title="${escape(g.story.title)}"><span class="node-type kind-2">${escape(g.story.type)}</span>${escape(g.story.title)} <small>${taskLink(g.story)}</small></span><span class="tl-hours">${number(s.hours ?? 0)}</span><span class="tl-who">${g.tasks.length ? escape(range(dayFrom(timeline.start, s.start), dayAt(timeline.start, s.end))) : 'Sin tareas abiertas'}</span><select data-tl-story-after="${g.story.id}" aria-label="#${g.story.id} empieza después de" class="${g.after ? 'set' : ''}">${afterOptions(groups, null, g.story.id, g.after)}</select><button type="button" class="tl-remove" data-action="tl-remove-story" data-story="${g.story.id}" aria-label="Quitar #${g.story.id}" title="Quitar de la línea temporal">×</button></div><div class="tl-track">${g.tasks.length && s.end > s.start ? `<div class="tl-span" style="left:${s.start * dayWidth}px;width:${(s.end - s.start) * dayWidth}px"></div>` : ''}</div></div>`;
    return storyRow + g.tasks.map(t => {
      const p = plan.tasks.get(t.id), name = t.owner ? memberName(t.owner) : 'Sin asignar';
      const classes = [t.estimated ? '' : 'unestimated', p.loop ? 'loop' : '', p.waits ? 'waits' : '', p.overflow ? 'overflow' : '', t.owner ? '' : 'unassigned'].filter(Boolean).join(' ');
      const title = `#${t.id} ${t.item.title} · ${t.estimated ? `${number(t.hours)} h` : 'sin estimar'} · ${name} · ${range(dayFrom(timeline.start, p.start), dayAt(timeline.start, p.end))}${p.loop ? ' · dependencia en bucle: se ignora' : ''}`;
      return `<div class="tl-row tl-task-row" data-tl-row="task:${t.id}:${g.story.id}"><div class="tl-label"><button type="button" class="tl-handle" draggable="true" data-tl-drag="task:${t.id}:${g.story.id}" aria-label="Mover #${t.id}; flechas arriba y abajo" title="Arrastra para ordenar; suéltala sobre una tarea de otra US para que vaya después">⋮⋮</button><span class="tl-title" title="${escape(t.item.title)}">${escape(t.item.title)} <small>${taskLink(t.item)}</small></span><span class="tl-hours ${t.estimated ? '' : 'missing'}">${t.estimated ? number(t.hours) : '?'}</span><select class="tl-who ${t.changed ? 'changed' : ''}" data-tl-owner="${t.id}" aria-label="Quién hace #${t.id}" style="${style(t.owner)}">${memberOptions(t.owner)}</select><select data-tl-after="${t.id}" aria-label="#${t.id} va después de" class="${t.after ? 'set' : ''}">${afterOptions(groups, t.id, g.story.id, t.after)}</select></div><div class="tl-track">${vacationSpans(t.owner).map(v => `<span class="tl-vac" style="left:${v.from * dayWidth}px;width:${(v.to - v.from) * dayWidth}px" title="${escape(v.name || 'Vacaciones')}"></span>`).join('')}${bar(p, t.owner, escape(t.owner ? initials(name) : '?'), title, classes)}</div></div>`;
    }).join('');
  }).join('');
  const zoom = `<div class="tl-zoom" role="group" aria-label="Zoom del calendario"><button type="button" class="button small" data-action="tl-zoom" data-step="-1" aria-label="Alejar" title="Alejar (Ctrl + rueda o pellizco)" ${!fit && dayWidth <= ZOOM_LEVELS[0] ? 'disabled' : ''}>−</button><button type="button" class="button small" data-action="tl-zoom" data-step="1" aria-label="Acercar" title="Acercar (Ctrl + rueda o pellizco)" ${!fit && dayWidth >= ZOOM_LEVELS.at(-1) ? 'disabled' : ''}>+</button><button type="button" class="button small ${fit ? 'active' : ''}" data-action="tl-zoom" data-fit aria-pressed="${fit}" title="Ver toda la línea temporal a la vez">Todo</button><button type="button" class="button small" data-action="tl-zoom" data-reset ${!fit && dayWidth === DAY_WIDTH ? 'disabled' : ''} title="Volver a ver los días">Días</button></div>`;
  const gantt = groups.length ? `${zoom}<div class="tl-scroll" data-tl-scroll><div class="tl-grid ${narrow ? 'tl-narrow' : ''} ${dayWidth < 12 || fit ? 'tl-compact' : ''}" style="--tl-day:${dayWidth}px;--tl-days:${days};--tl-monday:${firstMonday * dayWidth}px">${header}<div class="tl-body"><div class="tl-off" aria-hidden="true">${offDays}${today >= 0 && today < days ? `<span class="tl-today" style="left:${today * dayWidth}px" title="Hoy"></span>` : ''}</div>${rows}</div></div></div>` : '';
  return `<section class="timeline-page">${tabs}${toolbar}${picker}${people}${editor}${gantt}</section>`;
}
