// New iterations of the team. Each project gets the name of the template and is
// created next to its last iteration; the calendar is then read again from Azure.
import { sprintName, nameProblem, datesProblem, overlapping, latestIteration } from '../dist/sprint-name.js';
import { sourcesOf } from './multi-project.js';
import { refreshSection } from './refresh.js';

const day = value => String(value ?? '').slice(0, 10);
const sameDates = (iteration, startDate, finishDate) => day(iteration.attributes?.startDate) === startDate && day(iteration.attributes?.finishDate) === finishDate;
// The parent inside the project's iterations: "" is the root of the project.
const parentOf = (path, own) => String(path ?? '').split('\\').filter(Boolean).slice(1, own ? undefined : -1).join('\\');

export function iterationPlan(workspace, input) {
  if (!workspace) throw new Error('Importa un equipo primero.');
  const template = typeof input?.template === 'string' ? input.template.trim() : '', { startDate, finishDate } = input ?? {};
  if (!template || template.length > 255) throw new Error('Escribe el nombre de la iteración.');
  const problem = datesProblem(startDate, finishDate);
  if (problem) throw new Error(problem);
  // A shared iteration with the same dates is joined, as when another project already has it.
  const taken = overlapping(workspace.iterations.filter(i => !sameDates(i, startDate, finishDate)), startDate, finishDate);
  if (taken) throw new Error(`Las fechas se solapan con «${taken.name}».`);
  const sources = sourcesOf(workspace).map(source => {
    const last = latestIteration(source.iterations), name = sprintName(template, { startDate, previousName: last?.name });
    const invalid = nameProblem(name);
    if (invalid) throw new Error(invalid);
    const existing = source.iterations.find(i => i.name.toLowerCase() === name.toLowerCase());
    if (existing && !sameDates(existing, startDate, finishDate)) throw new Error(`«${name}» ya existe en ${source.config.project}.`);
    const clash = !existing && overlapping(source.iterations, startDate, finishDate);
    if (clash) throw new Error(`Las fechas se solapan con «${clash.name}» de ${source.config.project}.`);
    return { source, name, exists: !!existing, parentPath: last ? parentOf(last.path) : parentOf(source.settings?.backlogIteration?.path, true) };
  });
  return { template, startDate, finishDate, sources };
}

export async function createIteration(workspace, plan, azure, rules, report = () => {}) {
  const { startDate, finishDate } = plan, total = plan.sources.length;
  for (const [index, { source, name, parentPath, exists }] of plan.sources.entries()) {
    if (exists) continue;
    report({ phase: 'iterations', message: `${source.config.project} (${index + 1}/${total}) · Creando «${name}»…` });
    await azure.open(source.config);
    await azure.createIteration(source.config, { parentPath, name, startDate, finishDate });
  }
  const next = await refreshSection(workspace, 'iterations', azure, rules, report);
  if (!next.iterations.some(i => sameDates(i, startDate, finishDate))) throw new Error('La iteración se ha creado en Azure DevOps, pero el equipo todavía no la lista. Actualiza las iteraciones en unos segundos.');
  return next;
}

// The example data: the iteration is added to the local copy only.
export function addDemoIteration(workspace, plan) {
  const { source, name, parentPath } = plan.sources[0], id = `sprint-${Date.now().toString(36)}`;
  const iteration = { id, name, path: [source.config.project, parentPath, name].filter(Boolean).join('\\'), attributes: { startDate: `${plan.startDate}T00:00:00Z`, finishDate: `${plan.finishDate}T00:00:00Z`, timeFrame: 2 } };
  workspace.iterations = [...workspace.iterations, iteration].sort((a, b) => day(a.attributes?.startDate).localeCompare(day(b.attributes?.startDate)));
  workspace.capacities = { ...workspace.capacities, [id]: { daysOff: [], teamMembers: [] } };
  return iteration;
}
