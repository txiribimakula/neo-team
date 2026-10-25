// New iterations: their name comes from a template and their dates follow the
// cadence of the last ones. {n} continues the number of the previous iteration;
// {semana}, {mes}, {año} and {día} come from the start date. Each token takes an
// offset, such as {semana+1} (the week after the start) or {n-1}. A "\" separates
// folders: with one, the path starts at the project ("{año}\Sprint {n}"); without
// any, the iteration stays in the folder of the last one.
export const SPRINT_TOKENS = ['{n}', '{semana}', '{semana+1}', '{año}', '{mes}', '{día}', '\\'];
const TOKEN = /\{\s*(n|semana|a[ñn]i?o|mes|d[ií]a)\s*(?:([+-])\s*(\d{1,3}))?\s*\}/gi;
// Characters Azure DevOps does not accept in an iteration name ("\" separates folders).
const INVALID = /[/$?*:"&<>#%|+\u0000-\u001f]/;
const DAY = 86400000;
const day = value => String(value ?? '').slice(0, 10);
const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
const at = value => new Date(`${value}T00:00:00Z`);
export const addDays = (value, days) => new Date(+at(value) + days * DAY).toISOString().slice(0, 10);
const pad = value => String(value).padStart(2, '0');

export function isoWeek(value) {
  const date = at(value), thursday = new Date(+date + (3 - (date.getUTCDay() + 6) % 7) * DAY);
  return Math.floor((thursday - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / (7 * DAY)) + 1;
}

const lastNumber = name => Number(String(name ?? '').match(/(\d+)(?!.*\d)/)?.[1] ?? 0);

// {n} is the given number, or the one after the last number of the previous name.
export function sprintName(template, { startDate, previousName = '', number }) {
  return String(template ?? '').replace(TOKEN, (_, token, sign, amount) => {
    const offset = (sign === '-' ? -1 : 1) * Number(amount ?? 0), kind = token.toLowerCase();
    if (kind === 'n') return String((number ?? lastNumber(previousName) + 1) + offset);
    if (!valid(startDate)) return '';
    if (kind === 'semana') return pad(isoWeek(addDays(startDate, offset * 7)));
    if (kind === 'mes') { const date = at(startDate); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + offset); return pad(date.getUTCMonth() + 1); }
    if (kind.startsWith('d')) return pad(at(addDays(startDate, offset)).getUTCDate());
    return String(at(startDate).getUTCFullYear() + offset);
  }).split('\\').map(part => part.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\\');
}

// The template of the last iteration: its counting number becomes {n}.
export function guessTemplate(previousName, position = 0) {
  const name = String(previousName ?? '').trim();
  if (!name) return 'Sprint {n}';
  const numbers = [...name.matchAll(/\d+/g)], counter = numbers[numbers.length - 1 - position] ?? numbers.at(-1);
  return counter ? name.slice(0, counter.index) + '{n}' + name.slice(counter.index + counter[0].length) : `${name} {n}`;
}

// The name of an iteration, or its path from the project with folders.
export function nameProblem(name) {
  if (!name) return 'Escribe el nombre de la iteración.';
  const parts = name.split('\\');
  if (parts.length > 12) return 'No puede haber más de 11 carpetas.';
  if (parts.some(part => part.length > 255)) return 'El nombre no puede tener más de 255 caracteres.';
  if (parts.some(part => !part || INVALID.test(part) || /^\.+$/.test(part))) return 'El nombre no puede contener / $ ? * : " & < > # % | +';
  return '';
}

const dated = iterations => iterations.filter(i => valid(day(i.attributes?.startDate)) && valid(day(i.attributes?.finishDate))).sort((a, b) => day(a.attributes.startDate).localeCompare(day(b.attributes.startDate)));
export const latestIteration = iterations => dated(iterations).at(-1) ?? iterations.at(-1) ?? null;

// The number that counts the iterations of a team. In names with several numbers it
// is the one (counted from the end) that grows by one from each iteration to the
// next and does not repeat the year, week, month or day of its start. An iteration
// without it follows the previous one.
export function sequence(iterations) {
  const list = [...dated(iterations), ...iterations.filter(i => !dated([i]).length)];
  const numbers = list.map(i => [...String(i.name ?? '').matchAll(/\d+/g)].map(m => Number(m[0])).reverse());
  const width = Math.max(0, ...numbers.map(n => n.length));
  let position = 0, best = -Infinity;
  for (let p = 0; p < width; p++) {
    let score = 0;
    numbers.forEach((n, index) => {
      if (n[p] === undefined) return;
      if (index && numbers[index - 1][p] !== undefined && n[p] - numbers[index - 1][p] === 1) score += 4;
      const start = day(list[index].attributes?.startDate);
      if (!valid(start)) return;
      const date = at(start);
      if (n[p] === date.getUTCFullYear()) score -= 3;
      if (n[p] === isoWeek(start)) score -= 2;
      if (n[p] === date.getUTCMonth() + 1 || n[p] === date.getUTCDate()) score -= 1;
    });
    if (score > best) { best = score; position = p; }
  }
  const byId = new Map();
  let previous = 0;
  list.forEach((i, index) => { previous = numbers[index][position] ?? previous + 1; byId.set(i.id, previous); });
  return { position, numbers: byId };
}

// Paths are relative to the project ("Release\Sprint 4" in "Project\Release\Sprint 4").
export const relativePath = path => String(path ?? '').split('\\').filter(Boolean).slice(1).join('\\');
export const folderOf = path => String(path ?? '').split('\\').slice(0, -1).join('\\');
export const leafOf = path => String(path ?? '').split('\\').at(-1);
// A template with folders places the iteration from the project; without them, it
// stays in the given folder.
export const placeName = (template, name, folder) => String(template ?? '').includes('\\') ? name : [folder, name].filter(Boolean).join('\\');

// The team's iterations with the name a template gives them, each keeping its own
// number. Only dated ones: the date tokens need a start. The renames come in an
// order where no target is still taken by another iteration of the list.
export function renamePlan(iterations, template, today = new Date().toISOString().slice(0, 10)) {
  const { numbers } = sequence(iterations), list = dated(iterations), lower = value => value.toLowerCase();
  const current = list.find(i => day(i.attributes.finishDate) >= today);
  const rows = list.map(i => {
    const from = relativePath(i.path), name = sprintName(template, { startDate: day(i.attributes.startDate), number: numbers.get(i.id) });
    const to = placeName(template, name, folderOf(from));
    const kind = i === current ? 'current' : day(i.attributes.finishDate) < today ? 'past' : 'next';
    return { id: i.id, kind, startDate: day(i.attributes.startDate), finishDate: day(i.attributes.finishDate), from, to, changed: from !== to, problem: nameProblem(name && to) };
  });
  const others = iterations.filter(i => !list.includes(i)).map(i => lower(relativePath(i.path)));
  for (const row of rows) {
    if (row.problem) continue;
    if (rows.some(other => other !== row && lower(other.to) === lower(row.to))) row.problem = 'Dos iteraciones tendrían el mismo nombre.';
    else if (others.includes(lower(row.to))) row.problem = 'Ya hay otra iteración con ese nombre.';
  }
  const pending = rows.filter(r => r.changed), renames = [];
  while (pending.length) {
    const index = pending.findIndex(r => !pending.some(o => o !== r && lower(o.from) === lower(r.to)));
    if (index < 0) return { rows, renames: [], problem: 'Los nombres se intercambian entre iteraciones: renómbralas en dos pasos.' };
    renames.push(...pending.splice(index, 1));
  }
  return { rows, renames, problem: rows.find(r => r.problem)?.problem ?? '' };
}

// The next dates keep the length of the last iteration and the distance between
// the last two. Without dated iterations, two weeks from next Monday.
export function nextDates(iterations, today = new Date().toISOString().slice(0, 10)) {
  const list = dated(iterations), last = list.at(-1), previous = list.at(-2);
  if (!last) {
    const start = addDays(today, (8 - at(today).getUTCDay()) % 7 || 7);
    return { startDate: start, finishDate: addDays(start, 11) };
  }
  const start = day(last.attributes.startDate), finish = day(last.attributes.finishDate), length = Math.round((at(finish) - at(start)) / DAY);
  const cadence = previous ? Math.round((at(start) - at(day(previous.attributes.startDate))) / DAY) : 0;
  const startDate = addDays(start, cadence > length ? cadence : length + 1);
  return { startDate, finishDate: addDays(startDate, length) };
}

export function overlapping(iterations, startDate, finishDate) {
  return dated(iterations).find(i => day(i.attributes.startDate) <= finishDate && startDate <= day(i.attributes.finishDate)) ?? null;
}

export function datesProblem(startDate, finishDate) {
  if (!valid(startDate) || !valid(finishDate)) return 'Indica la fecha de inicio y la de fin.';
  if (finishDate < startDate) return 'La fecha de fin es anterior a la de inicio.';
  if ((at(finishDate) - at(startDate)) / DAY > 366) return 'Una iteración no puede durar más de un año.';
  return '';
}
