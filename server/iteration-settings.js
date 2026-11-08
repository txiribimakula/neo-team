import { sourcesOf } from './multi-project.js';

// Explicit global settings win. Legacy per-project settings are retained as a
// migration backup; the first configured project supplies a single criterion.
export function globalTemplate(data, sources) {
  const saved = data.iterationTemplates ?? {}, mode = data.mode;
  return data.iterationTemplate?.[mode] ?? saved[mode] ??
    sources.map(s => saved[mode === 'demo' ? `demo:${s.id}` : s.id]).find(Boolean) ?? null;
}
export function saveGlobalTemplate(data, templates) {
  const template = Object.values(templates)[0];
  if (template) data.iterationTemplate = { ...data.iterationTemplate, [data.mode]: template };
  return data;
}

export function migrateIterationTemplates(data) {
  let changed = false;
  for (const mode of ['azure', 'demo']) {
    if (data.iterationTemplate?.[mode]) continue;
    const template = globalTemplate({ ...data, mode }, sourcesOf(data[mode]));
    if (template) {
      data.iterationTemplate = { ...data.iterationTemplate, [mode]: template };
      changed = true;
    }
  }
  return changed;
}
