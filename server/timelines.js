// Timelines are local plans: they are saved with the workspace, per mode, and never
// reach Azure DevOps. Only their shape is checked; missing stories are kept.
const MAX_TIMELINES = 50, MAX_IDS = 2000;
const ids = value => [...new Set((Array.isArray(value) ? value : []).filter(Number.isInteger))].slice(0, MAX_IDS);
const entries = (value, keep) => Object.fromEntries(Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {}).filter(keep).slice(0, MAX_IDS));
const isId = key => /^-?\d{1,12}$/.test(key);
const isRef = value => typeof value === 'string' && /^[ts]:-?\d{1,12}$/.test(value);

export function cleanTimeline(input) {
  const id = input?.id, start = String(input?.start ?? '');
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('Línea temporal no válida.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(`${start}T00:00:00Z`))) throw new Error('Indica una fecha de inicio válida.');
  return {
    id, name: String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Línea temporal', start,
    stories: ids(input.stories), order: ids(input.order),
    owners: entries(input.owners, ([key, value]) => isId(key) && typeof value === 'string' && value.length <= 255),
    after: entries(input.after, ([key, value]) => isId(key) && isRef(value)),
    storyAfter: entries(input.storyAfter, ([key, value]) => isId(key) && isRef(value)),
    rates: entries(input.rates, ([key, value]) => key.length <= 255 && typeof value === 'number' && value > 0 && value <= 24),
  };
}
export function saveTimeline(list, input) {
  const timeline = cleanTimeline(input), current = Array.isArray(list) ? list : [];
  if (!current.some(t => t.id === timeline.id) && current.length >= MAX_TIMELINES) throw new Error(`Como mucho ${MAX_TIMELINES} líneas temporales.`);
  return current.some(t => t.id === timeline.id) ? current.map(t => t.id === timeline.id ? timeline : t) : [...current, timeline];
}
export const removeTimeline = (list, id) => (Array.isArray(list) ? list : []).filter(t => t.id !== id);
