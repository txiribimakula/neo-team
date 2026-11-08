// New iterations of the team. Each project uses the shared global template and is
// created next to its last iteration (or in the template's folders); the calendar
// is then read again from Azure.
import { sprintName, nameProblem, datesProblem, overlapping, latestIteration, renamePlan, relativePath, folderOf, leafOf, placeName, globalNumbers } from '../dist/sprint-name.js';
import { sourcesOf } from './multi-project.js';
import { refreshSection } from './refresh.js';

const day = value => String(value ?? '').slice(0, 10);
const sameDates = (iteration, startDate, finishDate) => day(iteration.attributes?.startDate) === startDate && day(iteration.attributes?.finishDate) === finishDate;
const cleanTemplate = value => typeof value === 'string' && value.trim() && value.trim().length <= 255 ? value.trim() : '';

// Legacy clients may send a map, but conflicting project criteria are rejected.
export function templatesFor(workspace, input) {
  const values = [...new Set(Object.values(input?.templates ?? {}).map(cleanTemplate).filter(Boolean))];
  if (values.length > 1) throw new Error('Usa un único patrón global para todos los proyectos.');
  const template = cleanTemplate(input?.template) || values[0];
  return template ? Object.fromEntries(sourcesOf(workspace).map(source => [source.id, template])) : {};
}

export function iterationPlan(workspace, input) {
  if (!workspace) throw new Error('Importa un equipo primero.');
  const templates = templatesFor(workspace, input), { startDate, finishDate } = input ?? {};
  if (sourcesOf(workspace).some(source => !templates[source.id])) throw new Error('Escribe el nombre de la iteración.');
  const problem = datesProblem(startDate, finishDate);
  if (problem) throw new Error(problem);
  // A shared iteration with the same dates is joined, as when another project already has it.
  const taken = overlapping(workspace.iterations.filter(i => !sameDates(i, startDate, finishDate)), startDate, finishDate);
  if (taken) throw new Error(`Las fechas se solapan con «${taken.name}».`);
  const numbering = globalNumbers(sourcesOf(workspace));
  const sources = sourcesOf(workspace).map(source => {
    const template = templates[source.id], last = latestIteration(source.iterations);
    const name = sprintName(template, { startDate, number: numbering.numbers.get(`${startDate}/${finishDate}`) ?? Math.max(0, ...numbering.numbers.values()) + 1 });
    const invalid = nameProblem(name);
    if (invalid) throw new Error(invalid);
    // "" is the root of the project; without iterations, the team's backlog iteration.
    const path = placeName(template, name, last ? folderOf(relativePath(last.path)) : relativePath(source.settings?.backlogIteration?.path));
    const existing = source.iterations.find(i => relativePath(i.path).toLowerCase() === path.toLowerCase());
    if (existing && !sameDates(existing, startDate, finishDate)) throw new Error(`«${path}» ya existe en ${source.config.project}.`);
    const clash = !existing && overlapping(source.iterations, startDate, finishDate);
    if (clash) throw new Error(`Las fechas se solapan con «${clash.name}» de ${source.config.project}.`);
    return { source, name: leafOf(path), exists: !!existing, parentPath: folderOf(path) };
  });
  return { templates, startDate, finishDate, sources };
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

// Every dated project iteration uses the global template and range counter.
// Identifiers, work items and original dates stay attached to the iteration.
export function iterationRenames(workspace, input, today) {
  if (!workspace) throw new Error('Importa un equipo primero.');
  if (Object.keys(workspace.drafts ?? {}).length || Object.keys(workspace.capacityDrafts ?? {}).length || workspace.pendingComments?.length) throw new Error('Sincroniza o descarta los cambios pendientes antes de renombrar iteraciones.');
  if (workspace.mode === 'azure' && sourcesOf(workspace).some(s => !s.projectIterations)) throw new Error('Actualiza las iteraciones para revisar el histórico completo antes de renombrar.');
  const templates = templatesFor(workspace, input);
  const numbering = globalNumbers(sourcesOf(workspace));
  const sources = sourcesOf(workspace).filter(source => templates[source.id]).map(source => {
    const iterations = source.projectIterations ?? source.iterations;
    const { renames, problem } = renamePlan(iterations, templates[source.id], today, numbering.forIterations(iterations));
    if (problem) throw new Error(`${source.config.project}: ${problem}`);
    return { source, renames };
  });
  if (!sources.some(s => s.renames.length)) throw new Error('Las iteraciones ya siguen el criterio.');
  return { templates, sources };
}

// Other teams of each project that use the iterations to rename: the change reaches them too.
export async function sharedIterations(plan, azure, report = () => {}) {
  const shared = {};
  for (const { source, renames } of plan.sources) {
    if (!renames.length) continue;
    report({ phase: 'iterations', message: `${source.config.project} · Buscando otros equipos que usan estas iteraciones…` });
    await azure.open(source.config);
    const teams = {};
    for (let offset = 0; offset < renames.length; offset += 500) Object.assign(teams, await azure.iterationTeams(source.config, renames.slice(offset, offset + 500).map(r => r.id)));
    shared[source.id] = Object.fromEntries(Object.entries(teams).filter(([, names]) => names.length));
  }
  return shared;
}

// The new paths in the local copy: the project's iterations and, where they point
// at them, the work items and the team's default iteration.
export function renameLocally(workspace, done) {
  for (const { source, rename } of done) {
    const target = sourcesOf(workspace).find(s => s.id === source.id);
    const copies = [...(target?.iterations ?? []), ...(target?.projectIterations ?? [])].filter(i => i.id === rename.id);
    if (!copies.length) continue;
    const before = copies[0].path, after = [before.split('\\')[0], rename.to].join('\\');
    for (const iteration of copies) Object.assign(iteration, { path: after, name: leafOf(rename.to) });
    for (const item of workspace.items ?? []) if (item.iterationPath === before) item.iterationPath = after;
    for (const settings of [workspace.settings, ...(workspace.sources ?? []).map(s => s.settings)]) if (settings?.defaultIteration?.path === before) settings.defaultIteration = { ...settings.defaultIteration, path: after, name: leafOf(rename.to) };
  }
  return workspace;
}

// One iteration at a time, in the plan's order. If one fails, what was already
// renamed is kept in the local copy and the error says where it stopped: applying
// it again continues with the rest.
export async function renameIterations(workspace, plan, azure, rules, report = () => {}) {
  const done = [], total = plan.sources.reduce((sum, s) => sum + s.renames.length, 0);
  let failure = null;
  try {
    for (const { source, renames } of plan.sources) for (const rename of renames) {
      report({ phase: 'iterations', message: `${source.config.project} (${done.length + 1}/${total}) · «${rename.from}» → «${rename.to}»…` });
      await azure.open(source.config);
      await azure.renameIteration(source.config, { id: rename.id, path: rename.from, parentPath: folderOf(rename.to), name: leafOf(rename.to) });
      done.push({ source, rename });
    }
  } catch (error) { failure = error; }
  let next = renameLocally(structuredClone(workspace), done);
  if (done.length) {
    try { next = await refreshSection(next, 'iterations', azure, rules, report); }
    catch (error) { failure ??= Object.assign(new Error(`Las iteraciones se han renombrado, pero no se pudieron leer de nuevo: ${error.message} Actualiza las iteraciones.`), { status: error.status }); }
  }
  if (failure && done.length < total) failure.message = `Se renombraron ${done.length} de ${total}. ${failure.message} Vuelve a aplicar el criterio para terminar.`;
  return { workspace: next, done: done.length, failure };
}
