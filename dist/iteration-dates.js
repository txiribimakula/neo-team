// Date proposals are read-only. No existing attribute is changed here.
import { addDays, sprintName, relativePath, datesProblem } from './sprint-name.js';
const DAY = 86400000;
const day = value => String(value ?? '').slice(0, 10);
const valid = value => !datesProblem(value, value);
const instant = value => Date.parse(`${value}T00:00:00Z`);
const distance = (a, b) => Math.round((instant(b) - instant(a)) / DAY);
const normalize = value => String(value ?? '').split('\\').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\\');
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TOKEN = /\{\s*(n|semana|a[ñn]i?o|mes|d[ií]a)\s*(?:([+-])\s*(\d{1,3}))?\s*\}/gi;
function nameReader(template) {
  template = normalize(template);
  const tokens = []; let pattern = '', end = 0;
  for (const match of template.matchAll(TOKEN)) {
    pattern += escapeRegex(template.slice(end, match.index)) + '(\\d+)';
    tokens.push({ kind: match[1].toLowerCase(), offset: (match[2] === '-' ? -1 : 1) * Number(match[3] ?? 0) });
    end = match.index + match[0].length;
  }
  const regex = new RegExp(`^${pattern + escapeRegex(template.slice(end))}$`, 'i');
  return iteration => {
    const name = normalize(template.includes('\\') ? relativePath(iteration.path) : iteration.name);
    const match = name.match(regex);
    if (!match) return null;
    const values = tokens.map((t, i) => ({ ...t, value: Number(match[i + 1]) }));
    if (values.some(t=>!Number.isSafeInteger(t.value))) return null;
    const counters = values.filter(t => t.kind === 'n').map(t => t.value - t.offset);
    if (new Set(counters).size > 1) return null;
    return { name, values, counter: counters[0], matches: startDate => sprintName(template, { startDate, number: counters[0] }).toLowerCase() === name.toLowerCase() };
  };
}
const fullDates = i => valid(day(i.attributes?.startDate)) && valid(day(i.attributes?.finishDate)) && !datesProblem(day(i.attributes.startDate), day(i.attributes.finishDate));

export function inferIterationDates(iterations, template, references = iterations) {
  const read = nameReader(template);
  const anchors = references.filter(fullDates).filter(i=>!i.hasChildren && !references.some(child=>child!==i && child.path?.startsWith(`${i.path}\\`)));
  const durations = [...new Set(anchors.map(i => distance(day(i.attributes.startDate), day(i.attributes.finishDate))))];
  const weekdays = [...new Set(anchors.map(i => new Date(instant(day(i.attributes.startDate))).getUTCDay()))];
  const counterAnchors = anchors.map(i => ({ i, parsed: read(i) })).filter(a => a.parsed?.counter !== undefined && a.parsed.matches(day(a.i.attributes.startDate)));
  const first = counterAnchors[0], cadences = new Set();
  for (const anchor of counterAnchors.slice(1)) {
    const count = anchor.parsed.counter - first.parsed.counter;
    const days = distance(day(first.i.attributes.startDate), day(anchor.i.attributes.startDate));
    if (count) cadences.add(days / count);
    else if (days) cadences.add(NaN);
  }
  const cadence = cadences.size === 1 ? [...cadences][0] : null;
  const result = new Map();
  for (const i of iterations.filter(i => !fullDates(i))) {
    const existingStart = day(i.attributes?.startDate), existingFinish = day(i.attributes?.finishDate);
    const fail = reason => result.set(i.id, { status: 'ambiguous', explanation: reason });
    if (i.hasChildren || iterations.some(child => child !== i && child.path?.startsWith(`${i.path}\\`))) { fail('Es una carpeta con subiteraciones; no se le asignan fechas automáticamente.'); continue; }
    if ((existingStart && !valid(existingStart)) || (existingFinish && !valid(existingFinish)) || (existingStart && existingFinish)) { fail('Hay fechas existentes incoherentes. Revísalas por separado; esta propuesta no las sustituye.'); continue; }
    const parsed = read(i);
    if (!parsed || !parsed.values.length) { fail('El nombre no permite deducir fechas con el patrón global. Debe incluir año y semanas, una fecha o un contador con referencias fechadas.'); continue; }
    if (durations.length !== 1) { fail(anchors.length ? 'Las iteraciones fechadas tienen duraciones distintas; no se puede deducir un tramo único.' : 'Faltan iteraciones fechadas de referencia para deducir la duración y los días del tramo.'); continue; }
    let starts = [], basis = '';
    if (parsed.counter !== undefined && Number.isInteger(cadence) && cadence > 0) {
      const offset = (parsed.counter - first.parsed.counter) * cadence;
      const timestamp = instant(day(first.i.attributes.startDate)) + offset * DAY;
      if (!Number.isFinite(timestamp) || timestamp < instant('0001-01-01') || timestamp > instant('9999-12-31') - durations[0] * DAY) { fail('El contador produciría fechas fuera del calendario admitido; revisa el nombre.'); continue; }
      starts = [addDays(day(first.i.attributes.startDate), offset)];
      basis = `Contador ${parsed.counter}, cadencia de ${cadence} días y referencia «${first.i.name}» (${day(first.i.attributes.startDate)}).`;
    } else {
      const years = [...new Set(parsed.values.filter(t => t.kind.startsWith('a')).map(t => t.value - t.offset))];
      if (years.length > 1) { fail('Los años del nombre no son coherentes con el patrón global.'); continue; }
      let begin, end;
      if (years.length) {
        if (years[0] < 1 || years[0] > 9998) { fail('El año del nombre no es válido.'); continue; }
        begin = `${String(years[0]).padStart(4, '0')}-01-01`; end = `${String(years[0]).padStart(4, '0')}-12-31`;
      } else if (anchors.length > 1 && parsed.values.some(t => t.kind === 'semana' || t.kind === 'mes' || t.kind.startsWith('d'))) {
        const dates = anchors.map(a => day(a.attributes.startDate)).sort();
        begin = dates[0]; end = dates.at(-1);
        basis = 'Año deducido entre referencias fechadas; fuera de ese intervalo el nombre sería ambiguo.';
      } else { fail('Falta un año o una cadencia de contador inequívoca. Añade {año} al patrón o aporta referencias fechadas.'); continue; }
      const exactDay = parsed.values.some(t => t.kind.startsWith('d'));
      if (!exactDay && weekdays.length !== 1) { fail('Las referencias empiezan en distintos días de la semana; no hay un inicio único para este nombre.'); continue; }
      for (let date = begin; date <= end; date = addDays(date, 1)) {
        if ((exactDay || new Date(instant(date)).getUTCDay() === weekdays[0]) && parsed.matches(date)) starts.push(date);
      }
      basis ||= 'Año y calendario del nombre, con el día de inicio y la duración de las referencias fechadas.';
    }
    starts = starts.filter(start => parsed.matches(start) && (!existingStart || start === existingStart) && (!existingFinish || addDays(start, durations[0]) === existingFinish));
    if (starts.length !== 1) { fail(starts.length ? 'Hay varios tramos posibles para este nombre. Añade el año o una referencia que permita distinguirlos.' : 'El nombre, las fechas existentes y las referencias no permiten obtener un tramo compatible.'); continue; }
    const startDate = starts[0], finishDate = addDays(startDate, durations[0]);
    const clash = anchors.find(a => a.path?.split('\\')[0] === i.path?.split('\\')[0] && day(a.attributes.startDate) <= finishDate && startDate <= day(a.attributes.finishDate));
    result.set(i.id, { status: clash ? 'conflict' : 'proposed', startDate, finishDate,
      explanation: `${basis} Duración: ${durations[0] + 1} días naturales. ${clash ? `Se solapa con «${clash.name}»; revisa el conflicto.` : 'Revisa la propuesta antes de asignar fechas.'} Las fechas existentes se conservan; no se guarda ningún cambio.` });
  }
  const project = i => String(i.path ?? '').split('\\')[0].toLowerCase();
  for (const i of iterations) {
    const proposed = result.get(i.id);
    if (!proposed?.startDate) continue;
    const duplicate = iterations.find(other => {
      const dates = result.get(other.id);
      return other !== i && dates?.startDate && project(other) === project(i) && dates.startDate <= proposed.finishDate && proposed.startDate <= dates.finishDate;
    });
    if (duplicate) {
      proposed.status = 'conflict';
      proposed.explanation += ` Se solapa también con la propuesta de «${duplicate.name}».`;
    }
  }
  return result;
}
