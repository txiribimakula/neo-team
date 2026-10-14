// Jira tickets: a board whose columns are agents (analyze, reproduce, fix, verify
// and review), each with its model. Tickets move between them as the agents report,
// back to fix while the verification fails or the review leaves comments.
import { aiChoice, effortName } from './ai-choice.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = value => value ? new Date(value).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const clock = at => new Date(at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const minutes = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)} min ${s % 60} s`; };

// A column per agent. Collecting is part of downloading (its tickets show in
// Analizar), building is the start of Verificar, and the solved tickets stay in
// Revisar, highlighted.
export const COLUMNS = [
  { id: 'analyze', name: 'Analizar', tier: 'Medio' },
  { id: 'reproduce', name: 'Reproducir', tier: 'Medio' },
  { id: 'fix', name: 'Solucionar', tier: 'Avanzado' },
  { id: 'verify', name: 'Verificar', tier: 'Medio' },
  { id: 'review', name: 'Revisar', tier: 'Avanzado' },
];
const SHOWN_IN = { collect: 'analyze', build: 'verify', done: 'review' };
// Where a ticket can be: the columns plus the solved ones, in order.
const FLOW = [...COLUMNS, { id: 'done', name: 'Resueltos' }];
const STEPS = [{ id: 'collect', name: 'Recolectar', byCode: true }, { id: 'build', name: 'Compilar', byCode: true }, ...FLOW];
// What each agent needs to work, and what to do when it is missing. An agent that
// lacks something does not run; what it only uses better (ffmpeg, for the frames of
// the videos it reads first) is just warned about.
const NEEDS = { analyze: ['copilot'], reproduce: ['copilot', 'winapp'], fix: ['copilot'], verify: ['copilot', 'winapp'], review: ['copilot', 'azure'] };
const WANTS = { analyze: ['ffmpeg'] };
const NEED_FIX = { copilot: 'Copilot: inicia sesión', winapp: 'winapp: instálalo', ffmpeg: 'ffmpeg: instálalo', azure: 'Azure DevOps: conéctalo' };
const missingOf = (board, copilot) => board.tools?.demo ? {} : { copilot: !!board.pipeline?.needsCopilot || copilot?.isAuthenticated === false, winapp: !board.tools?.winapp, ffmpeg: !board.tools?.ffmpeg, azure: board.tools?.azure === false };
const lackingOf = (stage, missing, wants = false) => [...(NEEDS[stage] ?? []), ...(wants ? WANTS[stage] ?? [] : [])].filter(need => missing[need]);
function warnView(id, name, lacking, open) {
  if (!lacking.length) return '';
  const tip = open ? `<span class="jira-warn-tip" role="tooltip"><strong>Falta</strong><ul>${lacking.map(need => `<li>${need === 'copilot' ? `<button class="link-button" data-action="jira-copilot-login">${escape(NEED_FIX[need])}</button>` : escape(NEED_FIX[need])}</li>`).join('')}</ul></span>` : '';
  return `<span class="jira-warn"><button class="jira-warn-icon" data-action="jira-warn" data-stage="${id}" aria-expanded="${open}" title="Falta algo para ${escape(name)}" aria-label="Falta algo para ${escape(name)}">⚠</button>${tip}</span>`;
}
export const OUTCOMES = { ok: 'Recolectado', analyzed: 'Analizado', blocked: 'Bloqueado', reproduced: 'Reproducido', not_reproduced: 'No reproducido', fixed: 'Corregido', failed: 'Sin corregir', built: 'Compila', build_failed: 'No compila', verified: 'Verificado', not_fixed: 'Sigue fallando', approved: 'Aprobado', commented: 'Con comentarios', stopped: 'Detenido', error: 'Error' };
// Traffic light of each column: what its agent may do.
const LIGHTS = [['off', 'Nada: el agente no actúa'], ['ask', 'Avisar: espera tu aprobación antes de actuar'], ['auto', 'Autopilot: actúa solo']];
const STATUS = { pending: 'Pendiente', running: 'En curso', blocked: 'Necesita ayuda', done: 'Resuelto' };
const stepOf = id => STEPS.find(c => c.id === id);
const stageName = id => stepOf(id)?.name ?? id;
// ⏩ Ya lo he hecho yo: the step of the ticket's column is recorded as the person's
// and the ticket goes on to the next. What they wrote in the answer field goes with it.
const nextName = id => FLOW[FLOW.findIndex(c => c.id === (id === 'build' ? 'verify' : id)) + 1]?.name ?? '';
const FORWARD = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 6v12l8.5-6Z"/><path d="M13 6v12l8.5-6Z"/></svg>';
function doneButton(ticket) {
  const title = `Ya lo he hecho yo: pasar a ${nextName(ticket.stage)}`;
  return `<button class="icon-button jira-done" data-action="jira-done" data-key="${escape(ticket.key)}" title="${escape(title)}" aria-label="${escape(`${title} · ${ticket.key}`)}">${FORWARD}</button>`;
}

// The model and the effort of a column's agent, or of the board's assistant ('general'),
// which without its own uses Analizar's. «Auto» alone: the model it chooses is in the tooltip.
function modelSelect(column, settings, defaults, copilot) {
  const automatic = column.id === 'general' ? settings.models?.analyze || defaults?.analyze : defaults?.[column.id];
  return aiChoice({ attrs: `data-ai-choice="jira" data-stage="${column.id}"`, models: copilot?.models ?? [], model: settings.models?.[column.id] ?? '', effort: settings.efforts?.[column.id] ?? '',
    automatic, hint: column.tier ? `nivel ${column.tier}` : 'el de Analizar', auto: settings.demo ? 'Simulado' : 'Auto', name: column.id === 'general' ? 'del asistente' : `del agente ${column.name}`, modelClass: 'jira-model', disabled: settings.demo });
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
// The kind of ticket, for the bar on the left of its card: errors, estimates,
// development, tasks and anything else. Names in English or Spanish.
const KINDS = [['error', /bug|error|defect|fallo|incidencia/i], ['estimate', /estimaci|estimate|spike|valoraci/i], ['development', /desarroll|develop|story|historia|feature|funcionalidad|mejora|improvement|epic|épica|epica/i], ['task', /task|tarea/i]];
export const kindOf = type => KINDS.find(([, pattern]) => pattern.test(type ?? ''))?.[0] ?? 'other';
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
// On the card, «Revisar» opens the ticket on its latest step, to read why it stopped before answering.
function answerField(ticket, drafts = {}, onCard = false) {
  const review = onCard ? `<button class="button small" data-action="jira-open-ticket" data-key="${escape(ticket.key)}" title="Abrir el ticket para revisar por qué se paró">Revisar</button>` : '';
  return `<div class="jira-answer"><textarea data-jira-answer="${escape(ticket.key)}" data-focus="jira-answer:${escape(ticket.key)}" rows="2" maxlength="10000" placeholder="Tu respuesta" aria-label="Respuesta para el agente de ${escape(stageName(ticket.stage))}">${escape(drafts[ticket.key] ?? '')}</textarea><div class="jira-answer-actions">${review}<button class="button small" data-action="jira-answer" data-key="${escape(ticket.key)}" title="Guardar la respuesta y retomar el ticket (Ctrl+Enter)">Responder</button></div></div>`;
}
// How easy the analysis found the ticket: three bars, as many lit as the harder of
// reproducing it and fixing it allows. The details are in the tooltip.
const EASE_LEVEL = { easy: 3, medium: 2, hard: 1 }, EASE_NAME = { 3: 'alta', 2: 'media', 1: 'baja' };
const EASE_PART = { reproduce: { easy: 'fácil', medium: 'con dudas', hard: 'difícil' }, fix: { easy: 'sencilla', medium: 'media', hard: 'compleja' } };
export function easeView(ease, label = false) {
  if (!ease) return '';
  const level = Math.min(EASE_LEVEL[ease.reproduce] ?? 1, EASE_LEVEL[ease.fix] ?? 1);
  const title = `Facilidad ${EASE_NAME[level]} · reproducir: ${EASE_PART.reproduce[ease.reproduce] ?? '?'} · solución: ${EASE_PART.fix[ease.fix] ?? '?'}${ease.reason ? ` · ${ease.reason}` : ''}`;
  const bars = [0, 1, 2].map(i => `<rect x="${i * 5}" y="${8 - i * 4}" width="4" height="${4 + i * 4}" rx="1"${i < level ? ' class="on"' : ''}/>`).join('');
  return `<span class="jira-ease ease-${level}" role="img" title="${escape(title)}" aria-label="${escape(title)}"><svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">${bars}</svg>${label ? `Facilidad ${EASE_NAME[level]}` : ''}</span>`;
}
// Who the ticket is assigned to, always visible: initials and name, «tú» for you.
const initials = name => String(name ?? '').trim().split(/\s+/).slice(0, 2).map(part => part[0] ?? '').join('').toUpperCase();
export function assigneeView(assignee) {
  if (!assignee) return '<span class="jira-assignee unassigned" title="Sin asignar en Jira"><span class="jira-avatar" aria-hidden="true">—</span><span class="jira-assignee-name">Sin asignar</span></span>';
  return `<span class="jira-assignee${assignee.me ? ' me' : ''}" title="Asignado en Jira a ${escape(assignee.name)}${assignee.me ? ' (tu cuenta)' : ''}"><span class="jira-avatar" aria-hidden="true">${escape(initials(assignee.name))}</span><span class="jira-assignee-name">${escape(assignee.name)}${assignee.me ? ' · tú' : ''}</span></span>`;
}
const GEAR = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>';
const FOLDER = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>';
const TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>';
const UPLOAD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8a4 4 0 0 1 0 8"/><path d="M12 12v9"/><path d="m8.5 15.5 3.5-3.5 3.5 3.5"/></svg>';
const DOWNLOAD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18a4.5 4.5 0 0 1-.5-9A6 6 0 0 1 18 8a4 4 0 0 1 0 8"/><path d="M12 12v9"/><path d="m8.5 17.5 3.5 3.5 3.5-3.5"/></svg>';
// The state of the ticket, shared through Jira to go on with it on another computer.
const divergedOf = ticket => ticket.diverged && ticket.shared && ticket.diverged.id === ticket.shared.id && ticket.shared.id !== ticket.sharedSeen ? ticket.diverged : null;
// Both computers worked on it since they last shared it: the person chooses which one goes on.
function divergedChoice(ticket) {
  const d = divergedOf(ticket), key = escape(ticket.key);
  return d ? `<div class="jira-diverged"><button class="button small" data-action="jira-resume" data-key="${key}" data-force="true" title="${escape(`Traer el estado de ${d.theirs}. Lo tuyo (${d.mine}) se guarda en copias`)}">Traer el suyo</button><button class="button small" data-action="jira-share" data-key="${key}" data-force="true" title="${escape(`Subir lo tuyo (${d.mine}) como el más reciente. El de ${d.theirs} sigue en Jira`)}">Subir el mío</button></div>` : '';
}
function shareButtons(ticket, live) {
  if (divergedOf(ticket)) return '';
  const off = live ? 'disabled' : '', key = escape(ticket.key), shared = ticket.shared;
  const resume = shared && shared.id !== ticket.sharedSeen
    ? `<button class="icon-button jira-tool jira-resume" data-action="jira-resume" data-key="${key}" title="${escape(`Traer el estado que subió ${shared.author || 'otra persona'}${shared.created ? ` el ${when(shared.created)}` : ''} (lo de este equipo se guarda en copias)`)}" aria-label="Traer el estado compartido de ${key}" ${off}>${DOWNLOAD}</button>` : '';
  const share = ticket.history?.length ? `<button class="icon-button jira-tool" data-action="jira-share" data-key="${key}" title="${escape(`Subir su estado a Jira para seguir en otro equipo${shared?.id && shared.id === ticket.sharedSeen ? ` · subido ${when(shared.created)}` : ''}`)}" aria-label="Subir el estado de ${key} a Jira" ${off}>${UPLOAD}</button>` : '';
  return resume + share;
}
const CHAT = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1.1-4.6A8 8 0 1 1 21 12Z"/></svg>';
const LOCK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const UNLOCK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.7-1.5"/></svg>';
function lockButton(ticket) {
  const title = ticket.locked
    ? `Fuera del modo automático${ticket.assignee && !ticket.assignee.me && ticket.autoLock === undefined ? `: asignado a ${ticket.assignee.name}` : ''}. Solo se ejecuta con ▶ sobre este ticket. Pulsa para incluirlo en el automático`
    : 'Incluido en el modo automático. Pulsa para que solo se ejecute con ▶ sobre este ticket';
  return `<button class="icon-button jira-lock${ticket.locked ? ' locked' : ''}" data-action="jira-autolock" data-key="${escape(ticket.key)}" data-locked="${!ticket.locked}" aria-pressed="${!!ticket.locked}" title="${escape(title)}" aria-label="${escape(title)}">${ticket.locked ? LOCK : UNLOCK}</button>`;
}
// What a ticket brought new from Jira since the person last opened it.
// The draft pull request of the review, with the comments still waiting for the fix.
const openComments = review => (review?.comments ?? []).filter(c => (!c.answers?.length || (c.answers.at(-1).action === 'checked' && !c.answers.at(-1).ok))).length;
function pullRequestPill(review, demo) {
  const pr = review?.pullRequest;
  if (!pr) return '';
  const open = openComments(review), title = `Pull request borrador${open ? ` · ${open} comentario${open === 1 ? '' : 's'} sin responder` : ''}`;
  return !demo && pr.url ? `<a class="pill jira-pr" href="${escape(pr.url)}" target="_blank" rel="noopener noreferrer" title="${escape(title)}">PR ${escape(pr.id)}${open ? ` · ${open}` : ''}</a>` : `<span class="pill jira-pr" title="${escape(title)}">PR ${escape(pr.id)}${open ? ` · ${open}` : ''}</span>`;
}
const newsText = news => `Desde Jira: ${[news.comments && `${news.comments} comentario${news.comments === 1 ? '' : 's'}`, news.attachments && `${news.attachments} adjunto${news.attachments === 1 ? '' : 's'}`].filter(Boolean).join(' y ')} nuevo${(news.comments ?? 0) + (news.attachments ?? 0) === 1 ? '' : 's'}. Ábrelo para verlo`;
function card(ticket, running, mode = 'auto', drafts = {}, demo = false, queued = false, lacking = []) {
  const live = running?.key === ticket.key ? running : null;
  const status = live ? 'running' : ticket.status;
  const last = live?.activity?.at(-1);
  const pills = [
    ticket.news && `<span class="pill jira-news" title="${escape(newsText(ticket.news))}">Novedades</span>`,
    pullRequestPill(ticket.review, demo),
    ticket.iterations > 1 && `<span class="pill" title="Correcciones intentadas">×${ticket.iterations}</span>`,
    ticket.inFilter === false && '<span class="pill demo" title="Ya no está en el filtro de Jira">Fuera del filtro</span>',
  ].filter(Boolean).join('');
  const run = live ? `<button class="icon-button jira-run" data-action="jira-stop" title="${escape(live.stopping ? 'Deteniendo…' : `Detener · ${live.model ?? ''}${live.effort ? ` · ${effortName(live.effort)}` : ''}`)}" aria-label="Detener ${escape(ticket.key)}" ${live.stopping ? 'disabled' : ''}>■</button>`
    : mode !== 'off' && lacking.length && ['pending', 'blocked'].includes(ticket.status) ? `<button class="icon-button jira-run" disabled title="${escape(`No se puede ejecutar: falta ${lacking.map(need => NEED_FIX[need].split(':')[0]).join(' y ')}`)}" aria-label="Ejecutar ${escape(ticket.key)}">▶</button>`
    : mode !== 'off' && ['pending', 'blocked'].includes(ticket.status) ? `<button class="icon-button jira-run" data-action="jira-run" data-key="${escape(ticket.key)}" title="${mode === 'ask' && ticket.status === 'pending' ? 'Aprobar: ' : ''}Ejecutar el agente de ${escape(stageName(ticket.stage))}" aria-label="Ejecutar ${escape(ticket.key)}">▶</button>` : '';
  // Its folder, right after its key.
  const folder = demo ? '' : `<button class="icon-button jira-tool jira-card-folder" data-action="jira-open-folder" data-key="${escape(ticket.key)}" title="Abrir su carpeta" aria-label="Abrir la carpeta de ${escape(ticket.key)}">${FOLDER}</button>`;
  const awaiting = !live && !lacking.length && mode === 'ask' && ticket.status === 'pending' && !ticket.locked;
  // The lock, ▶ (or ■) and sharing its state on the left, and ⏩ on the right.
  const actions = ticket.stage === 'done' ? '' : `${lockButton(ticket)}${run}${shareButtons(ticket, live)}${live ? '' : doneButton(ticket)}`;
  return `<article class="jira-card type-${kindOf(ticket.type)} status-${escape(status)}${awaiting ? ' awaiting' : ''}${queued && !live ? ' queued' : ''}${ticket.locked ? ' locked' : ''}" data-action="jira-open-ticket" data-key="${escape(ticket.key)}" tabindex="0" aria-label="${escape(ticket.key)} · ${escape(ticket.summary)}">
    <span class="jira-card-type" title="${escape(ticket.type || 'Sin tipo')}" aria-hidden="true"></span>
    <header>${!demo && ticket.url ? `<a class="jira-key" href="${escape(ticket.url)}" target="_blank" rel="noopener noreferrer" title="Abrir en Jira">${escape(ticket.key)}<small aria-hidden="true">↗</small></a>` : `<strong>${escape(ticket.key)}</strong>`}${folder}<span class="jira-status" title="${escape(STATUS[status] ?? status)}">${live ? '<span class="spinner" aria-hidden="true"></span>' : ''}</span>${priorityIcon(ticket.priority)}</header>
    <span class="jira-card-title">${escape(ticket.summary)}</span>
    <span class="jira-card-foot">${assigneeView(ticket.assignee)}<span class="jira-card-end">${ticket.jiraStatus ? `<span class="tag jira-card-status" title="Estado en Jira: ${escape(ticket.jiraStatus)}">${escape(ticket.jiraStatus)}</span>` : ''}${easeView(ticket.ease)}</span></span>
    ${actions ? `<span class="jira-card-actions">${actions}</span>` : ''}
    <span class="jira-card-meta">${pills}<span class="jira-card-tools"><button class="icon-button jira-tool" data-action="jira-delete" data-key="${escape(ticket.key)}" title="Borrar (con su carpeta, su copia del código y su rama)" aria-label="Borrar ${escape(ticket.key)}" ${live ? 'disabled' : ''}>${TRASH}</button></span></span>
    ${live?.conversation === 'waiting' ? '<small class="jira-live jira-waiting">Esperando tu respuesta</small>'
      : live ? `<small class="jira-live" title="${escape(last?.message ?? '')}">${escape(last?.message ?? 'Iniciando…')}</small>`
      : status === 'blocked' ? `<p class="jira-question">${escape(ticket.question ?? ticket.note ?? STATUS.blocked)}</p>${answerField(ticket, drafts, true)}`
      : queued ? '<small class="jira-await" title="Se ejecuta cuando termine el paso en curso">En cola</small>'
      : awaiting ? '<small class="jira-await">Espera tu OK ▶</small>' : ''}
    ${live || ticket.stage === 'done' ? '' : divergedChoice(ticket)}
  </article>`;
}

// Above the board, at the end: starting, the monitors and the settings. Mantenimiento
// puts them in its head, beside updating and the filters. Empezar works on the tickets
// the filters leave (`filtered`, their number) or, with nothing filtered, on all of them.
const boardTools = (board, screens, filtered = null) => `<span class="jira-links">${board.tools?.demo ? '<span class="pill demo">Ejemplo simulado</span>' : ''}${board.pipeline?.auto
      ? `<button class="button jira-square" data-action="jira-auto" data-on="false" title="Pausar: termina el paso en curso y para${board.pipeline.scope ? ` · trabaja en ${board.pipeline.scope.length} filtrados` : ''}" aria-label="Pausar">❚❚</button>`
      : `<button class="button jira-square" data-action="jira-auto" data-on="true" title="${filtered == null ? 'Empezar: procesa los tickets pendientes uno tras otro, terminando cada uno antes del siguiente' : `Empezar: procesa los pendientes de los ${filtered} tickets filtrados, uno tras otro`}" aria-label="Empezar">▶</button>`}${screensView(board, screens)}${board.settings.demo ? '' : `<button class="icon-button jira-gear" data-action="jira-settings" title="Configuración" aria-label="Configuración">${GEAR}</button>`}</span>`;
const boardControls = (board, screens, head = null, filtered = null) => head ? head(boardTools(board, screens, filtered)) : `<div class="jira-board-controls">${boardTools(board, screens, filtered)}</div>`;

// Which monitor holds the web and which the application while reproducing and verifying
// (each one maximized on its own); empty, the main one for the web and another for the application.
const MONITOR = '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>';
const monitor = id => `Monitor ${id.match(/DISPLAY(\d+)$/)?.[1] ?? id}`;
const screenName = s => `${monitor(s.id)} · ${s.width}×${s.height}${s.primary ? ' · principal' : ''}`;
function screensView(board, open) {
  if (!board.tools?.screens) return '';
  const chosen = board.settings.screens ?? {};
  const select = (role, label) => {
    const list = open?.list ?? [], value = chosen[role] ?? '';
    const options = [['', 'Automático'], ...list.map(s => [s.id, screenName(s)]), ...(value && !list.some(s => s.id === value) ? [[value, monitor(value)]] : [])];
    return `<label class="jira-screen">${label}<select data-jira-screen="${role}"${open?.list ? '' : ' disabled'}>${options.map(([id, name]) => `<option value="${escape(id)}" ${id === value ? 'selected' : ''}>${escape(name)}</option>`).join('')}</select></label>`;
  };
  return `${open ? `<span class="jira-screens">${select('web', 'Web')}${select('app', 'Reproducir')}</span>` : ''}<button class="icon-button jira-gear" data-action="jira-screens" aria-pressed="${!!open}" title="Monitores: dónde se maximizan la web y la aplicación al reproducir y verificar" aria-label="Monitores">${MONITOR}</button>`;
}
// Over each log, a chat. On the live step a message interrupts what the agent is
// doing and it answers; Pausar interrupts it and Continuar lets it go on; Detener
// ends the step. On a step that ended, the person talks to its agent about it (its
// session is resumed), and on the board to the general assistant. `chat` is the
// target of those two: { id, key, index } or { id: 'general', general: true },
// with the state of its conversation.
const chatAttrs = chat => !chat ? '' : chat.general ? 'data-general="true"' : `data-key="${escape(chat.key)}" data-index="${chat.index}"`;
function tellView(run, draft = '', chat = null) {
  const attrs = chatAttrs(chat), focus = `jira-tell${chat ? `:${chat.id}` : ''}`;
  const send = (placeholder, label, off = '') => `<textarea data-jira-tell ${attrs} data-focus="${escape(focus)}" rows="1" maxlength="4000" placeholder="${escape(placeholder)}" aria-label="${escape(label)}" ${off}>${escape(draft)}</textarea><button class="button small primary" data-action="jira-tell" ${attrs} title="Enviar (Enter; Mayús+Enter para otra línea)" ${off}>Enviar</button>`;
  if (chat) {
    const talking = ['starting', 'working', 'waiting'].includes(chat.state);
    return `<div class="jira-tell">${send(chat.offline ?? (chat.general ? 'Pide algo al asistente: cambiar aprendizajes, revisar tickets…' : 'Pregunta al agente de este paso'), chat.general ? 'Mensaje para el asistente general' : 'Mensaje para el agente de este paso', chat.offline ? 'disabled' : '')}${talking ? `<button class="button small" data-action="jira-stop" ${attrs} title="Termina esta conversación; puedes retomarla con otro mensaje">Terminar</button>` : ''}</div>`;
  }
  const column = stepOf(run.stage), waiting = run.conversation === 'waiting', off = run.stopping ? 'disabled' : '';
  const input = column?.byCode ? '' : `${send(waiting ? 'Responde o pregunta al agente' : 'Interrumpe al agente para preguntarle o decirle algo', `Mensaje para el agente de ${column?.name ?? ''}`, off)}${waiting
    ? `<button class="button small" data-action="jira-pause" data-on="false" title="El agente sigue con su tarea" ${off}>Continuar</button>`
    : `<button class="button small" data-action="jira-pause" data-on="true" title="Interrumpe al agente donde está, sin perder lo que lleva, y espera" ${off}>Pausar</button>`}`;
  return `<div class="jira-tell">${input}<button class="button small" data-action="jira-stop" title="Detener el paso al momento: queda pendiente" ${run.stopping ? 'disabled' : ''}>${run.stopping ? 'Deteniendo…' : 'Detener'}</button></div>`;
}
const logList = entries => `<ol>${entries.map(entry => `<li class="log-${escape(entry.kind)}"><time>${clock(entry.at)}</time><pre>${escape(entry.message)}</pre></li>`).join('')}</ol>`;
// `chat`: the conversation with the agent of a step that ended (in the ticket's popup).
export function activityView(run, live = true, tell = '', chat = null) {
  if (!run) return '';
  const entries = [...(run.activity ?? [])].reverse();
  const talking = chat?.state === 'waiting' ? ' · <strong class="jira-waiting">Esperando tu respuesta</strong>' : ['starting', 'working'].includes(chat?.state) ? ' · <span class="spinner" aria-hidden="true"></span>' : '';
  const about = live ? `<span>${escape(stageName(run.stage))} · ${minutes(Date.now() - run.startedAt)}${run.conversation === 'waiting' ? ' · <strong class="jira-waiting">Esperando tu respuesta</strong>' : ''}</span>`
    : `<span>${run.log ? `<code title="Registro completo en la carpeta del ticket">${escape(run.log)}</code>` : ''}${talking}</span>`;
  const list = entries.length ? logList(entries) : live ? '<ol><li>Preparando el agente…</li></ol>' : '';
  if (live) return `<section class="jira-activity" aria-label="Logs en vivo"><header><strong>Logs en vivo</strong>${about}</header>${tellView(run, tell)}${list}</section>`;
  // A step that ended folds its log; the popup keeps it folded or open as it refreshes.
  return `<details class="jira-activity" data-part="log" aria-label="Registro de la fase" open><summary><strong>Registro de la fase</strong>${about}</summary>${chat ? tellView(run, tell, chat) : ''}${list}</details>`;
}
// The general prompt of the board: an assistant for anything about it, such as
// changing the learnings of the agents. Its conversation stays until started anew.
// Without a Copilot session the assistant cannot answer: its field stays disabled.
// The assistant, beside the board: folded, a strip that still says when it is busy or waiting.
// What happens on the board, curated: a line per event, coloured by its family, with
// the long part folded. Newest first.
const FEED_FAMILY = { person: 'Tú', ai: 'Lo que dice la IA', tool: 'Lo que hace la IA', step: 'Paso del flujo', jira: 'Jira', warning: 'Aviso', error: 'Error' };
const FEED_STATUS = { running: '<span class="spinner" aria-hidden="true"></span>', failed: '<span class="feed-mark feed-failed" title="Falló">✕</span>', stopped: '<span class="feed-mark" title="No terminó">■</span>' };
function feedItem(item, open) {
  const family = FEED_FAMILY[item.family] ? item.family : 'ai', stage = item.stage && !String(item.title ?? '').startsWith(stageName(item.stage)) ? stageName(item.stage) : '';
  const row = `<time>${clock(item.at).slice(0, 5)}</time>${item.key ? `<span class="feed-key">${escape(item.key)}</span>` : ''}<span class="feed-title" title="${escape(item.title ?? '')}">${escape(item.title ?? '')}</span>${item.meta || stage ? `<small>${escape([stage, item.meta].filter(Boolean).join(' · '))}</small>` : ''}${FEED_STATUS[item.status] ?? ''}`;
  const head = `<li class="feed feed-${family}" title="${escape(FEED_FAMILY[family])}">`;
  // Reports and what the AI says are Markdown; commands, outputs and Jira comments, plain text.
  const body = ['step', 'ai', 'warning'].includes(family) && !item.output ? `<div class="feed-md jira-md">${markdown(item.detail)}</div>` : `<pre>${escape(item.detail)}</pre>`;
  return item.detail ? `${head}<details data-feed="${escape(item.id)}"${open ? ' open' : ''}><summary>${row}</summary>${body}</details></li>` : `${head}<div class="feed-row">${row}</div></li>`;
}
export const feedView = (feed = [], open = new Set()) => feed.length ? `<ol class="jira-feed" aria-label="Actividad">${[...feed].reverse().map(item => feedItem(item, open.has(item.id))).join('')}</ol>` : '';

// One prompt for both: the assistant of the board, or the agent at work on a ticket,
// chosen in «Para». While an agent works it is the default; what either answers goes
// to the activity below.
function liveField(run, draft = '') {
  const waiting = run.conversation === 'waiting', off = run.stopping ? 'disabled' : '';
  return `<div class="jira-tell"><textarea data-jira-tell data-focus="jira-tell" rows="1" maxlength="4000" placeholder="${waiting ? 'Responde o pregunta al agente' : 'Interrumpe al agente para preguntarle o decirle algo'}" aria-label="Mensaje para el agente de ${escape(stageName(run.stage))}" ${off}>${escape(draft)}</textarea><button class="button small primary" data-action="jira-tell" title="Enviar (Enter; Mayús+Enter para otra línea)" ${off}>Enviar</button>${waiting
    ? `<button class="button small" data-action="jira-pause" data-on="false" title="El agente sigue con su tarea" ${off}>Continuar</button>`
    : `<button class="button small" data-action="jira-pause" data-on="true" title="Interrumpe al agente donde está, sin perder lo que lleva, y espera" ${off}>Pausar</button>`}</div>`;
}
export function generalView(general, draft = '', signedOut = false, warn = null, closed = false, feed = [], feedOpen = new Set(), live = {}, unread = 0, choice = '') {
  const state = general?.conversation, run = live.run ?? null, agent = !!run && !stepOf(run.stage)?.byCode;
  const target = agent && live.to !== 'general' ? 'live' : 'general';
  // Folded: how many new lines arrived, whether something works, whether someone waits for you.
  if (closed) {
    const news = unread ? `${unread} ${unread === 1 ? 'novedad' : 'novedades'}` : '', waiting = state === 'waiting' || run?.conversation === 'waiting';
    const title = ['Mostrar el asistente', news, waiting && 'espera tu respuesta'].filter(Boolean).join(' · ');
    return `<aside class="jira-side is-closed"><button class="icon-button jira-side-toggle" data-action="jira-assistant" aria-expanded="false" title="${title}" aria-label="${title}">${CHAT}${unread ? `<span class="jira-side-count" aria-hidden="true">${unread > 99 ? '99+' : unread}</span>` : waiting ? '<span class="jira-side-dot" aria-hidden="true"></span>' : ''}${['starting', 'working'].includes(state) || run ? '<span class="spinner" aria-hidden="true"></span>' : ''}</button></aside>`;
  }
  const busy = target === 'general' && ['starting', 'working'].includes(state) ? ' <span class="spinner" aria-hidden="true"></span>' : target === 'general' && state === 'waiting' ? ' · <strong class="jira-waiting">Esperando tu respuesta</strong>' : '';
  // The step at work: which, for how long, and stopping it.
  const working = run ? `<span class="jira-working"><span class="spinner" aria-hidden="true"></span>${escape(run.key)} · ${escape(stageName(run.stage))} · ${minutes(Date.now() - run.startedAt)}${run.conversation === 'waiting' ? ' · <strong class="jira-waiting">Esperando tu respuesta</strong>' : ''}<button class="icon-button jira-stop-run" data-action="jira-stop" title="Detener el paso al momento: queda pendiente" aria-label="Detener ${escape(run.key)}" ${run.stopping ? 'disabled' : ''}>■</button></span>` : '';
  const picker = agent ? `<label class="jira-to">Para<select data-jira-to aria-label="A quién va el mensaje"><option value="live"${target === 'live' ? ' selected' : ''}>Agente · ${escape(run.key)} · ${escape(stageName(run.stage))}</option><option value="general"${target === 'general' ? ' selected' : ''}>Asistente del tablero</option></select></label>` : '';
  const field = target === 'live' ? liveField(run, live.draft) : tellView(null, draft, { id: 'general', general: true, state, ...(signedOut ? { offline: 'Inicia sesión en Copilot para usar el asistente' } : {}) });
  const reset = target === 'general' && (general?.activity?.length || feed.length) ? '<button class="link-button jira-general-reset" data-action="jira-general-reset" title="Vacía el panel y empieza una conversación nueva con el asistente, sin el contexto de la anterior">Nueva conversación</button>' : '';
  return `<aside class="jira-side"><section class="jira-activity jira-general" aria-label="Asistente"><header><button class="icon-button jira-side-toggle" data-action="jira-assistant" aria-expanded="true" title="Plegar el asistente" aria-label="Plegar el asistente">»</button><strong>Asistente</strong>${warnView('general', 'el asistente', signedOut ? ['copilot'] : [], warn === 'general')}${choice}<span>${busy}</span>${reset}</header>${working}${picker}${field}${feedView(feed, feedOpen)}</section></aside>`;
}

// `shown`: the keys the filters of Mantenimiento leave (all, without it); `head`, its head.
function boardView(board, copilot, drafts, shown = null, tell = '', tells = {}, warn = null, assistantClosed = false, head = null, feedOpen = new Set(), to = null, unread = 0, screens = null, filtered = null) {
  const missing = missingOf(board, copilot);
  const visible = shown ? board.tickets.filter(t => shown.has(t.key)) : board.tickets;
  const columns = COLUMNS.map(column => {
    const tickets = visible.filter(t => (SHOWN_IN[t.stage] ?? t.stage) === column.id).sort((a, b) => (a.stage === 'done') - (b.stage === 'done'));
    const active = tickets.some(t => t.key === board.pipeline?.running?.key);
    const mode = board.settings.modes?.[column.id] ?? 'auto';
    const lights = `<span class="jira-light mode-${mode}" role="group" aria-label="Semáforo de ${escape(column.name)}">${LIGHTS.map(([id, title]) => `<button data-action="jira-mode" data-stage="${column.id}" data-mode="${id}" class="light-${id}" aria-pressed="${mode === id}" title="${escape(title)}" aria-label="${escape(title)}"></button>`).join('')}</span>`;
    // An agent that lacks something does not run.
    const lacking = lackingOf(column.id, missing);
    const warning = warnView(column.id, column.name, lackingOf(column.id, missing, true), warn === column.id);
    return `<section class="jira-column${active ? ' is-active' : ''} mode-${mode}" aria-label="${escape(column.name)}"><header><h2><span class="jira-column-name">${escape(column.name)}<span class="count" title="Tickets en ${escape(column.name)}">${tickets.length}</span>${warning}</span>${column.tier ? `<button class="icon-button jira-learn" data-action="jira-learnings" data-stage="${column.id}" title="Aprendizajes del agente" aria-label="Aprendizajes de ${escape(column.name)}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14Z"/><path d="M6.5 17A2.5 2.5 0 0 0 4 19.5 2.5 2.5 0 0 0 6.5 22H20v-5"/></svg></button>` : ''}</h2><div class="jira-column-tools">${lights}${column.tier ? modelSelect(column, board.settings, board.defaults, copilot) : ''}</div></header><div class="jira-cards">${tickets.map(t => card(t, board.pipeline?.running, mode, drafts, board.settings.demo, !!board.pipeline?.queue?.includes(t.key) || board.pipeline?.focus === t.key, lacking)).join('')}</div></section>`;
  }).join('');
  const error = board.pipeline?.error ? `<p class="inline-error">${escape(board.pipeline.error)}</p>` : '';
  // Without a Copilot session the agents cannot work: how to sign in, as in pull request reviews.
  // The assistant and the activity, beside the board.
  const assistant = closed => generalView(board.pipeline?.general, tells.general, missing.copilot, warn, closed, board.pipeline?.feed ?? [], feedOpen, { run: board.pipeline?.running ?? null, draft: tell, to }, unread, modelSelect({ id: 'general' }, board.settings, board.defaults, copilot));
  return `${error}<div class="jira-main${assistantClosed ? ' side-closed' : ''}"><div class="jira-main-board">${boardControls(board, screens, head, filtered)}<div class="jira-board">${columns}</div></div>${assistant(assistantClosed)}</div>`;
}

export const SETTINGS_SUBMIT = '<button class="button primary" type="submit" form="jira-settings-form" title="Guarda y comprueba la conexión con Jira">Conectar</button>';
// The first time it is the page; once connected it opens as a popup from the gear.
export function settingsView(settings, popup = false) {
  const s = settings ?? { deployment: 'cloud', maxIterations: 3 };
  const field = (name, label, value, attrs = '') => `<label class="form-field">${label}<input name="${name}" value="${escape(value ?? '')}" autocomplete="off" spellcheck="false" ${attrs}></label>`;
  return `<form id="jira-settings-form" class="${popup ? '' : 'pr-card '}jira-settings">
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
      ${field('buildCommand', 'Compilar', s.buildCommand, 'placeholder="dotnet build App.sln -c Debug" title="Lo ejecuta el paso Compilar en la copia del ticket"')}
      ${field('launchCommand', 'Arrancar', s.launchCommand, 'placeholder="winapp run bin\\Debug\\App.exe --detach" title="Vacío: el agente lo averigua y lo aprende"')}
      ${field('maxIterations', 'Iteraciones máximas', s.maxIterations, 'type="number" min="1" max="10" required title="Correcciones que se intentan antes de pedir ayuda"')}
    </div>
    <div class="pr-actions">${s.hasToken && !s.tokenFromEnv ? '<label class="jira-clear-token"><input type="checkbox" name="clearToken"> Borrar el token</label>' : ''}${popup ? '' : SETTINGS_SUBMIT}</div>
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
  build: f === `compilacion-${entry.number}.log`,
  verify: f.startsWith('evidencias/'),
  review: f === `revision-${entry.number}.diff` || f === `revision-${entry.number}-ultimos.diff`,
})[entry.stage]);
const fileList = files => files.length ? `<ul class="jira-files">${files.map(f => `<li><code>${escape(f)}</code></li>`).join('')}</ul>` : '';
function stepPanel(entry, detail, demo, options, log = '', key = '', index = 0) {
  const report = (detail.reports ?? []).find(r => r.stage === entry.stage && r.number === entry.number && r.report === entry.report);
  const answer = (detail.answers ?? []).find(a => a.stage === entry.stage && a.at >= entry.finishedAt && (!entry.question || a.question === entry.question));
  const tokens = entry.usage ? (entry.usage.inputTokens ?? 0) + (entry.usage.outputTokens ?? 0) : entry.tokens;
  const person = (entry.by === 'person' ? '<span class="pill" title="Paso hecho a mano, no por el agente">Hecho por ti</span>' : '') + (entry.rewound ? `<span class="pill" title="${escape(`Deshecho ${when(entry.rewound)}: los agentes ya no lo tienen en cuenta`)}">Rebobinado</span>` : '');
  const posted = entry.posted ? `<span class="pill" title="Publicado como comentario en el ticket de Jira">${demo ? 'Publicado (simulado)' : 'En Jira'}</span>` : entry.posted === false ? `<span class="pill outcome-error" title="${escape(entry.postError ?? '')}">No publicado en Jira</span>` : '';
  const files = stepFiles(entry, detail.files ?? []);
  const decide = entry.pendingComment ? `<span class="jira-comment-decide">${commentButtons(key, index)}</span>` : '';
  return `<p class="jira-step-meta"><span class="pill outcome-${escape(entry.outcome)}">${escape(OUTCOMES[entry.outcome] ?? entry.outcome)}</span><small>${when(entry.finishedAt)}${entry.model ? ` · ${escape(entry.model)}` : ''}${entry.effort ? ` · ${escape(effortName(entry.effort))}` : ''}${tokens ? ` · ${tokens} tokens` : ''}</small>${entry.ease ? easeView(entry.ease, true) : ''}${person}${posted}${decide}</p>
    ${entry.question ? `<dl class="jira-answers"><dt>Pregunta</dt><dd>${escape(entry.question)}</dd>${answer ? `<dt>Tu respuesta · ${when(answer.at)}</dt><dd>${escape(answer.answer)}</dd>` : ''}</dl>` : ''}
    ${entry.error ? `<p class="inline-error">${escape(entry.error)}</p>` : ''}
    ${log}
    ${report?.text ? `<div class="jira-md">${markdown(report.text, options)}</div>` : ''}
    ${files.length ? `<h4 class="jira-step-files">Archivos del paso</h4>${fileList(files)}` : ''}`;
}
// Nothing reaches Jira without the person: each step leaves its comment ready and asks.
const commentButtons = (key, index) => `<button class="button small" data-action="jira-comment" data-key="${escape(key)}" data-index="${index}" data-publish="false">No publicar</button><button class="button small primary" data-action="jira-comment" data-key="${escape(key)}" data-index="${index}" data-publish="true">Publicar en Jira</button>`;
export const pendingComments = board => (board?.tickets ?? []).flatMap(t => (t.history ?? []).map((h, index) => h.pendingComment && !h.commentAsked ? { key: t.key, index, stage: h.stage, text: h.pendingComment } : null).filter(Boolean));
export const commentPrompt = item => ({
  title: `¿Publicar en Jira? · ${item.key}`,
  body: `<p class="text-muted">Comentario del agente de ${escape(stageName(item.stage))}:</p><pre class="jira-comment-preview">${escape(item.text)}</pre>`,
  actions: commentButtons(item.key, item.index),
});
// The head of the ticket popup: its key and title open it in Jira, and below, what
// describes it. The state only when it says something: at work or needing help.
export function ticketHead(board, key, demo) {
  const ticket = board?.tickets?.find(t => t.key === key);
  if (!ticket) return `<h2 id="modal-title">${escape(key)}</h2>`;
  const live = board.pipeline?.running?.key === key, state = live ? 'running' : ticket.status;
  const title = `${escape(ticket.key)} · ${escape(ticket.summary ?? '')}`;
  const meta = [ticket.type && `${typeIcon(ticket.type)}${escape(ticket.type)}`, ticket.priority && `${priorityIcon(ticket.priority)}${escape(ticket.priority)}`, escape(stageName(SHOWN_IN[ticket.stage] && ticket.stage !== 'done' ? SHOWN_IN[ticket.stage] : ticket.stage)), ['running', 'blocked'].includes(state) && escape(STATUS[state]), ticket.iterations && `${ticket.iterations} ${ticket.iterations === 1 ? 'corrección' : 'correcciones'}`].filter(Boolean);
  return `<div class="jira-head"><h2 id="modal-title">${!demo && ticket.url ? `<a class="jira-title-link" href="${escape(ticket.url)}" target="_blank" rel="noopener noreferrer" title="Abrir en Jira">${title}</a>` : title}</h2><p class="jira-meta">${assigneeView(ticket.assignee)}${easeView(ticket.ease)}${meta.map(m => `<span>${m}</span>`).join('')}</p></div>`;
}
export function ticketDetail(board, detail, demo, drafts, selected = null, fileUrl = null, tell = '', tells = {}) {
  const options = { fileUrl };
  const ticket = board.tickets.find(t => t.key === detail?.key);
  if (!detail?.history || !ticket) return '<section class="jira-detail" id="jira-ticket"><p class="text-muted"><span class="spinner"></span></p></section>';
  const live = board.pipeline?.running?.key === ticket.key;
  const steps = detail.history ?? [];
  // The ticket first, then a tab per step with its log and its chat, and the step at
  // work, live. The latest one opens.
  const tabs = [{ id: 'ticket', label: 'Ticket' }, ...steps.map((entry, index) => ({ id: `step-${index}`, index, label: `${stageName(entry.stage)}${entry.stage === 'collect' && steps.filter(e => e.stage === 'collect').length === 1 ? '' : ` ${entry.number}`}`, outcome: entry.outcome, entry })),
    ...(live ? [{ id: 'live', label: stageName(board.pipeline.running.stage), live: true }] : [])];
  const current = tabs.find(t => t.id === selected) ?? tabs.at(-1);
  const comments = detail.commentList
    ? (detail.commentList.length ? detail.commentList.map(c => `<article class="jira-comment"><header><strong>${escape(c.author)}</strong><small>${when(c.created)}${c.updated ? ` · editado ${when(c.updated)}` : ''}</small></header><div class="jira-md">${markdown(c.body, options)}</div></article>`).join('') : '<p class="text-muted">Sin comentarios.</p>')
    : `<div class="jira-md">${markdown(withoutTitle(detail.comments), options)}</div>`;
  const chatId = `${ticket.key}#${current.index}`;
  const panel = current.live ? activityView(board.pipeline.running, true, tell)
    : current.entry ? stepPanel(current.entry, detail, demo, options, activityView(current.entry, false, tells[chatId] ?? '', { id: chatId, key: ticket.key, index: current.index, state: board.pipeline?.chats?.[chatId] }), ticket.key, current.index)
    : `<details class="jira-report" data-part="description" open><summary><strong>Descripción</strong></summary><div class="jira-md">${markdown(withoutTitle(detail.description), options)}</div></details>
       <details class="jira-report" data-part="comments"><summary><strong>Comentarios${detail.commentList ? ` · ${detail.commentList.length}` : ''}</strong></summary><div class="jira-comments">${comments}</div></details>
       <details class="jira-report" data-part="files"><summary><strong>Archivos · ${detail.files.length}</strong></summary>${fileList(detail.files)}<p class="jira-folder"><code>${escape(detail.folder)}</code></p></details>`;
  return `<section class="jira-detail" id="jira-ticket" data-key="${escape(ticket.key)}">
    ${ticket.status === 'blocked' && !live ? `<div class="notice warning jira-blocked"><p class="jira-question">${escape(ticket.question ?? ticket.note ?? STATUS.blocked)}</p>${answerField(ticket, drafts)}</div>` : ticket.note ? `<div class="notice warning">${escape(ticket.note)}</div>` : ''}
    <div class="jira-tabs" role="tablist">${tabs.map(t => `<button role="tab" class="jira-tab${t.outcome ? ` outcome-${escape(t.outcome)}` : ''}${t.live ? ' is-live' : ''}" data-action="jira-tab" data-tab="${t.id}" aria-selected="${t.id === current.id}">${t.live ? '<span class="spinner" aria-hidden="true"></span>' : ''}${escape(t.label)}</button>`).join('')}</div>
    <div class="jira-tab-panel" role="tabpanel">${panel}</div>
  </section>`;
}

export function jiraView(state, ui, copilot) {
  const demo = state.mode === 'demo', board = ui.board;
  const page = body => `<section class="maintenance-page jira-page">${body}</section>`;
  if (!state.jira) return page(`${ui.head ? ui.head('') : ''}${settingsView(state.jira)}`);
  if (!board) return page('<p class="text-muted"><span class="spinner"></span></p>');
  if (board.error) return page(`<p class="inline-error">${escape(board.error)}</p>`);
  return page(boardView(board, copilot, ui.answers, ui.shown ?? null, ui.tell, ui.tells, ui.warn, ui.assistantClosed, ui.head ?? null, ui.feedOpen, ui.to, ui.unread, ui.screens, ui.filtered ?? null));
}

export function settingsFrom(form) {
  const { token = '', clearToken, ...data } = Object.fromEntries(new FormData(form));
  return { settings: { ...data, maxIterations: Number(data.maxIterations) }, token, clearToken: clearToken === 'on' };
}
