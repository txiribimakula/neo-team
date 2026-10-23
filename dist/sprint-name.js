// New iterations: their name comes from a template and their dates follow the
// cadence of the last ones. {n} continues the number of the previous iteration;
// {semana}, {mes}, {año} and {día} come from the start date. Each token takes an
// offset, such as {semana+1} (the week after the start) or {n-1}.
export const SPRINT_TOKENS = ['{n}', '{semana}', '{semana+1}', '{año}', '{mes}', '{día}'];
const TOKEN = /\{\s*(n|semana|a[ñn]i?o|mes|d[ií]a)\s*(?:([+-])\s*(\d{1,3}))?\s*\}/gi;
// Characters Azure DevOps does not accept in an iteration name.
const INVALID = /[\\/$?*:"&<>#%|+\u0000-\u001f]/;
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

export function sprintName(template, { startDate, previousName = '' }) {
  return String(template ?? '').replace(TOKEN, (_, token, sign, amount) => {
    const offset = (sign === '-' ? -1 : 1) * Number(amount ?? 0), kind = token.toLowerCase();
    if (kind === 'n') return String(lastNumber(previousName) + 1 + offset);
    if (!valid(startDate)) return '';
    if (kind === 'semana') return pad(isoWeek(addDays(startDate, offset * 7)));
    if (kind === 'mes') { const date = at(startDate); date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + offset); return pad(date.getUTCMonth() + 1); }
    if (kind.startsWith('d')) return pad(at(addDays(startDate, offset)).getUTCDate());
    return String(at(startDate).getUTCFullYear() + offset);
  }).replace(/\s+/g, ' ').trim();
}

// The template of the last iteration: its last number becomes {n}.
export function guessTemplate(previousName) {
  const name = String(previousName ?? '').trim();
  if (!name) return 'Sprint {n}';
  return /\d/.test(name) ? name.replace(/(\d+)(?!.*\d)/, '{n}') : `${name} {n}`;
}

export function nameProblem(name) {
  if (!name) return 'Escribe el nombre de la iteración.';
  if (name.length > 255) return 'El nombre no puede tener más de 255 caracteres.';
  if (INVALID.test(name) || /^\.+$/.test(name)) return 'El nombre no puede contener \\ / $ ? * : " & < > # % | +';
  return '';
}

const dated = iterations => iterations.filter(i => valid(day(i.attributes?.startDate)) && valid(day(i.attributes?.finishDate))).sort((a, b) => day(a.attributes.startDate).localeCompare(day(b.attributes.startDate)));
export const latestIteration = iterations => dated(iterations).at(-1) ?? iterations.at(-1) ?? null;

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
