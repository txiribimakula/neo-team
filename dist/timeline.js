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

// Hours each person can work on each day of the timeline: working days only, without
// team or personal days off, at the capacity of the iteration of that day. A rate
// set in the timeline replaces it; outside any iteration the person's usual one applies.
export function capacityModel(ws, timeline) {
  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const workingDays = ws.settings?.workingDays ?? [1, 2, 3, 4, 5];
  const isWorking = day => { const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); return workingDays.some(d => d === weekday || String(d).toLowerCase() === names[weekday]); };
  const capacities = ws.effectiveCapacities ?? ws.capacities ?? {};
  const iterations = (ws.iterations ?? []).filter(i => dayOf(i.attributes?.startDate) && dayOf(i.attributes?.finishDate))
    .map(i => ({ start: dayOf(i.attributes.startDate), end: dayOf(i.attributes.finishDate), capacity: capacities[i.id] ?? {} }));
  const within = (ranges, day) => (ranges ?? []).some(r => day >= dayOf(r.start) && day <= dayOf(r.end));
  const daily = record => (record?.activities ?? []).reduce((sum, a) => sum + Number(a.capacityPerDay || 0), 0);
  const memberOf = owner => owner ? ws.members?.find(m => memberKey(m) === owner) : null;
  const recordOf = (capacity, member) => member ? capacity.teamMembers?.find(m => m.teamMember?.id === member.id) : null;
  const usual = new Map();
  const usualOf = owner => {
    if (usual.has(owner)) return usual.get(owner);
    const member = memberOf(owner);
    let value = Math.max(0, ...iterations.map(i => daily(recordOf(i.capacity, member))));
    if (!value) {
      const team = (ws.members ?? []).map(m => Math.max(0, ...iterations.map(i => daily(recordOf(i.capacity, m))))).filter(v => v > 0);
      value = team.length ? Math.round(team.reduce((a, b) => a + b, 0) / team.length * 100) / 100 : 6;
    }
    usual.set(owner, value);
    return value;
  };
  const cache = new Map();
  const capacity = (owner, index) => {
    const cacheKey = `${owner}|${index}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const day = addDay(timeline.start, index), member = memberOf(owner);
    let value = 0;
    if (isWorking(day)) {
      const current = iterations.filter(i => day >= i.start && day <= i.end);
      const record = current.map(i => recordOf(i.capacity, member)).find(Boolean);
      if (!current.some(i => within(i.capacity.daysOff, day)) && !within(record?.daysOff, day)) {
        const rate = Number(timeline.rates?.[owner]);
        value = rate > 0 ? rate : daily(record) > 0 ? daily(record) : usualOf(owner);
      }
    }
    cache.set(cacheKey, value);
    return value;
  };
  capacity.usual = usualOf;
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

const DAY_WIDTH = 26;
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
  const groups = timelineGroups(ws, timeline), capacity = capacityModel(ws, timeline), plan = scheduleTimeline(groups, capacity);
  const owners = [...new Set([...groups.flatMap(g => g.tasks.map(t => t.owner))])].sort((a, b) => (a === '') - (b === '') || memberName(a).localeCompare(memberName(b)));
  const hue = new Map(owners.map((owner, index) => [owner, owner ? (index * 67 + 145) % 360 : -1]));
  const style = owner => hue.get(owner) < 0 ? '--tl-hue:0;--tl-sat:0%' : `--tl-hue:${hue.get(owner)}`;
  const changed = groups.flatMap(g => g.tasks).filter(t => t.changed).length;
  // At least six weeks, so the calendar fills the screen; a week more than the work.
  const days = Math.min(730, Math.max(42, Math.ceil(plan.end) + 7));
  const today = Math.round((Date.parse(new Date().toISOString().slice(0, 10)) - Date.parse(timeline.start)) / 86400000);
  const range = (from, to) => from === to ? shortDate(from) : `${shortDate(from)} → ${shortDate(to)}`;
  const facts = groups.length ? [plan.hours ? `Fin ${shortDate(dayAt(timeline.start, plan.end))}` : '', `${number(plan.hours)} h`, plan.unestimated ? `${plan.unestimated} sin estimar` : '', plan.loops ? `${plan.loops} en bucle` : ''].filter(Boolean) : [];

  const toolbar = `<div class="tl-toolbar"><input class="tl-name" data-tl-field="name" value="${escape(timeline.name)}" maxlength="120" aria-label="Nombre de la línea temporal"><label class="tl-start">Inicio <input type="date" data-tl-field="start" value="${escape(timeline.start)}" required></label><span class="tl-facts">${facts.map(f => `<span>${escape(f)}</span>`).join('')}</span>${changed ? `<button type="button" class="button small primary" data-action="tl-apply-owners" title="Guardar los responsables cambiados como cambios locales, pendientes de sincronizar">Aplicar responsables · ${changed}</button>` : ''}<button type="button" class="button small ${ui.confirmDelete ? 'danger' : ''}" data-action="tl-delete">${ui.confirmDelete ? '¿Eliminar?' : 'Eliminar'}</button></div>`;
  const picker = `<details class="tl-picker" ${ui.pickerOpen ?? !groups.length ? 'open' : ''} data-tl-picker><summary>User stories <span class="count">${groups.length}</span></summary><div class="tl-picker-tools"><input class="search" data-tl-search placeholder="Buscar rama o user story" aria-label="Buscar en el backlog" value="${escape(ui.search ?? '')}"><button type="button" class="button small" data-action="tl-expand">Expandir</button><button type="button" class="button small" data-action="tl-collapse">Plegar</button></div><div class="tl-choices" id="tl-choices">${timelinePicker(ws, timeline, ui.search ?? '', ui.collapsed)}</div></details>`;
  const people = owners.length ? `<div class="tl-people" aria-label="Personas">${owners.map(owner => {
    const p = plan.people.get(owner), rate = timeline.rates?.[owner];
    return `<div class="tl-person" style="${style(owner)}"><span class="tl-avatar" aria-hidden="true">${owner ? escape(initials(memberName(owner))) : '?'}</span><span class="tl-person-name">${escape(owner ? memberName(owner) : 'Sin asignar')}<small>${number(p.hours)} h · ${p.hours ? shortDate(dayAt(timeline.start, p.end)) : '—'}</small></span><label class="tl-rate" title="Horas al día en esta línea temporal; vacío usa su capacidad"><input type="number" min="0" max="24" step="0.5" data-tl-rate="${escape(owner)}" value="${rate ?? ''}" placeholder="${number(capacity.usual(owner))}" aria-label="Horas al día de ${escape(owner ? memberName(owner) : 'sin asignar')}">h/d</label></div>`;
  }).join('')}</div>` : '';

  const header = (() => {
    let months = '', daysHtml = '';
    for (let i = 0; i < days; i++) {
      const day = addDay(timeline.start, i), date = new Date(`${day}T00:00:00Z`), weekday = date.getUTCDay();
      if (i === 0 || date.getUTCDate() === 1) months += `<span class="tl-month" style="left:${i * DAY_WIDTH}px">${escape(date.toLocaleDateString('es', { month: 'long', year: 'numeric', timeZone: 'UTC' }))}</span>`;
      daysHtml += `<span class="tl-day ${capacity('', i) ? '' : 'off'} ${weekday === 1 ? 'week' : ''}" title="${escape(shortDate(day))}">${date.getUTCDate()}</span>`;
    }
    return `<div class="tl-row tl-header"><div class="tl-label"><span></span><span>Tarea</span><span>h</span><span>Quién</span><span>Después de</span></div><div class="tl-track"><div class="tl-months">${months}</div><div class="tl-days">${daysHtml}</div></div></div>`;
  })();
  const offDays = Array.from({ length: days }, (_, i) => capacity('', i) ? '' : `<span style="left:${i * DAY_WIDTH}px"></span>`).join('');
  const bar = (p, owner, label, title, classes = '') => `<div class="tl-bar ${classes}" style="${style(owner)};left:${p.start * DAY_WIDTH}px;width:${Math.max(4, (p.end - p.start) * DAY_WIDTH)}px" title="${escape(title)}">${label}</div>`;
  const memberOptions = owner => `<option value="" ${owner === '' ? 'selected' : ''}>Sin asignar</option>${(ws.members ?? []).map(m => `<option value="${escape(memberKey(m))}" ${memberKey(m) === owner ? 'selected' : ''}>${escape(m.displayName)}</option>`).join('')}${owner && !(ws.members ?? []).some(m => memberKey(m) === owner) ? `<option value="${escape(owner)}" selected>${escape(memberName(owner))}</option>` : ''}`;
  const rows = groups.map(g => {
    const s = plan.stories.get(g.story.id);
    const storyRow = `<div class="tl-row tl-story-row" data-tl-row="story:${g.story.id}"><div class="tl-label"><button type="button" class="tl-handle" draggable="true" data-tl-drag="story:${g.story.id}" aria-label="Mover #${g.story.id}; flechas arriba y abajo" title="Arrastra para cambiar el orden">⋮⋮</button><span class="tl-title" title="${escape(g.story.title)}"><span class="node-type kind-2">${escape(g.story.type)}</span>${escape(g.story.title)} <small>${taskLink(g.story)}</small></span><span class="tl-hours">${number(s.hours ?? 0)}</span><span class="tl-who">${g.tasks.length ? escape(range(dayFrom(timeline.start, s.start), dayAt(timeline.start, s.end))) : 'Sin tareas abiertas'}</span><select data-tl-story-after="${g.story.id}" aria-label="#${g.story.id} empieza después de" class="${g.after ? 'set' : ''}">${afterOptions(groups, null, g.story.id, g.after)}</select><button type="button" class="tl-remove" data-action="tl-remove-story" data-story="${g.story.id}" aria-label="Quitar #${g.story.id}" title="Quitar de la línea temporal">×</button></div><div class="tl-track">${g.tasks.length && s.end > s.start ? `<div class="tl-span" style="left:${s.start * DAY_WIDTH}px;width:${(s.end - s.start) * DAY_WIDTH}px"></div>` : ''}</div></div>`;
    return storyRow + g.tasks.map(t => {
      const p = plan.tasks.get(t.id), name = t.owner ? memberName(t.owner) : 'Sin asignar';
      const classes = [t.estimated ? '' : 'unestimated', p.loop ? 'loop' : '', p.waits ? 'waits' : '', p.overflow ? 'overflow' : '', t.owner ? '' : 'unassigned'].filter(Boolean).join(' ');
      const title = `#${t.id} ${t.item.title} · ${t.estimated ? `${number(t.hours)} h` : 'sin estimar'} · ${name} · ${range(dayFrom(timeline.start, p.start), dayAt(timeline.start, p.end))}${p.loop ? ' · dependencia en bucle: se ignora' : ''}`;
      return `<div class="tl-row tl-task-row" data-tl-row="task:${t.id}:${g.story.id}"><div class="tl-label"><button type="button" class="tl-handle" draggable="true" data-tl-drag="task:${t.id}:${g.story.id}" aria-label="Mover #${t.id}; flechas arriba y abajo" title="Arrastra para ordenar; suéltala sobre una tarea de otra US para que vaya después">⋮⋮</button><span class="tl-title" title="${escape(t.item.title)}">${escape(t.item.title)} <small>${taskLink(t.item)}</small></span><span class="tl-hours ${t.estimated ? '' : 'missing'}">${t.estimated ? number(t.hours) : '?'}</span><select class="tl-who ${t.changed ? 'changed' : ''}" data-tl-owner="${t.id}" aria-label="Quién hace #${t.id}" style="${style(t.owner)}">${memberOptions(t.owner)}</select><select data-tl-after="${t.id}" aria-label="#${t.id} va después de" class="${t.after ? 'set' : ''}">${afterOptions(groups, t.id, g.story.id, t.after)}</select></div><div class="tl-track">${bar(p, t.owner, escape(t.owner ? initials(name) : '?'), title, classes)}</div></div>`;
    }).join('');
  }).join('');
  const gantt = groups.length ? `<div class="tl-scroll" data-tl-scroll><div class="tl-grid" style="--tl-day:${DAY_WIDTH}px;--tl-days:${days}">${header}<div class="tl-body"><div class="tl-off" aria-hidden="true">${offDays}${today >= 0 && today < days ? `<span class="tl-today" style="left:${today * DAY_WIDTH}px" title="Hoy"></span>` : ''}</div>${rows}</div></div></div>` : '';
  return `<section class="timeline-page">${tabs}${toolbar}${picker}${people}${gantt}</section>`;
}
