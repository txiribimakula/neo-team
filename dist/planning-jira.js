// Planificación · Estimación and Desarrollo: the tickets of a Jira filter, split by
// their type, each with what it already has in Azure DevOps and a row to create its
// task (and, optionally, a user story of the same title) under the parent chosen.
import { kindOf, typeIcon } from './jira.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const plain = text => String(text ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
export const PLANNING_JIRA_TABS = { estimates: 'estimate', development: 'development' };

// The work items of the plan that come from a ticket: same title, or its key in the title.
export function ticketItems(ws, entry) {
  const title = plain(entry.summary), key = new RegExp(`(^|[^A-Z0-9-])${entry.key.replace(/[-]/g, '\\-')}([^0-9]|$)`, 'i');
  return (ws?.effectiveItems ?? []).filter(i => ['User Story', 'Task', 'Product Backlog Item', 'Requirement'].includes(i.type) && (plain(i.title) === title || key.test(i.title)));
}
const closed = item => /^(closed|done|removed|completed|cerrad|terminad|eliminad|descartad|discarded)/i.test(item.state ?? '');
// Parents for the task (user stories and their equivalents) or, creating a story too,
// for the story (features), grouped under their own parent.
export function parentOptions(ws, story, selected) {
  const types = story ? ['Feature'] : ['User Story', 'Product Backlog Item', 'Requirement'];
  const byId = new Map(ws.effectiveItems.map(i => [i.id, i])), groups = new Map();
  for (const item of ws.effectiveItems.filter(i => types.includes(i.type) && !closed(i))) {
    const above = byId.get(item.parent), label = `${ws.sources && item.project ? `${item.project} · ` : ''}${above ? above.title : 'Sin padre'}`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  const option = i => `<option value="${i.id}" ${String(i.id) === String(selected) ? 'selected' : ''}>${escape(i.title)} · ${i.localOnly ? 'nuevo' : `#${i.id}`}</option>`;
  return `<option value="">${story ? 'Feature' : 'User Story'}…</option>${[...groups].sort(([a], [b]) => a.localeCompare(b, 'es')).map(([label, items]) => `<optgroup label="${escape(label)}">${items.sort((a, b) => a.title.localeCompare(b.title, 'es')).map(option).join('')}</optgroup>`).join('')}`;
}
const itemChip = i => `<span class="pill ${i.localOnly ? 'changed' : ''}" title="${escape(`${i.type} · ${i.title}`)}">${i.type === 'Task' ? 'Tarea' : 'US'} ${i.localOnly ? 'nueva' : `#${i.id}`}</span>`;
function createRow(ws, entry, draft) {
  return `<tr class="pj-create-row"><td colspan="6"><form id="pj-create-form" class="pj-create" data-key="${escape(entry.key)}">
    <input name="title" required maxlength="255" value="${escape(draft.title)}" aria-label="Título" data-pj-draft="title">
    <label class="pj-story" title="Crear también una user story con el mismo título, con la tarea debajo"><input type="checkbox" name="story" data-pj-story ${draft.story ? 'checked' : ''}>User Story</label>
    <select name="parent" required aria-label="Padre" data-pj-draft="parent">${parentOptions(ws, draft.story, draft.parent)}</select>
    <button class="button primary small" type="submit" title="Se crea en local y se sube a Azure DevOps al sincronizar">Crear</button>
    <button class="button subtle small" type="button" data-action="pj-close" aria-label="Cancelar">×</button>
  </form></td></tr>`;
}
export function planningJiraView(tab, state, ui) {
  if (!state.jira) return '<div class="empty-result"><button class="button" data-action="pj-connect">Conectar Jira</button></div>';
  const data = ui.data, ws = state.workspace, entries = (data?.entries ?? []).filter(e => kindOf(e.type) === PLANNING_JIRA_TABS[tab]);
  const meta = ui.loading ? '<span class="spinner" aria-label="Consultando Jira"></span>' : data?.at ? `<small class="text-muted">${entries.length}${data.limited ? '+' : ''} · ${new Date(data.at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</small>` : '';
  const toolbar = `<form id="pj-filter-form" class="pj-toolbar"><input name="filter" class="pj-filter" maxlength="2000" value="${escape(state.planningJiraFilter)}" placeholder="Filtro de Jira" aria-label="Filtro de Jira" title="Número del filtro, su URL (?filter= o ?jql=) o una consulta JQL" autocomplete="off"><button class="button small" type="submit" title="Actualizar desde Jira" aria-label="Actualizar desde Jira" ${ui.loading ? 'disabled' : ''}>⟳</button>${meta}</form>`;
  const error = ui.error ? `<p class="inline-error">${escape(ui.error)}</p>` : '';
  if (!state.planningJiraFilter || !data) return `<section class="pj">${toolbar}${error}</section>`;
  if (!entries.length) return `<section class="pj">${toolbar}${error}<div class="empty-result">Sin tickets</div></section>`;
  const rows = entries.map(e => {
    const items = ticketItems(ws, e), open = ui.open === e.key;
    return `<tr class="${open ? 'open' : ''}"><td class="pj-key">${typeIcon(e.type)}<a href="${escape(`${data.url}/browse/${encodeURIComponent(e.key)}`)}" target="_blank" rel="noopener">${escape(e.key)}</a></td><td class="pj-title">${escape(e.summary)}</td><td><span class="pill">${escape(e.status)}</span></td><td class="text-muted">${escape(e.assignee ? (e.assignee.me ? 'tú' : e.assignee.name) : '—')}</td><td class="pj-items">${items.map(itemChip).join('')}</td><td class="pj-action">${open ? '' : `<button class="button small" data-action="pj-open" data-key="${escape(e.key)}" title="Crear en Azure DevOps">+ Azure</button>`}</td></tr>${open ? createRow(ws, e, ui.draft) : ''}`;
  }).join('');
  return `<section class="pj">${toolbar}${error}<div class="table-wrap"><table class="pj-table"><thead><tr><th>Clave</th><th>Título</th><th>Estado</th><th>Asignado</th><th>Azure DevOps</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}
