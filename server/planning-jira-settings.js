export const PLANNING_SECTIONS = ['estimates', 'development'];
export function planningSection(value = 'estimates') {
  if (!PLANNING_SECTIONS.includes(value)) throw Object.assign(new Error('Sección de planificación no válida.'), { status: 400 });
  return value;
}
// The former shared query supplies both tabs until each is saved independently.
export function planningFilters(data, fallback = '') {
  const saved = data.planningJiraFilters?.[data.mode];
  if (typeof saved === 'string') return { estimates: saved, development: saved };
  return Object.fromEntries(PLANNING_SECTIONS.map(section => [section, saved?.[section] ?? fallback]));
}
export function savePlanningFilter(data, section, filter, fallback = '') {
  section = planningSection(section);
  data.planningJiraFilters = { ...data.planningJiraFilters,
    [data.mode]: { ...planningFilters(data, fallback), [section]: filter } };
  return data;
}
