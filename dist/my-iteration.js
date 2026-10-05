// My iteration: the items assigned to me in the team's current iteration, laid
// out like the Azure DevOps taskboard (parents as rows, task states as columns).
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hours = value => `${new Intl.NumberFormat('es', { maximumFractionDigits: 1 }).format(value)} h`;
const day = value => new Date(value).toLocaleDateString('es', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const sum = cards => cards.reduce((total, card) => total + (Number(card.remainingWork) || 0), 0);
const typeClass = type => `type-${String(type).toLowerCase().replace(/[^a-z]+/g, '-')}`;

// Working days (Monday to Friday) from today to the end of the iteration, both included.
export function workDaysLeft(finishDate, today = new Date().toISOString().slice(0, 10)) {
  const end = Date.parse(String(finishDate ?? '').slice(0, 10)), start = Date.parse(today);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  let count = 0;
  for (let at = start; at <= end; at += 86400000) if (![0, 6].includes(new Date(at).getUTCDay())) count++;
  return count;
}

const itemUrl = (board, id) => `https://dev.azure.com/${encodeURIComponent(board.organization)}/${encodeURIComponent(board.project)}/_workitems/edit/${id}`;
const taskboardUrl = board => `https://dev.azure.com/${encodeURIComponent(board.organization)}/${encodeURIComponent(board.project)}/_sprints/taskboard/${encodeURIComponent(board.team)}/${board.iteration.path.split('\\').map(encodeURIComponent).join('/')}`;
const title = (snapshot, board, item) => snapshot.demo ? `<span>${escape(item.title)}</span>` : `<a href="${itemUrl(board, item.id)}" target="_blank" rel="noopener noreferrer">${escape(item.title)}</a>`;

function card(snapshot, board, item) {
  return `<article class="mi-card ${typeClass(item.type)}"><span class="mi-card-title">${title(snapshot, board, item)}</span><span class="mi-card-meta"><span title="${escape(item.type)}">#${item.id}</span>${item.tags.slice(0, 2).map(t => `<span class="tag">${escape(t)}</span>`).join('')}${item.remainingWork != null ? `<strong title="Trabajo restante">${hours(item.remainingWork)}</strong>` : ''}</span></article>`;
}

function lane(snapshot, board, { parent, cards }) {
  const head = parent
    ? `<span class="mi-parent-type ${typeClass(parent.type)}">${escape(parent.type)}</span><span class="mi-card-title">${title(snapshot, board, parent)}</span><span class="mi-card-meta"><span>#${parent.id}</span><span class="pill">${escape(parent.state)}</span>${!parent.mine && parent.assignedTo ? `<span>${escape(parent.assignedTo)}</span>` : ''}</span>`
    : '<span class="mi-card-title text-muted">Sin padre</span>';
  return `<div class="mi-lane"><div class="mi-parent">${head}${cards.length ? `<strong class="mi-lane-hours" title="Trabajo restante">${hours(sum(cards))}</strong>` : ''}</div>${board.columns.map(column => `<div class="mi-cell${column.category === 'completed' ? ' is-done' : ''}">${cards.filter(c => c.column === column.name).map(c => card(snapshot, board, c)).join('')}</div>`).join('')}</div>`;
}

function boardView(snapshot, board, several, actions = '') {
  const heading = several ? `<h2>${escape(board.project)} · ${escape(board.team)}</h2>` : '';
  if (!board.iteration) return `<section class="mi-board"><header class="mi-board-head"><div>${heading}</div><div class="actions">${actions}</div></header><div class="empty-result">${escape(board.team)} no tiene una iteración en curso.</div></section>`;
  const cards = board.lanes.flatMap(l => l.cards), left = workDaysLeft(board.iteration.finishDate);
  const facts = [board.iteration.startDate && board.iteration.finishDate ? `${day(board.iteration.startDate)} – ${day(board.iteration.finishDate)}` : '', left === null ? '' : `${left} ${left === 1 ? 'día laborable' : 'días laborables'}`, board.me, cards.length ? `${hours(sum(cards))} restantes` : ''].filter(Boolean);
  const link = snapshot.demo ? '' : `<a class="button small" href="${escape(taskboardUrl(board))}" target="_blank" rel="noopener noreferrer" title="Abrir el taskboard en Azure DevOps">Azure DevOps ↗</a>`;
  const top = `<header class="mi-board-head"><div>${heading}<h${several ? 3 : 1}>${escape(board.iteration.name)}</h${several ? 3 : 1}><p>${facts.map(escape).join(' · ')}</p></div><div class="actions">${link}${actions}</div></header>`;
  if (!board.lanes.length) return `<section class="mi-board">${top}<div class="empty-result">No tienes elementos asignados en esta iteración.</div></section>`;
  const columns = board.columns.map(column => { const inColumn = cards.filter(c => c.column === column.name); return `<div class="mi-column">${escape(column.name)} <span>${inColumn.length}</span></div>`; }).join('');
  return `<section class="mi-board">${top}${board.limited ? '<div class="notice warning">Se muestran los primeros 1000 elementos.</div>' : ''}<div class="mi-scroll"><div class="mi-grid" style="--mi-columns:${board.columns.length}"><div class="mi-lane mi-head"><div></div>${columns}</div>${board.lanes.map(l => lane(snapshot, board, l)).join('')}</div></div></section>`;
}

export function myIterationView(snapshot, state) {
  const demo = state.mode === 'demo';
  const page = body => `<section class="my-iteration-page">${body}</section>`;
  if (!demo && !state.config?.team) return page('<div class="empty-panel"><h2>Sin equipo conectado</h2><button class="button primary" data-action="connect">Conectar Azure DevOps</button></div>');
  if (!snapshot) return page('<div class="empty-panel"><h2>Sin consultar</h2><button class="button primary" data-action="my-iteration-refresh">Consultar Azure DevOps</button></div>');
  const refresh = '<button class="button small" data-action="my-iteration-refresh">Actualizar</button>';
  return page(snapshot.boards.map((board, index) => boardView(snapshot, board, snapshot.boards.length > 1, index ? '' : refresh)).join(''));
}
