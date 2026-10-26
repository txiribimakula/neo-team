import test from 'node:test';
import assert from 'node:assert/strict';
import { timelineGroups, capacityModel, scheduleTimeline, timelinePicker, newTimeline, dayAt, dayFrom, timelineView } from '../dist/timeline.js';
import { cleanTimeline, saveTimeline, removeTimeline } from '../server/timelines.js';

// Monday 2 November 2026: two weeks of one iteration, Ana 6 h/day and Luis 4 h/day.
const workspace = () => ({
  settings: { workingDays: [1, 2, 3, 4, 5] },
  members: [{ id: 'a', displayName: 'Ana Pérez', uniqueName: 'ana@x' }, { id: 'l', displayName: 'Luis Gil', uniqueName: 'luis@x' }],
  iterations: [{ id: 'it1', attributes: { startDate: '2026-11-02T00:00:00Z', finishDate: '2026-11-13T00:00:00Z' } }],
  effectiveCapacities: { it1: { daysOff: [], teamMembers: [
    { teamMember: { id: 'a' }, activities: [{ capacityPerDay: 6 }], daysOff: [] },
    { teamMember: { id: 'l' }, activities: [{ capacityPerDay: 4 }], daysOff: [{ start: '2026-11-03', end: '2026-11-03' }] },
  ] } },
  effectiveItems: [
    { id: 1, type: 'User Story', title: 'Alta', state: 'Active', priority: 1 },
    { id: 11, type: 'Task', title: 'API', parent: 1, state: 'New', remainingWork: 6, assignedTo: 'ana@x' },
    { id: 12, type: 'Task', title: 'UI', parent: 1, state: 'New', remainingWork: 12, assignedTo: 'ana@x' },
    { id: 13, type: 'Task', title: 'Hecha', parent: 1, state: 'Closed', remainingWork: 3, assignedTo: 'ana@x' },
    { id: 2, type: 'User Story', title: 'Baja', state: 'New', priority: 2 },
    { id: 21, type: 'Task', title: 'Script', parent: 2, state: 'New', remainingWork: 4, assignedTo: 'luis@x' },
    { id: 22, type: 'Bug', title: 'Sin horas', parent: 2, state: 'New', remainingWork: null, assignedTo: '' },
    { id: 3, type: 'User Story', title: 'Cerrada', state: 'Closed' },
  ],
});
const plan = (ws, timeline) => scheduleTimeline(timelineGroups(ws, timeline), capacityModel(ws, timeline));
const base = () => ({ ...newTimeline('t1', 'Q4', '2026-11-02'), stories: [1, 2] });

test('one person works through their tasks in order; others run in parallel', () => {
  const ws = workspace(), result = plan(ws, base());
  assert.deepEqual([...result.tasks.keys()].sort(), [11, 12, 21, 22]);
  assert.deepEqual(result.tasks.get(11), { start: 0, end: 1, loop: false, waits: false });
  assert.equal(result.tasks.get(12).start, 1);
  assert.equal(result.tasks.get(12).end, 3);
  assert.equal(result.tasks.get(21).start, 0);
  assert.equal(result.tasks.get(21).end, 1);
  assert.equal(result.end, 3);
  assert.equal(dayAt('2026-11-02', result.end), '2026-11-04');
  assert.equal(result.unestimated, 1);
  assert.equal(result.hours, 22);
});

test('reordering and a second person shorten the timeline', () => {
  const ws = workspace(), timeline = { ...base(), order: [12, 11] };
  let result = plan(ws, timeline);
  assert.equal(result.tasks.get(12).start, 0);
  assert.equal(result.tasks.get(11).start, 2);
  timeline.owners = { 11: 'luis@x' };
  result = plan(ws, timeline);
  // Ana only has the UI left; Luis does the API before his script (its story comes
  // first), finishing on Wednesday because Tuesday is his day off.
  assert.equal(result.tasks.get(12).end, 2);
  assert.equal(result.tasks.get(11).end, 2.5);
  assert.equal(result.tasks.get(21).start, 2.5);
  assert.equal(timelineGroups(ws, timeline)[0].tasks.find(t => t.id === 11).changed, true);
});

test('a task can wait for a task or a whole story of another one', () => {
  const ws = workspace(), timeline = { ...base(), after: { 21: 't:12' } };
  let result = plan(ws, timeline);
  assert.equal(result.tasks.get(21).start, 3);
  assert.equal(result.tasks.get(21).waits, true);
  timeline.after = {}; timeline.storyAfter = { 2: 's:1' };
  result = plan(ws, timeline);
  assert.equal(result.tasks.get(21).start, 3);
  assert.equal(result.tasks.get(22).start, 3);
});

test('days off, weekends and rates move the work', () => {
  const ws = workspace(), timeline = { ...base(), stories: [2], owners: { 21: 'luis@x' } };
  ws.effectiveItems.find(i => i.id === 21).remainingWork = 8;
  // Monday 4 h, Tuesday off, Wednesday 4 h.
  assert.equal(plan(ws, timeline).tasks.get(21).end, 3);
  timeline.rates = { 'luis@x': 8 };
  assert.equal(plan(ws, timeline).tasks.get(21).end, 1);
  // Friday start: the rest goes on Monday.
  timeline.start = '2026-11-06'; timeline.rates = {};
  const result = plan(ws, timeline);
  assert.equal(dayFrom(timeline.start, result.tasks.get(21).start), '2026-11-06');
  assert.equal(dayAt(timeline.start, result.tasks.get(21).end), '2026-11-09');
});

test('a loop of predecessors is broken instead of hanging', () => {
  const ws = workspace(), timeline = { ...base(), after: { 11: 't:21', 21: 't:11' } };
  const result = plan(ws, timeline);
  assert.equal(result.tasks.size, 4);
  assert.equal(result.loops, 1);
});

test('the backlog to choose from shows branches down to the stories, as in Planificación', () => {
  const ws = workspace();
  ws.effectiveItems.push(
    { id: 5, type: 'Feature', title: 'Pagos', state: 'Active' },
    { id: 6, type: 'Historia de usuario', title: 'Cobro con tarjeta', parent: 5, state: 'Nuevo', contextOnly: true },
    { id: 61, type: 'Task', title: 'Pasarela', parent: 6, state: 'New', remainingWork: 5, assignedTo: 'ana@x' },
    { id: 7, type: 'Requisito', title: 'Sin tareas', parent: 5, state: 'New' },
  );
  ws.effectiveItems.find(i => i.id === 1).parent = 5;
  const timeline = { ...base(), stories: [6] }, html = timelinePicker(ws, timeline);
  assert.match(html, /data-tl-branch="5"/);
  assert.match(html, /data-tl-stories="1,6,7"/);
  assert.match(html, /class="partial"/);
  assert.match(html, /data-tl-story="6" checked/);
  assert.match(html, /#6 · contexto/);
  assert.match(html, /data-tl-story="7"/);
  assert.match(html, /data-tl-story="2"/);
  assert.doesNotMatch(html, /data-tl-story="3"/);
  assert.doesNotMatch(html, /data-tl-story="61"/);
  // A matching branch keeps everything below it; otherwise only what matches.
  assert.match(timelinePicker(ws, timeline, 'pagos'), /data-tl-story="7"/);
  const card = timelinePicker(ws, timeline, 'tarjeta');
  assert.match(card, /data-tl-story="6"/);
  assert.doesNotMatch(card, /data-tl-story="7"/);
  assert.match(timelinePicker(ws, timeline, 'nada así'), /Nada coincide/);
  assert.equal(plan(ws, timeline).tasks.get(61).end, 1 - 1 / 6);
});

test('the view lays out stories, tasks and people', () => {
  const ws = workspace(), html = timelineView(ws, { list: [base()], id: 't1' }, { memberName: v => ws.members.find(m => m.uniqueName === v)?.displayName ?? v, taskLink: item => `#${item.id}` });
  assert.match(html, /data-tl-row="story:1"/);
  assert.match(html, /data-tl-row="task:12:1"/);
  assert.match(html, /Ana Pérez/);
  assert.match(html, /Sin asignar/);
  assert.doesNotMatch(html, /Hecha/);
  assert.doesNotMatch(html, /download-hierarchy/);
  ws.mode = 'azure';
  const azure = timelineView(ws, { list: [base()], id: 't1' }, { memberName: v => v, taskLink: item => `#${item.id}` });
  assert.match(azure, /data-action="download-hierarchy"/);
  assert.match(azure, /id="backlog-progress"/);
});

test('saved timelines are validated', () => {
  const clean = cleanTimeline({ id: 'abc', name: '  Q4 ', start: '2026-11-02', stories: [1, 1, 'x', 2], order: [3], owners: { 3: 'ana@x', bad: 1 }, after: { 3: 't:4', 5: 'drop' }, storyAfter: { 2: 's:1' }, rates: { 'ana@x': 5, 'luis@x': 99 } });
  assert.deepEqual(clean, { id: 'abc', name: 'Q4', start: '2026-11-02', stories: [1, 2], order: [3], owners: { 3: 'ana@x' }, after: { 3: 't:4' }, storyAfter: { 2: 's:1' }, rates: { 'ana@x': 5 } });
  assert.throws(() => cleanTimeline({ id: '../x', start: '2026-11-02' }));
  assert.throws(() => cleanTimeline({ id: 'x', start: 'mañana' }));
  let list = saveTimeline([], clean);
  list = saveTimeline(list, { ...clean, name: 'Otro' });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Otro');
  assert.deepEqual(removeTimeline(list, 'abc'), []);
});
