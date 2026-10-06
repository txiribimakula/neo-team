import { loginView } from './reviews.js';
// Jira tickets: a board whose columns are agents (collect, reproduce, fix and
// verify), each with its model. Tickets move between them as the agents report,
// and back to fix while the verification fails.
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = value => value ? new Date(value).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const clock = at => new Date(at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const minutes = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)} min ${s % 60} s`; };

export const COLUMNS = [
  { id: 'collect', name: 'Recolectar', tier: 'Ligero' },
  { id: 'reproduce', name: 'Reproducir', tier: 'Medio' },
  { id: 'fix', name: 'Solucionar', tier: 'Avanzado' },
  { id: 'verify', name: 'Verificar', tier: 'Medio' },
  { id: 'done', name: 'Resueltos' },
];
export const OUTCOMES = { ok: 'Analizado', blocked: 'Bloqueado', reproduced: 'Reproducido', not_reproduced: 'No reproducido', fixed: 'Corregido', failed: 'Sin corregir', verified: 'Verificado', not_fixed: 'Sigue fallando', stopped: 'Detenido', error: 'Error' };
// Traffic light of each column: what its agent may do.
const LIGHTS = [['off', 'Nada: el agente no actúa'], ['ask', 'Avisar: espera tu aprobación antes de actuar'], ['auto', 'Autopilot: actúa solo']];
const STATUS = { pending: 'Pendiente', running: 'En curso', blocked: 'Necesita ayuda', done: 'Resuelto' };
const stageName = id => COLUMNS.find(c => c.id === id)?.name ?? id;

function modelSelect(column, settings, defaults, copilot) {
  const current = settings.models?.[column.id] ?? '';
  const models = [...(current && !copilot?.models?.some(m => m.id === current) ? [{ id: current, name: current }] : []), ...(copilot?.models ?? [])];
  const automatic = defaults?.[column.id];
  return `<select class="jira-model" data-jira-model="${column.id}" aria-label="Modelo del agente ${escape(column.name)}" title="Modelo del agente · nivel ${escape(column.tier)}" ${settings.demo ? 'disabled' : ''}><option value="">${settings.demo ? 'Simulado' : automatic ? `Auto · ${escape(automatic)}` : `Auto · ${escape(column.tier)}`}</option>${models.map(m => `<option value="${escape(m.id)}" ${m.id === current ? 'selected' : ''}>${escape(m.name)}${m.multiplier != null ? ` · ×${m.multiplier}` : ''}</option>`).join('')}</select>`;
}

// Issue type and priority icons drawn like Jira's (its own images need the Jira
// session and the page loads no external images). Names in English or Spanish.
const svg = (title, body, cls) => `<svg class="${cls}" width="16" height="16" viewBox="0 0 16 16" role="img" aria-label="${escape(title)}"><title>${escape(title)}</title>${body}</svg>`;
const TYPES = [
  [/bug|error|defect|fallo/i, '#e5493a', '<circle cx="8" cy="8" r="3.4" fill="#fff"/>'],
  [/sub-?task|sub-?tarea/i, '#4bade8', '<rect x="4" y="4" width="5" height="5" rx=".6" fill="none" stroke="#fff" stroke-width="1.4"/><rect x="7" y="7" width="5" height="5" rx=".6" fill="#fff"/>'],
  [/epic|épica|epica/i, '#904ee2', '<path d="M9.2 2.8 4.8 9h3.1l-1 4.2L11.2 7H8.1z" fill="#fff"/>'],
  [/story|historia/i, '#63ba3c', '<path d="M5 3.5h6v9l-3-2.2-3 2.2z" fill="#fff"/>'],
  [/improvement|mejora/i, '#63ba3c', '<path d="M8 3.5 4.2 7.6h2.5V12h2.6V7.6h2.5z" fill="#fff"/>'],
  [/feature|funcionalidad|característica/i, '#63ba3c', '<path d="M7 4h2v3h3v2H9v3H7V9H4V7h3z" fill="#fff"/>'],
  [/task|tarea/i, '#4bade8', '<path d="m4.6 8.3 2.3 2.3 4.6-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'],
];
export function typeIcon(name) {
  if (!name) return '';
  const [, color, body] = TYPES.find(([pattern]) => pattern.test(name)) ?? [null, '#8993a4', '<circle cx="8" cy="8" r="2.4" fill="#fff"/>'];
  return svg(name, `<rect width="16" height="16" rx="3" fill="${color}"/>${body}`, 'jira-type');
}
const up = (y, color) => `<path d="m3.5 ${y + 4} 4.5-4 4.5 4" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
const down = (y, color) => `<path d="m3.5 ${y} 4.5 4 4.5-4" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
const PRIORITIES = [
  [/blocker|bloqueante|bloqueador/i, '<circle cx="8" cy="8" r="6.5" fill="#cd1317"/><rect x="4" y="7" width="8" height="2" rx="1" fill="#fff"/>'],
  [/highest|más alta|mas alta|muy alta|critical|crítica|critica|urgent/i, up(2, '#cd1317') + up(7, '#cd1317')],
  [/lowest|más baja|mas baja|muy baja|trivial/i, down(3, '#0065ff') + down(8, '#0065ff')],
  [/high|alta|major|mayor/i, up(4.5, '#e9494a')],
  [/low|baja|minor|menor/i, down(5.5, '#0065ff')],
  [/medium|media|normal/i, '<path d="M3.5 6h9M3.5 10h9" stroke="#e97f33" stroke-width="2" stroke-linecap="round"/>'],
];
export function priorityIcon(name) {
  if (!name) return '';
  const body = PRIORITIES.find(([pattern]) => pattern.test(name))?.[1] ?? '<circle cx="8" cy="8" r="3" fill="#8993a4"/>';
  return svg(`Prioridad: ${name}`, body, 'jira-priority');
}

// When an agent gets stuck it asks; the answer is saved and the ticket resumes with it.
function answerField(ticket, drafts = {}) {
  return `<div class="jira-answer"><textarea data-jira-answer="${escape(ticket.key)}" data-focus="jira-answer:${escape(ticket.key)}" rows="2" maxlength="10000" placeholder="Tu respuesta" aria-label="Respuesta para el agente de ${escape(stageName(ticket.stage))}">${escape(drafts[ticket.key] ?? '')}</textarea><button class="button small" data-action="jira-answer" data-key="${escape(ticket.key)}" title="Guardar la respuesta y retomar el ticket (Ctrl+Enter)">Responder</button></div>`;
}
function card(ticket, running, mode = 'auto', drafts = {}, demo = false) {
  const live = running?.key === ticket.key ? running : null;
  const status = live ? 'running' : ticket.status;
  const last = live?.activity?.at(-1);
  const pills = [
    ticket.iterations > 1 && `<span class="pill" title="Correcciones intentadas">×${ticket.iterations}</span>`,
    ticket.inFilter === false && '<span class="pill demo" title="Ya no está en el filtro de Jira">Fuera del filtro</span>',
    ticket.jiraStatus && `<span class="tag" title="Estado en Jira">${escape(ticket.jiraStatus)}</span>`,
  ].filter(Boolean).join('');
  const run = live ? `<button class="icon-button jira-run" data-action="jira-stop" title="${escape(live.stopping ? 'Deteniendo…' : `Detener · ${live.model ?? ''}`)}" aria-label="Detener ${escape(ticket.key)}" ${live.stopping ? 'disabled' : ''}>■</button>`
    : mode !== 'off' && ['pending', 'blocked'].includes(ticket.status) ? `<button class="icon-button jira-run" data-action="jira-run" data-key="${escape(ticket.key)}" title="${mode === 'ask' && ticket.status === 'pending' ? 'Aprobar: ' : ''}Ejecutar el agente de ${escape(stageName(ticket.stage))}" aria-label="Ejecutar ${escape(ticket.key)}">▶</button>` : '';
  const awaiting = !live && mode === 'ask' && ticket.status === 'pending';
  return `<article class="jira-card status-${escape(status)}${awaiting ? ' awaiting' : ''}" data-action="jira-open-ticket" data-key="${escape(ticket.key)}" tabindex="0" aria-label="${escape(ticket.key)} · ${escape(ticket.summary)}">
    <header>${typeIcon(ticket.type)}${!demo && ticket.url ? `<a class="jira-key" href="${escape(ticket.url)}" target="_blank" rel="noopener noreferrer" title="Abrir en Jira">${escape(ticket.key)} ↗</a>` : `<strong>${escape(ticket.key)}</strong>`}${priorityIcon(ticket.priority)}<span class="jira-status" title="${escape(STATUS[status] ?? status)}">${live ? '<span class="spinner" aria-hidden="true"></span>' : ''}</span>${run}</header>
    <span class="jira-card-title">${escape(ticket.summary)}</span>
    ${pills ? `<span class="jira-card-meta">${pills}</span>` : ''}
    ${live ? `<small class="jira-live" title="${escape(last?.message ?? '')}">${escape(last?.message ?? 'Iniciando…')}</small>`
      : status === 'blocked' ? `<p class="jira-question">${escape(ticket.question ?? ticket.note ?? STATUS.blocked)}</p>${answerField(ticket, drafts)}`
      : awaiting ? '<small class="jira-await">Espera tu OK ▶</small>' : ''}
  </article>`;
}

function toolbar(board, copilot) {
  const s = board.settings, tools = board.tools ?? {};
  const tool = (ok, name, title) => `<span class="pill ${ok ? '' : 'demo'}" title="${escape(title)}">${escape(name)} ${ok ? '✓' : '✗'}</span>`;
  return `<div class="jira-toolbar">
    <button class="button primary" data-action="jira-collect" title="${escape(s.filter)}">Recolectar</button>
    ${board.pipeline?.auto
      ? `<button class="button jira-auto" data-action="jira-auto" data-on="false" title="Termina el paso en curso y para"><span aria-hidden="true">❚❚</span> Pausar</button>`
      : `<button class="button jira-auto" data-action="jira-auto" data-on="true" title="Procesa los tickets pendientes uno tras otro, terminando cada uno antes del siguiente"><span aria-hidden="true">▶</span> Empezar</button>`}
    <span class="jira-tools">${tools.demo ? '<span class="pill demo">Ejemplo simulado</span>' : `${tool(!!s.account, 'Jira', s.account ? `Conectado como ${s.account}` : 'Conexión sin comprobar: guarda la configuración o recolecta')}${tool(tools.winapp, 'winapp', tools.winapp ? 'winapp CLI disponible para manejar la aplicación' : 'Instala winapp CLI: winget install Microsoft.WinAppCLI')}${tool(tools.ffmpeg, 'ffmpeg', tools.ffmpeg ? 'Se extraen fotogramas de los vídeos' : 'Sin ffmpeg no se extraen fotogramas de los vídeos')}<button class="pill jira-copilot ${copilot?.isAuthenticated ? '' : 'demo'}" data-action="pr-copilot-status" title="${escape(copilot?.isAuthenticated ? `Cuenta ${copilot.login ?? ''} · comprobar de nuevo` : 'Comprobar la sesión de GitHub Copilot')}">Copilot ${copilot ? (copilot.isAuthenticated ? '✓' : '✗') : '…'}</button>`}</span>
    <button class="button small jira-logs" data-action="jira-logs" data-on="${!s.logs}" aria-pressed="${!!s.logs}" title="${s.logs ? 'Activado: cada paso de un agente se publica como comentario en su ticket de Jira. Pulsa para desactivar' : 'Publicar en cada ticket de Jira, como comentario, lo que va consiguiendo cada agente'}">Logs en Jira</button>
    <span class="jira-links">${s.demo ? '' : '<button class="button small" data-action="jira-view" data-view="settings">Configuración</button>'}</span>
  </div>`;
}

function boardView(board, copilot, showArchived, drafts) {
  const visible = board.tickets.filter(t => showArchived || !t.archived), archived = board.tickets.filter(t => t.archived).length;
  const columns = COLUMNS.map(column => {
    const tickets = visible.filter(t => t.stage === column.id);
    const active = tickets.some(t => t.key === board.pipeline?.running?.key);
    const mode = board.settings.modes?.[column.id] ?? 'auto';
    const lights = `<span class="jira-light mode-${mode}" role="group" aria-label="Semáforo de ${escape(column.name)}">${LIGHTS.map(([id, title]) => `<button data-action="jira-mode" data-stage="${column.id}" data-mode="${id}" class="light-${id}" aria-pressed="${mode === id}" title="${escape(title)}" aria-label="${escape(title)}"></button>`).join('')}</span>`;
    return `<section class="jira-column${active ? ' is-active' : ''} mode-${column.tier ? mode : 'auto'}" aria-label="${escape(column.name)}"><header><h2>${escape(column.name)} <span class="jira-column-count">${column.tier ? lights : ''}<span class="count">${tickets.length}</span></span></h2>${column.tier ? `<div class="jira-column-tools">${modelSelect(column, board.settings, board.defaults, copilot)}<button class="icon-button jira-learn" data-action="jira-learnings" data-stage="${column.id}" title="Aprendizajes del agente" aria-label="Aprendizajes de ${escape(column.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14Z"/><path d="M6.5 17A2.5 2.5 0 0 0 4 19.5 2.5 2.5 0 0 0 6.5 22H20v-5"/></svg><small>${board.lessons?.[column.id] ?? 0}</small></button></div>` : ''}</header><div class="jira-cards">${tickets.map(t => card(t, board.pipeline?.running, column.tier ? mode : 'auto', drafts, board.settings.demo)).join('')}</div></section>`;
  }).join('');
  const error = board.pipeline?.error ? `<p class="inline-error">${escape(board.pipeline.error)}</p>` : '';
  // Without a Copilot session the agents cannot work: how to sign in, as in pull request reviews.
  const login = board.settings.demo ? '' : loginView({ copilot: board.pipeline?.needsCopilot ? { isAuthenticated: false } : copilot });
  return `${toolbar(board, copilot)}${login}${login ? '' : error}<div class="jira-board">${columns}</div>${archived ? `<button class="link-button jira-archived" data-action="jira-show-archived">${showArchived ? 'Ocultar quitados' : `Mostrar ${archived} quitados del tablero`}</button>` : ''}`;
}

function settingsView(settings) {
  const s = settings ?? { deployment: 'cloud', maxIterations: 3 };
  const field = (name, label, value, attrs = '') => `<label class="form-field">${label}<input name="${name}" value="${escape(value ?? '')}" autocomplete="off" spellcheck="false" ${attrs}></label>`;
  return `<form id="jira-settings-form" class="pr-card jira-settings">
    ${settings ? '<button type="button" class="link-button" data-action="jira-view" data-view="board">← Tablero</button>' : ''}
    <h2>Jira</h2>
    <div class="jira-settings-grid">
      ${field('url', 'URL', s.url, 'required placeholder="https://empresa.atlassian.net"')}
      <label class="form-field">Tipo<select name="deployment"><option value="cloud">Jira Cloud</option><option value="datacenter" ${s.deployment === 'datacenter' ? 'selected' : ''}>Jira Data Center / Server</option></select></label>
      ${field('email', 'Correo de la cuenta (Cloud)', s.email, 'type="email" placeholder="tu@empresa.com"')}
      <label class="form-field"><span>Token · <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noopener noreferrer" title="Jira Cloud: crea un API token. Data Center: Perfil → Tokens de acceso personal">crear ↗</a></span><input name="token" type="password" autocomplete="off" placeholder="${s.tokenFromEnv ? 'NEO_TEAM_JIRA_TOKEN' : s.hasToken ? 'Guardado · escribe otro para cambiarlo' : 'API token (Cloud) o token personal (Data Center)'}" ${s.tokenFromEnv ? 'disabled' : ''} title="Se guarda solo en este equipo, en .neo-team/jira-token, y no se muestra"></label>
      ${field('filter', 'Filtro', s.filter, 'required placeholder="12345, URL del filtro o JQL"')}
      ${field('ticketsDir', 'Carpeta de tickets', s.ticketsDir, `placeholder="${escape(s.root ?? '.neo-team/jira')}" title="Cada ticket en su carpeta: descripción, comentarios, adjuntos e informes de los agentes"`)}
    </div>
    <h2>Aplicación</h2>
    <div class="jira-settings-grid">
      ${field('repository', 'Repositorio local', s.repository, 'placeholder="C:\\repos\\aplicacion" title="Cada corrección se hace en una copia aparte (git worktree) en la rama neo/<ticket>"')}
      ${field('baseBranch', 'Rama base', s.baseBranch, 'placeholder="HEAD"')}
      ${field('buildCommand', 'Compilar', s.buildCommand, 'placeholder="dotnet build App.sln -c Debug" title="Se ejecuta en la copia del ticket. Vacío: el agente lo averigua y lo aprende"')}
      ${field('launchCommand', 'Arrancar', s.launchCommand, 'placeholder="winapp run bin\\Debug\\App.exe --detach" title="Vacío: el agente lo averigua y lo aprende"')}
      ${field('maxIterations', 'Iteraciones máximas', s.maxIterations, 'type="number" min="1" max="10" required title="Correcciones que se intentan antes de pedir ayuda"')}
    </div>
    <div class="pr-actions">${s.hasToken && !s.tokenFromEnv ? '<label class="jira-clear-token"><input type="checkbox" name="clearToken"> Borrar el token</label>' : ''}<button class="button primary" type="submit" title="Guarda y comprueba la conexión con Jira">Conectar</button></div>
  </form>`;
}

// What the agent of a column learned, plus what every agent shares, edited in a popup.
export const lessonCount = text => (String(text ?? '').match(/^- /gm) ?? []).length;
export function learningsForm(stage, learnings) {
  const area = (scope, label) => `<label class="form-field">${escape(label)}<textarea name="${scope}" rows="${Math.min(14, Math.max(4, (learnings[scope] ?? '').split('\n').length + 1))}" spellcheck="false" placeholder="Sin aprendizajes todavía">${escape(learnings[scope] ?? '')}</textarea></label>`;
  return `<form id="jira-learnings-form" class="jira-learnings" data-stage="${escape(stage)}">${area(stage, stageName(stage))}${area('general', 'Comunes a todos los agentes')}</form>`;
}

// Markdown of tickets and reports, shown formatted. Every text is escaped before it
// is formatted; links only open http(s) addresses, and the ticket's own images
// (adjuntos/…, evidencias/…) are shown through `fileUrl` when it is given.
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const BLOCK_START = /^\s*(```|#{1,6}\s|>|([-*+]|\d+[.)])\s|\|.*\|\s*$|(---|\*\*\*)\s*$)/;
function formatText(text) {
  return escape(text)
    .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)([^_]+?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)(.+?)~~/g, '<del>$1</del>')
    .replace(/&lt;ins&gt;(.+?)&lt;\/ins&gt;/g, '<ins>$1</ins>')
    .replace(/(^|\s)@([\w.:-]+)/g, '$1<span class="md-mention">@$2</span>');
}
function linksAndText(raw, options) {
  let html = '', last = 0;
  for (const m of raw.matchAll(/(!?)\[([^\]]*)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>()]+)/g)) {
    html += formatText(raw.slice(last, m.index)); last = m.index + m[0].length;
    const href = m[3] ?? m[4] ?? m[5], label = m[2] ?? href, image = m[1] === '!';
    let path = null;
    try { path = /^https?:\/\//i.test(href) ? null : decodeURI(href); } catch { path = href; }
    if (!path) html += image ? `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${escape(label || href)}</a>` : `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${formatText(label)}</a>`;
    else if (IMAGE_FILE.test(path) && options.fileUrl && !path.split('/').includes('..')) {
      const src = escape(options.fileUrl(path));
      html += image ? `<a href="${src}" target="_blank" rel="noopener"><img class="md-image" src="${src}" alt="${escape(label)}" loading="lazy"></a>` : `<a href="${src}" target="_blank" rel="noopener">${formatText(label)}</a>`;
    } else html += `<code title="${escape(path)}">${escape(label || path)}</code>`;
  }
  return html + formatText(raw.slice(last));
}
function inline(raw, options) {
  return String(raw).split(/(`[^`\n]+`)/).map(part => /^`[^`]+`$/.test(part) ? `<code>${escape(part.slice(1, -1))}</code>` : linksAndText(part, options)).join('');
}
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
export function markdown(text, options = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n'), out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    let m;
    if (!line.trim()) { i++; continue; }
    if ((m = line.match(/^\s*```(\S*)\s*$/))) {
      const code = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      out.push(`<pre class="md-code"><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) { const level = Math.min(6, m[1].length + 2); out.push(`<h${level}>${inline(m[2], options)}</h${level}>`); i++; continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${markdown(quote.join('\n'), options)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      const header = rows.length > 1 && /^\s*\|?\s*:?-{3,}/.test(rows[1]) ? cells(rows.shift()) : null;
      if (header) rows.shift();
      out.push(`<div class="md-table"><table>${header ? `<thead><tr>${header.map(c => `<th>${inline(c, options)}</th>`).join('')}</tr></thead>` : ''}<tbody>${rows.map(r => `<tr>${cells(r).map(c => `<td>${inline(c, options)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && (m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/))) {
        items.push({ indent: m[1].length, tag: /\d/.test(m[2]) ? 'ol' : 'ul', text: m[3] }); i++;
        while (i < lines.length && lines[i].trim() && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.at(-1).text += `\n${lines[i++].trim()}`;
      }
      let html = '';
      const stack = [];
      for (const item of items) {
        while (stack.length > 1 && item.indent < stack.at(-1).indent) html += `</li></${stack.pop().tag}>`;
        if (!stack.length || item.indent > stack.at(-1).indent) { stack.push(item); html += `<${item.tag}><li>`; }
        else html += '</li><li>';
        html += item.text.split('\n').map(part => inline(part, options)).join('<br>');
      }
      while (stack.length) html += `</li></${stack.pop().tag}>`;
      out.push(html);
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !(paragraph.length && BLOCK_START.test(lines[i]))) paragraph.push(lines[i++]);
    out.push(`<p>${paragraph.map(part => inline(part.trim(), options)).join('<br>')}</p>`);
  }
  return out.join('');
}
// The title of descripcion.md and comentarios.md repeats the popup's.
const withoutTitle = text => String(text ?? '').replace(/^# [^\n]*\n+/, '');

// The ticket in a popup: a tab per step an agent completed, with what matters for
// that step, and a tab with the ticket itself. The answer field shows while it is stuck.
const stepFiles = (entry, files) => files.filter(f => ({
  reproduce: f.startsWith('evidencias/') || f === 'reproducir.ps1',
  fix: f === `compilacion-${entry.number}.log`,
  verify: f.startsWith('evidencias/'),
})[entry.stage]);
const fileList = files => files.length ? `<ul class="jira-files">${files.map(f => `<li><code>${escape(f)}</code></li>`).join('')}</ul>` : '';
function stepPanel(entry, detail, demo, options) {
  const report = (detail.reports ?? []).find(r => r.stage === entry.stage && r.number === entry.number && r.report === entry.report);
  const answer = (detail.answers ?? []).find(a => a.stage === entry.stage && a.at >= entry.finishedAt && (!entry.question || a.question === entry.question));
  const tokens = entry.usage ? (entry.usage.inputTokens ?? 0) + (entry.usage.outputTokens ?? 0) : entry.tokens;
  const posted = entry.posted ? `<span class="pill" title="Publicado como comentario en el ticket de Jira">${demo ? 'Publicado (simulado)' : 'En Jira'}</span>` : entry.posted === false ? `<span class="pill outcome-error" title="${escape(entry.postError ?? '')}">No publicado en Jira</span>` : '';
  const files = stepFiles(entry, detail.files ?? []);
  return `<p class="jira-step-meta"><span class="pill outcome-${escape(entry.outcome)}">${escape(OUTCOMES[entry.outcome] ?? entry.outcome)}</span><small>${when(entry.finishedAt)}${entry.model ? ` · ${escape(entry.model)}` : ''}${tokens ? ` · ${tokens} tokens` : ''}</small>${posted}</p>
    ${entry.question ? `<dl class="jira-answers"><dt>Pregunta</dt><dd>${escape(entry.question)}</dd>${answer ? `<dt>Tu respuesta · ${when(answer.at)}</dt><dd>${escape(answer.answer)}</dd>` : ''}</dl>` : ''}
    ${entry.error ? `<p class="inline-error">${escape(entry.error)}</p>` : ''}
    ${report?.text ? `<div class="jira-md">${markdown(report.text, options)}</div>` : ''}
    ${files.length ? `<h4 class="jira-step-files">Archivos del paso</h4>${fileList(files)}` : ''}`;
}
export function ticketDetail(board, detail, demo, drafts, selected = null, fileUrl = null) {
  const options = { fileUrl };
  const ticket = board.tickets.find(t => t.key === detail?.key);
  if (!detail?.history || !ticket) return '<section class="jira-detail" id="jira-ticket"><p class="text-muted"><span class="spinner"></span></p></section>';
  const live = board.pipeline?.running?.key === ticket.key;
  const steps = detail.history ?? [];
  const tabs = [...steps.map((entry, index) => ({ id: `step-${index}`, label: `${stageName(entry.stage)}${entry.stage === 'collect' && steps.filter(e => e.stage === 'collect').length === 1 ? '' : ` ${entry.number}`}`, outcome: entry.outcome, entry })), { id: 'ticket', label: 'Ticket' }];
  const current = tabs.find(t => t.id === selected) ?? (steps.length ? tabs[steps.length - 1] : tabs.at(-1));
  const move = `<select data-jira-move="${escape(ticket.key)}" aria-label="Mover a otra columna" ${live ? 'disabled' : ''}>${COLUMNS.map(c => `<option value="${c.id}" ${c.id === ticket.stage ? 'selected' : ''}>${escape(c.name)}</option>`).join('')}</select>`;
  const actions = `${move}${live ? '<button class="button small" data-action="jira-stop">Detener</button>' : ticket.stage === 'done' ? '' : `<button class="button small primary" data-action="jira-run" data-key="${escape(ticket.key)}" ${board.settings.modes?.[ticket.stage] === 'off' ? 'disabled title="El agente de esta columna está apagado"' : ''}>Ejecutar ${escape(stageName(ticket.stage))}</button>`}${demo ? '' : `<button class="button small" data-action="jira-open-folder" data-key="${escape(ticket.key)}">Abrir carpeta</button>`}<button class="button small" data-action="jira-archive" data-key="${escape(ticket.key)}" data-archived="${!ticket.archived}" ${live ? 'disabled' : ''}>${ticket.archived ? 'Volver al tablero' : 'Quitar del tablero'}</button>`;
  const comments = detail.commentList
    ? (detail.commentList.length ? detail.commentList.map(c => `<article class="jira-comment"><header><strong>${escape(c.author)}</strong><small>${when(c.created)}${c.updated ? ` · editado ${when(c.updated)}` : ''}</small></header><div class="jira-md">${markdown(c.body, options)}</div></article>`).join('') : '<p class="text-muted">Sin comentarios.</p>')
    : `<div class="jira-md">${markdown(withoutTitle(detail.comments), options)}</div>`;
  const panel = current.entry ? stepPanel(current.entry, detail, demo, options)
    : `<details class="jira-report" data-part="description" open><summary><strong>Descripción</strong></summary><div class="jira-md">${markdown(withoutTitle(detail.description), options)}</div></details>
       <details class="jira-report" data-part="comments"><summary><strong>Comentarios${detail.commentList ? ` · ${detail.commentList.length}` : ''}</strong></summary><div class="jira-comments">${comments}</div></details>
       <details class="jira-report" data-part="files"><summary><strong>Archivos · ${detail.files.length}</strong></summary>${fileList(detail.files)}<p class="jira-folder"><code>${escape(detail.folder)}</code></p></details>`;
  return `<section class="jira-detail" id="jira-ticket" data-key="${escape(ticket.key)}">
    <div class="jira-detail-actions"><p class="text-muted jira-meta">${typeIcon(ticket.type)}${escape(ticket.type ?? '')} ${priorityIcon(ticket.priority)}${escape([ticket.priority, stageName(ticket.stage), STATUS[live ? 'running' : ticket.status], ticket.iterations ? `${ticket.iterations} ${ticket.iterations === 1 ? 'corrección' : 'correcciones'}` : ''].filter(Boolean).join(' · '))}${demo ? '' : ` · <a href="${escape(ticket.url)}" target="_blank" rel="noopener noreferrer">Abrir en Jira ↗</a>`}</p><span>${actions}</span></div>
    ${ticket.status === 'blocked' && !live ? `<div class="notice warning jira-blocked"><p class="jira-question">${escape(ticket.question ?? ticket.note ?? STATUS.blocked)}</p>${answerField(ticket, drafts)}</div>` : ticket.note ? `<div class="notice warning">${escape(ticket.note)}</div>` : ''}
    <div class="jira-tabs" role="tablist">${tabs.map(t => `<button role="tab" class="jira-tab${t.outcome ? ` outcome-${escape(t.outcome)}` : ''}" data-action="jira-tab" data-tab="${t.id}" aria-selected="${t.id === current.id}">${escape(t.label)}</button>`).join('')}${live ? `<span class="jira-tab is-live" title="${escape(board.pipeline.running.activity?.at(-1)?.message ?? '')}"><span class="spinner" aria-hidden="true"></span>${escape(stageName(board.pipeline.running.stage))}</span>` : ''}</div>
    <div class="jira-tab-panel" role="tabpanel">${panel}</div>
  </section>`;
}

export function jiraView(state, ui, copilot) {
  const demo = state.mode === 'demo', board = ui.board;
  const page = body => `<section class="maintenance-page jira-page">${body}</section>`;
  if (!state.jira || ui.view === 'settings') return page(settingsView(state.jira));
  if (!board) return page('<p class="text-muted"><span class="spinner"></span></p>');
  if (board.error) return page(`<p class="inline-error">${escape(board.error)}</p>`);
  return page(boardView(board, copilot, ui.showArchived, ui.answers));
}

export function settingsFrom(form) {
  const { token = '', clearToken, ...data } = Object.fromEntries(new FormData(form));
  return { settings: { ...data, maxIterations: Number(data.maxIterations) }, token, clearToken: clearToken === 'on' };
}
