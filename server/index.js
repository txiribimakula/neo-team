import { availableImportRules } from './import-query.js';
import {refreshSection,downloadCapacity} from './refresh.js';
import { mergeProjects, sourcesOf, sourceId } from './multi-project.js';
import http from 'node:http';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import openPath from 'open';
import { randomBytes } from 'node:crypto';
import { LocalStore } from './store.js';
import { auditGroup } from './security.js';
import { AzureGateway } from './azure.js';
import { Planner, createLocalItem, duplicateItem, addComment, discardComment, discardLocal, stageChanges, resolveConflict, planningWorkspace, stageCapacity, discardCapacity, discardAllocation, chooseDownloadedCapacity, resolveCapacityConflict, discardStateChanges, completeTask, setDescription, reviewTaskChoice, reviewCapacityChoice } from './planner.js';
import { configFrom } from './config.js';
import { createDemo, upgradeDemoImportRules, applyDemoImportRules, demoFunctionalIssues, demoMyIteration, DEMO_STATES, DemoReviewer, DemoPullRequestGateway, DemoJiraClient, DEMO_JIRA_SETTINGS, DEMO_JIRA_ME } from './demo.js';
import { JiraClient, accountOf, jiraSettingsFrom, hasFfmpeg, listFiles, readText, sharedName, sharedOf, TOKEN_HELP } from './jira.js';
import { packState, unpackState } from './jira-share.js';
import { TicketStore, JiraPipeline, CopilotAgent, DemoAgent, collectFilter, collectScopeFrom, syncTickets, checkKey, defaultModel, autoLocked, COLUMN_MODES, STAGES, STAGE_IDS, stageOf } from './jira-agents.js';
import { CopilotReviewer, runReview, publishReview, parsePullRequestUrl, validSuggestionCode, LIMITS as REVIEW_LIMITS } from './pr-review.js';
import { checkRepository, repositoryKey } from './local-repo.js';
import { runAssistant, assistantRequest, setImportRule } from './assistant.js';
import { maintenanceSettingsFrom } from './maintenance.js';
import { describeError, errorLocation, isInternalError, recordFailure } from './diagnostics.js';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.NEO_TEAM_PORT || 4310);
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };
const store = new LocalStore(resolve(process.env.NEO_TEAM_DATA_DIR || fileURLToPath(new URL('../.neo-team/', import.meta.url))));
await store.load();
const azure = new AzureGateway(), planner = new Planner(store, azure);
// Every Azure DevOps step joins the running operation, so the interface can
// show whether a query is progressing, waiting for sign-in or for a response.
azure.onActivity = entry => {
  if (!busy || !operation) return;
  operation = { ...operation, pendingCall: entry.pending, activityAt: entry.at, activity: [...(operation.activity ?? []), { at: entry.at, kind: entry.kind, message: entry.message }].slice(-80) };
};
// Pull request review: Azure DevOps and GitHub Copilot in the real workspace,
// simulated in the example.
const copilot = new CopilotReviewer(), demoReviewer = new DemoReviewer(), demoPullRequests = new DemoPullRequestGateway();
const reviewTools = () => store.data.mode === 'demo' ? { gateway: demoPullRequests, reviewer: demoReviewer } : { gateway: azure, reviewer: copilot };
function reviewConfig() {
  if (store.data.mode === 'demo') return { organization: 'ejemplo', project: 'Neo Platform', team: '', authentication: 'interactive', tenant: '' };
  if (!store.data.config?.project) throw fail('Conecta Azure DevOps y elige un proyecto para revisar sus pull requests.');
  return configFrom(store.data.config, false);
}
// Jira tickets: settings and token of the real workspace, a fixed example, and
// one pipeline of agents per tickets folder, running apart from other operations.
const jiraTokenFile = () => join(store.directory, 'jira-token');
async function jiraToken() {
  if (process.env.NEO_TEAM_JIRA_TOKEN) return process.env.NEO_TEAM_JIRA_TOKEN.trim();
  return (await readFile(jiraTokenFile(), 'utf8').catch(() => '')).trim();
}
let jiraHasToken = false;
// The connected Jira account, kept to know which tickets are assigned to you.
const jiraMe = () => store.data.mode === 'demo' ? DEMO_JIRA_ME : store.data.jiraMe ?? null;
async function saveJiraMe(me) {
  const account = accountOf(me);
  if (!account || JSON.stringify(account) === JSON.stringify(store.data.jiraMe)) return;
  const data = structuredClone(store.data); data.jiraMe = account; await store.save(data);
}
const refreshJiraToken = async () => { jiraHasToken = !!(await jiraToken()); };
await refreshJiraToken();
function jiraSettings() {
  const base = store.data.mode === 'demo' ? DEMO_JIRA_SETTINGS : store.data.jira;
  return base ? { ...base, models: store.data.jiraModels ?? {}, modes: store.data.jiraModes ?? {}, collect: collectScopeFrom(store.data.jiraCollect) } : null;
}
const jiraRoot = settings => store.data.mode === 'demo' ? join(store.directory, 'jira-ejemplo') : resolve(settings?.ticketsDir || join(store.directory, 'jira'));
function publicJira() {
  const settings = jiraSettings();
  return settings ? { ...settings, account: jiraMe()?.name ?? null, demo: store.data.mode === 'demo', hasToken: store.data.mode === 'demo' || jiraHasToken, tokenFromEnv: !!process.env.NEO_TEAM_JIRA_TOKEN, root: jiraRoot(settings) } : null;
}
// Models the Copilot account may use, remembered from the last check.
let copilotModels = [];
const jiraPipelines = new Map();
function jiraPipeline() {
  const settings = jiraSettings();
  if (!settings) throw fail('Configura Jira primero.');
  const root = jiraRoot(settings), demo = store.data.mode === 'demo';
  if (!jiraPipelines.has(root)) {
    const tickets = new TicketStore(root);
    // The agents cannot read Neo Team's data (the Jira token among it) apart from the
    // tickets, nor run anything that names the Jira site.
    const host = (() => { try { return new URL(settings.url).host; } catch { return ''; } })();
    const guard = { hidden: [store.directory], visible: [root], blocked: [host] };
    jiraPipelines.set(root, new JiraPipeline({ tickets, demo, agent: demo ? new DemoAgent({ delayMs: Number(process.env.NEO_TEAM_DEMO_AGENT_MS ?? 700) }) : new CopilotAgent({ guard }), settings: async () => (demo ? { ...DEMO_JIRA_SETTINGS, models: store.data.jiraModels ?? {}, modes: store.data.jiraModes ?? {} } : jiraSettings()),
      chatAgent: demo ? () => new DemoAgent({ delayMs: Number(process.env.NEO_TEAM_DEMO_AGENT_MS ?? 700) }) : () => new CopilotAgent({ guard }),
      comment: async (key, body) => (demo ? new DemoJiraClient() : new JiraClient(jiraSettings(), await jiraToken())).addComment(key, body),
      missing: async () => { const tools = await detectJiraTools(); return { copilot: copilotSignedIn === false, winapp: !tools.winapp }; },
      models: async () => { if (!demo && !copilotModels.length) copilotModels = (await copilot.status()).models ?? []; return demo ? [] : copilotModels; } }));
    const pipeline = jiraPipelines.get(root);
    pipeline.recovered = pipeline.recover().catch(() => {});
  }
  return jiraPipelines.get(root);
}
let jiraTools = null;
// Whether the last check found a Copilot session (null: not checked yet).
let copilotSignedIn = null;
const which = command => new Promise(done => execFile(process.platform === 'win32' ? 'where' : 'which', [command], { timeout: 5000 }, error => done(!error)));
async function detectJiraTools() {
  if (!jiraTools || Date.now() - jiraTools.at > 60000) jiraTools = { at: Date.now(), winapp: await which('winapp'), ffmpeg: await hasFfmpeg() };
  return { winapp: jiraTools.winapp, ffmpeg: jiraTools.ffmpeg };
}
async function jiraBoard() {
  const settings = publicJira();
  if (!settings) return { settings: null };
  const pipeline = jiraPipeline();
  await pipeline.recovered;
  await pipeline.generalState();
  const tickets = (await pipeline.tickets.list()).map(t => ({ ...t, locked: autoLocked(t), history: (t.history ?? []).map(({ usage, activity, ...h }) => ({ ...h, tokens: usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : null })) }));
  const lessons = Object.fromEntries(await Promise.all(STAGES.map(async s => [s.id, ((await pipeline.tickets.learnings(s.id)).match(/^- /gm) ?? []).length])));
  return { settings, tickets, lessons, pipeline: pipeline.snapshot(), defaults: Object.fromEntries(STAGES.map(s => [s.id, defaultModel(s.tier, copilotModels)])), tools: store.data.mode === 'demo' ? { winapp: true, ffmpeg: true, demo: true } : await detectJiraTools() };
}
const currentReviews = () => (store.data.prReviews ?? []).filter(review => review.mode === store.data.mode);
function findReview(data, id) {
  const review = (data.prReviews ?? []).find(r => r.id === id && r.mode === data.mode);
  if (!review) throw fail('La revisión ya no está disponible. Actualiza la página.', 404);
  return review;
}
// A decision taken in the review updates that review instead of discarding it, as
// long as nothing else changed the plan since it was prepared.
function keepReview(before, update) {
  if (planner.review?.version !== before) { planner.review = null; return; }
  update(planner.review);
  planner.review.version = store.data.version;
}
const csrf = randomBytes(32).toString('hex');
let busy = false;
let importProgress = null;
let operation = null;
planner.onProgress = message => { if (operation) operation = {...operation,message,updatedAt:Date.now()}; };
let stateReview = null;
let security = null;
const securityScope = () => JSON.stringify([store.data.config?.organization, store.data.config?.project]);
const currentSecurity = () => security?.scope === securityScope() ? security : null;
// The closed states chosen for maintenance are saved per project; the last
// query result is kept in memory for the active mode and project.
let maintenance = null;
const maintenanceScope = () => JSON.stringify([store.data.mode, store.data.config?.organization, store.data.config?.project]);
const maintenanceKey = () => store.data.mode === 'demo' ? 'demo' : [store.data.config?.organization, store.data.config?.project].map(value => String(value ?? '').toLowerCase()).join('\n');
const currentMaintenanceSettings = () => store.data.maintenanceSettings?.[maintenanceKey()] ?? null;
const currentMaintenance = () => maintenance?.scope === maintenanceScope() ? maintenance : null;
// My iteration: the last query, in memory, for the active mode and connection.
let myIteration = null;
const myIterationScope = () => JSON.stringify([store.data.mode, store.data.config?.organization, store.data.config?.project, store.data.config?.team]);
const currentMyIteration = () => myIteration?.scope === myIterationScope() ? myIteration : null;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// Local steps after the Azure queries join the activity, so a failure shows
// where it stopped instead of the last request sent to Azure.
function step(message) {
  const at = Date.now();
  operation = { ...operation, message, step: message, updatedAt: at, activity: [...(operation.activity ?? []), { at, kind: 'info', message }].slice(-80) };
  if (operation.path === '/api/import') importProgress = operation;
}
function explain(error) {
  if (!isInternalError(error) || error.explained) return error;
  const location = errorLocation(error);
  error.message = `Error interno durante «${operation?.step || operation?.message || 'la operación'}»${location ? ` (${location})` : ''}: ${error.message}`;
  error.explained = true;
  return error;
}
async function saveDiagnostics(kind, error) {
  const where = operation?.step || operation?.message;
  console.error(`[neo-team] ${operation?.title ?? kind} falló${where ? ` en «${where}»` : ''}:`, error);
  try {
    return await recordFailure(store.directory, { kind, operation: operation && { path: operation.path, title: operation.title, status: operation.status, phase: operation.phase, step: operation.step, message: operation.message, counts: operation.counts, pendingCall: operation.pendingCall, startedAt: new Date(operation.startedAt).toISOString(), activity: operation.activity ?? [] }, error: describeError(error) });
  } catch (failure) { console.error('[neo-team] No se pudo guardar el diagnóstico:', failure); return null; }
}
// The session token changes when the server restarts: the interface renews it
// and repeats the request, which the server rejected without changing anything.
function requireSession(req) {
  if (req.headers['x-neo-csrf'] !== csrf) throw Object.assign(fail('La sesión local ha caducado. Recarga la aplicación para renovarla.', 403), { reason: 'session' });
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
function publicState({ operationComplete = false } = {}) {
  // Successful POST snapshots describe the state after this operation ends.
  // GET snapshots still expose running operations for progress and recovery.
  const active = busy && !operationComplete;
  const workspace = planner.workspace();
  return { csrf, version: store.data.version, config: store.data.config, mode: store.data.mode, hasAzure: !!store.data.azure, maintenanceSettings: currentMaintenanceSettings(), importRules: availableImportRules(workspace,store.data.mode==='azure' ? store.data.stateRules : workspace?.importRules), busy: active, operation: active ? operation : null, stateReview,
    workspace: workspace ? planningWorkspace(workspace) : null, prReviews: currentReviews(), localRepositories: store.data.localRepositories ?? {}, copilotModel: store.data.copilotModel ?? null, jira: publicJira() };
}
const BODY_LIMIT = 100000;
// Chunks are joined before decoding, so a character split between two chunks
// (accents, «», emoji) is never corrupted.
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('Se requiere JSON.', 415);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw fail('Petición demasiado grande.', 413);
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw fail('JSON no válido.'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Se esperaba un objeto JSON.');
  return input;
}
// Requests that only change the local copy. Their errors are validation
// messages, so they do not leave a diagnostic report.
const LOCAL_PATHS = new Set(['/api/pr-finding', '/api/pr-review-delete', '/api/state-rules', '/api/maintenance-settings', '/api/config', '/api/mode', '/api/create', '/api/duplicate', '/api/comment', '/api/comment-discard', '/api/discard-allocation', '/api/capacity-download-choice', '/api/complete-task', '/api/import-rule', '/api/stage', '/api/capacity', '/api/discard-capacity', '/api/resolve-capacity', '/api/discard', '/api/resolve', '/api/description', '/api/pr-local-repo', '/api/copilot-model', '/api/jira-settings', '/api/jira-model', '/api/jira-mode', '/api/jira-collect', '/api/jira-answer', '/api/jira-rewind', '/api/jira-tell', '/api/jira-pause', '/api/jira-general-reset', '/api/jira-comment', '/api/jira-seen', '/api/jira-autolock', '/api/jira-learnings', '/api/jira-move', '/api/jira-archive', '/api/jira-run', '/api/jira-auto', '/api/jira-stop', '/api/jira-open']);
const today = () => new Date().toISOString().slice(0, 10);
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host)) throw fail('Host no permitido.', 403);
    if (req.headers.origin && !allowedHosts.map(h=>`http://${h}`).includes(req.headers.origin)) throw fail('Origen no permitido.', 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    // Another website can link to or embed the local API, but never use it.
    if (path.startsWith('/api/') && req.headers['sec-fetch-site'] === 'cross-site') throw fail('Origen no permitido.', 403);
    if (req.method === 'GET' && path === '/api/state') return json(res, publicState());
    if (req.method === 'GET' && path === '/api/operation') {
      requireSession(req);
      return json(res, { operation: operation?.id === url.searchParams.get('id') ? operation : null });
    }
    if (req.method === 'GET' && path === '/api/import-progress') {
      requireSession(req);
      return json(res, { progress: importProgress?.id === url.searchParams.get('id') ? importProgress : null });
    }
    if (req.method === 'GET' && path === '/api/security') {
      requireSession(req);
      return json(res, { security: currentSecurity() });
    }
    if (req.method === 'GET' && path === '/api/maintenance') {
      requireSession(req);
      return json(res, { maintenance: currentMaintenance() });
    }
    if (req.method === 'GET' && path === '/api/my-iteration') {
      requireSession(req);
      return json(res, { myIteration: currentMyIteration() });
    }
    if (req.method === 'GET' && path === '/api/jira') {
      requireSession(req);
      return json(res, { jira: await jiraBoard() });
    }
    if (req.method === 'GET' && path === '/api/jira-ticket') {
      requireSession(req);
      const key = checkKey(url.searchParams.get('key')), tickets = jiraPipeline().tickets, folder = tickets.folder(key);
      const ticket = await tickets.get(key);
      if (!ticket) throw fail('El ticket ya no está disponible.', 404);
      const read = name => readText(join(folder, name), 300000);
      const reports = await Promise.all((ticket.history ?? []).filter(h => h.report).map(async h => ({ ...h, text: await read(h.report) })));
      const commentList = await readText(join(folder, 'comentarios.json')).then(text => text ? JSON.parse(text) : null).catch(() => null);
      return json(res, { ticket: { ...ticket, folder, files: await listFiles(folder, 3), description: await read('descripcion.md'), comments: await read('comentarios.md'), commentList, reports } });
    }
    // Images of a ticket (attachments, frames, evidence) shown inside its texts. An
    // <img> cannot send the session header, so the session goes in the address.
    if (req.method === 'GET' && path === '/api/jira-file') {
      if (url.searchParams.get('s') !== csrf) throw fail('La sesión local ha caducado. Recarga la aplicación.', 403);
      const key = checkKey(url.searchParams.get('key')), folder = jiraPipeline().tickets.folder(key);
      const file = resolve(folder, String(url.searchParams.get('path') ?? ''));
      const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[file.split('.').at(-1).toLowerCase()];
      if (!type || !file.startsWith(folder + sep) || file.split(sep).includes('codigo')) throw fail('No encontrado.', 404);
      const content = await readFile(file).catch(() => null);
      if (!content) throw fail('No encontrado.', 404);
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': content.length });
      return res.end(content);
    }
    if (req.method === 'GET' && path === '/api/jira-learnings') {
      requireSession(req);
      const tickets = jiraPipeline().tickets;
      return json(res, { learnings: Object.fromEntries(await Promise.all(['general', ...STAGES.map(s => s.id)].map(async scope => [scope, await tickets.learnings(scope)]))) });
    }
    if (req.method === 'POST' && path.startsWith('/api/')) {
      requireSession(req);
      const input = await body(req);
      if (path === '/api/cancel-operation') {
        if (!busy || !operation || input.id !== operation.id) throw fail('La operación ya terminó o cambió. Actualiza su estado.', 409);
        if (!operation.cancellable) throw fail('Esta operación no se puede cancelar mientras guarda o sincroniza datos.', 409);
        operation = { ...operation, cancelRequested: true, cancellable: false, message: 'Cancelando la consulta…', updatedAt: Date.now() };
        if (['/api/pr-review', '/api/copilot-status', '/api/assistant'].includes(operation.path)) await copilot.abort();
        await azure.close();
        return json(res, { cancelling: true });
      }
      if (busy) throw fail('Hay una operación en curso. Espera a que termine.', 409);
      if (input.version !== store.data.version) throw fail('La planificación cambió en otra ventana. Recarga para ver la versión actual.', 409);
      busy = true;
      const labels = { '/api/maintenance': 'Consultando mantenimiento', '/api/my-iteration': 'Consultando mi iteración', '/api/maintenance-states': 'Consultando estados', '/api/security-groups': 'Consultando grupos de permisos', '/api/security-audit': 'Analizando permisos del grupo', '/api/refresh-section':'Actualizando sección', '/api/download-capacity':'Descargando capacidad', '/api/upload-capacity':'Subiendo capacidad', '/api/import': 'Importando equipo', '/api/projects': 'Buscando proyectos', '/api/teams': 'Buscando equipos', '/api/review': 'Revisando cambios', '/api/work-item-states': 'Consultando estados', '/api/sync': 'Sincronizando cambios', '/api/pr-repositories': 'Buscando repositorios', '/api/pr-list': 'Buscando pull requests', '/api/pr-mine': 'Buscando tus pull requests', '/api/pr-review': 'Revisando el pull request con GitHub Copilot', '/api/pr-publish': 'Publicando comentarios en Azure DevOps', '/api/copilot-status': 'Comprobando GitHub Copilot', '/api/jira-settings': 'Conectando con Jira', '/api/jira-refresh': 'Actualizando desde Jira', '/api/assistant': 'Consultando a GitHub Copilot' };
      operation = { id: typeof input.operationId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(input.operationId) ? input.operationId : randomBytes(16).toString('hex'), path, status: 'running', title: labels[path] || 'Guardando cambios locales', phase: 'connection', message: 'Preparando la operación…', counts: {}, startedAt: Date.now(), updatedAt: Date.now(), cancellable: ['/api/assistant', '/api/jira-refresh', '/api/pr-repositories', '/api/pr-list', '/api/pr-mine', '/api/pr-review', '/api/copilot-status', '/api/refresh-section', '/api/import', '/api/projects', '/api/teams', '/api/security-groups', '/api/security-audit', '/api/maintenance', '/api/my-iteration', '/api/maintenance-states', '/api/work-item-states'].includes(path) };
      try {
        // Load the available task states on demand for the local editor.
        if (path === '/api/work-item-states') {
          const workspace = planner.workspace();
          const scope=workspace?.sources ? workspace.sources.find(s=>s.id===input.sourceId) : workspace;
          if (!scope || !['task','bug','tarea'].includes(String(input.type).toLowerCase())) throw fail('Elige un proyecto y un tipo de tarea o bug.');
          let states;
          if (workspace.mode === 'demo') states=DEMO_STATES;
          else {
            const config=scope.config;
            await azure.open(configFrom(config));
            if (operation.cancelRequested) throw fail('Consulta cancelada.');
            operation = { ...operation, message: `Consultando los estados de «${input.type}» en ${config.project}…`, updatedAt: Date.now() };
            states=await azure.workItemStates(config,input.type);
          }
          if (operation.cancelRequested) throw fail('Consulta cancelada.');
          const data=structuredClone(store.data), next=data[data.mode];
          const target=next.sources ? next.sources.find(s=>s.id===input.sourceId) : next;
          target.workItemStates={...target.workItemStates,[input.type]:states};
          await store.save(data);planner.review=null;
          return json(res, {states,state:publicState({ operationComplete: true })});
        }
        if (path === '/api/maintenance') {
          const reportProgress = progress => {
            if (operation.cancelRequested) throw fail('Consulta cancelada.');
            operation = { ...operation, ...progress, updatedAt: Date.now() };
          };
          const settings = currentMaintenanceSettings();
          if (!settings) throw fail('Elige primero qué estados se consideran cerrados.');
          if (store.data.mode === 'demo') maintenance = { scope: maintenanceScope(), ...demoFunctionalIssues(settings) };
          else {
            if (!store.data.config?.project) throw fail('Conecta un proyecto de Azure DevOps para consultar el mantenimiento.');
            const config = configFrom(store.data.config, false);
            reportProgress({ message: 'Conectando con Azure DevOps…' });
            await azure.open(config);
            if (operation.cancelRequested) throw fail('Consulta cancelada.');
            maintenance = { scope: maintenanceScope(), ...(await azure.functionalIssues(config, settings, reportProgress)) };
          }
          return json(res, { maintenance: currentMaintenance() });
        }
        // Every imported team (or the connected one) with its current iteration.
        if (path === '/api/my-iteration') {
          const reportProgress = progress => {
            if (operation.cancelRequested) throw fail('Consulta cancelada.');
            operation = { ...operation, ...progress, updatedAt: Date.now() };
          };
          if (store.data.mode === 'demo') myIteration = { scope: myIterationScope(), ...demoMyIteration() };
          else {
            const configs = store.data.azure ? sourcesOf(store.data.azure).map(source => configFrom(source.config)) : store.data.config?.team ? [configFrom(store.data.config)] : [];
            if (!configs.length) throw fail('Conecta Azure DevOps con un proyecto y un equipo para consultar tu iteración.');
            reportProgress({ message: 'Conectando con Azure DevOps…' });
            await azure.open(configs[0]);
            const boards = [];
            for (const config of configs) {
              if (operation.cancelRequested) throw fail('Consulta cancelada.');
              boards.push(await azure.myIteration(config, reportProgress));
            }
            myIteration = { scope: myIterationScope(), fetchedAt: new Date().toISOString(), demo: false, boards };
          }
          return json(res, { myIteration: currentMyIteration() });
        }
        // The possible states of a type, so the person can choose which are closed.
        if (path === '/api/maintenance-states') {
          const type = typeof input.type === 'string' ? input.type.trim() : '';
          if (!type || type.length > 128) throw fail('Indica el tipo de elemento.');
          if (store.data.mode === 'demo') return json(res, { type, states: DEMO_STATES });
          if (!store.data.config?.project) throw fail('Conecta un proyecto de Azure DevOps.');
          const config = configFrom(store.data.config, false);
          operation = { ...operation, message: 'Conectando con Azure DevOps…', updatedAt: Date.now() };
          await azure.open(config);
          if (operation.cancelRequested) throw fail('Consulta cancelada.');
          operation = { ...operation, message: `Consultando los estados de «${type}» en ${config.project}…`, updatedAt: Date.now() };
          let states;
          try { states = await azure.workItemStates(config, type); }
          catch (error) { throw fail(`No se pudieron consultar los estados de «${type}» en ${config.project}. Comprueba el nombre del tipo. ${error.message}`); }
          if (!states.length) throw fail(`«${type}» no tiene estados en ${config.project}. Comprueba el nombre del tipo.`);
          return json(res, { type, states });
        }
        if (['/api/security-groups', '/api/security-audit'].includes(path)) {
          if (!store.data.config?.project) throw fail('Conecta un proyecto de Azure DevOps para consultar sus permisos.');
          const reportProgress = progress => {
            if (operation.cancelRequested) throw fail('Consulta cancelada.');
            operation = { ...operation, ...progress, updatedAt: Date.now() };
          };
          const securityConfig = configFrom(store.data.config, false);
          const browserLogin = input.reauthenticate === true;
          reportProgress({ message: browserLogin ? 'Abriendo el navegador de Microsoft para elegir cuenta…' : securityConfig.authentication === 'azcli' ? 'Usando la sesión existente de Azure CLI. Este método no abre una ventana de autenticación.' : 'Usando el acceso de Microsoft. La sesión del sistema puede reutilizarse sin abrir una ventana.' });
          if (browserLogin) await azure.close();
          await azure.open(browserLogin ? { ...securityConfig, authentication: 'interactive' } : securityConfig);
          if (operation.cancelRequested) throw fail('Consulta cancelada.');
          if (browserLogin) await azure.call('neo_security_login', {});
          reportProgress({ message: 'Consultando la seguridad del proyecto…' });
          const call = args => azure.call('neo_security_read', { project: securityConfig.project, ...args });
          if (path === '/api/security-groups') {
            const catalog = await call({ action: 'catalog', project: store.data.config.project });
            reportProgress({ message: `${catalog.groups.length} grupos encontrados.` });
            security = { scope: securityScope(), catalog, report: null };
          } else {
            const snapshot = currentSecurity();
            if (!snapshot) throw fail('Actualiza primero la lista de grupos.');
            const report = await auditGroup(call, snapshot.catalog, input.descriptor, reportProgress);
            reportProgress({ message: 'Informe de permisos preparado.' });
            security = { ...snapshot, report };
          }
          return json(res, { security: currentSecurity() });
        }
        if (path === '/api/projects') {
          operation.message = 'Conectando y consultando los proyectos de Azure DevOps… La sesión puede reutilizarse sin pedir acceso de nuevo.';
          await azure.open(configFrom(input.config, false));
          return json(res, { projects: await azure.projects() });
        }
        if (path === '/api/teams') {
          operation.message = 'Conectando y consultando los equipos de Azure DevOps… La sesión puede reutilizarse sin pedir acceso de nuevo.';
          const config = configFrom(input.config, false);
          if (!config.project) throw fail('Indica el proyecto.');
          await azure.open(config);
          return json(res, { teams: await azure.teams(config.project) });
        }
        const progress = update => {
          if (operation.cancelRequested) throw fail('Consulta cancelada.');
          operation = { ...operation, ...update, updatedAt: Date.now() };
        };
        // Pull request review: lists and the review only read Azure DevOps; the
        // review itself is saved locally until the person publishes it.
        if (['/api/pr-repositories', '/api/pr-list', '/api/pr-mine', '/api/pr-review', '/api/pr-publish'].includes(path)) {
          const config = reviewConfig(), { gateway, reviewer } = reviewTools();
          if (gateway === azure) { progress({ message: 'Conectando con Azure DevOps. Completa el acceso de Microsoft si se solicita.' }); await azure.open(config); progress({}); }
          if (path === '/api/pr-repositories') return json(res, { repositories: await gateway.repositories(config) });
          if (path === '/api/pr-mine') {
            progress({ message: `Buscando tus pull requests activos en ${config.project}…` });
            return json(res, { mine: await gateway.myPullRequests(config) });
          }
          if (path === '/api/pr-list') {
            const repository = typeof input.repository === 'string' ? input.repository.trim() : '';
            if (!repository || repository.length > 200) throw fail('Elige un repositorio.');
            progress({ message: `Buscando los pull requests activos de «${repository}»…` });
            return json(res, { pullRequests: await gateway.pullRequests(config, repository) });
          }
          if (path === '/api/pr-review') {
            const fromUrl = input.url ? parsePullRequestUrl(input.url) : null;
            if (input.url && !fromUrl) throw fail('Pega la URL de un pull request de Azure DevOps (…/_git/repositorio/pullrequest/número).');
            const target = fromUrl ?? { organization: config.organization, project: config.project, repository: typeof input.repository === 'string' ? input.repository.trim() : '', pullRequestId: input.pullRequestId };
            if (store.data.mode !== 'demo' && target.organization.toLowerCase() !== config.organization.toLowerCase()) throw fail(`El pull request es de la organización «${target.organization}» y Neo Team está conectado a «${config.organization}». Cambia la organización en la configuración.`);
            if (!target.repository || target.repository.length > 200 || !Number.isSafeInteger(target.pullRequestId) || target.pullRequestId < 1) throw fail('Elige un repositorio y un pull request.');
            if (store.data.mode === 'demo') target.project = config.project;
            // A repository with a local folder is compared there; the folder is checked again each time.
            const folder = store.data.mode === 'demo' ? null : store.data.localRepositories?.[repositoryKey(config.organization, target.project, target.repository)];
            const local = folder ? await checkRepository(folder, target.repository) : null;
            const review = await runReview({ azure: gateway, reviewer, config, target, mode: store.data.mode, local, model: store.data.mode === 'demo' ? null : store.data.copilotModel, onProgress: progress });
            progress({ cancellable: false });
            const data = structuredClone(store.data);
            data.prReviews = [review, ...(data.prReviews ?? [])].slice(0, REVIEW_LIMITS.reviews);
            await store.save(data);
            return json(res, { reviewId: review.id, state: publicState({ operationComplete: true }) });
          }
          const review = findReview(store.data, input.id);
          const result = await publishReview({ azure: gateway, config, review, includeSummary: input.includeSummary === true, onProgress: progress, onPublished: async (itemId, published) => {
            const data = structuredClone(store.data), saved = findReview(data, review.id);
            if (itemId === 'summary') saved.summaryPublished = published;
            else saved.findings.find(f => f.id === itemId).published = published;
            await store.save(data);
          } });
          return json(res, { result, state: publicState({ operationComplete: true }) });
        }
        if (path === '/api/pr-local-repo') {
          // The local clone of a repository, so its pull requests are compared with git.
          if (store.data.mode === 'demo') throw fail('En el ejemplo no se usan repositorios locales.');
          const config = reviewConfig(), repository = typeof input.repository === 'string' ? input.repository.trim() : '', project = typeof input.project === 'string' && input.project.trim() ? input.project.trim() : config.project;
          if (!repository || repository.length > 200 || project.length > 200) throw fail('Elige un repositorio.');
          const key = repositoryKey(config.organization, project, repository), data = structuredClone(store.data);
          data.localRepositories = { ...data.localRepositories };
          if (typeof input.path === 'string' && input.path.trim()) data.localRepositories[key] = (await checkRepository(input.path, repository)).path;
          else delete data.localRepositories[key];
          await store.save(data);
          return json(res, publicState());
        }
        // The AI prompt of a planning tab: only the local copy of that tab changes.
        if (path === '/api/assistant') {
          const answer = await runAssistant({ request: assistantRequest(input), store, agent: copilot, model: store.data.copilotModel ?? null,
            onActivity: message => { if (!operation.cancelRequested) step(message); }, onChange: () => { planner.review = null; } });
          return json(res, { assistant: answer, state: publicState({ operationComplete: true }) });
        }
        if (path === '/api/copilot-model') {
          // The model that reviews; empty: the default of the plan (or NEO_TEAM_COPILOT_MODEL).
          const model = typeof input.model === 'string' ? input.model.trim() : '';
          if (model.length > 100 || (model && !/^[\w.:/-]+$/.test(model))) throw fail('Modelo no válido.');
          const data = structuredClone(store.data);
          if (model) data.copilotModel = model; else delete data.copilotModel;
          await store.save(data);
          return json(res, publicState());
        }
        if (path === '/api/copilot-status') {
          const { reviewer } = reviewTools();
          progress({ message: 'Iniciando GitHub Copilot y comprobando la sesión de GitHub de este equipo…' });
          const status = await reviewer.status();
          if (reviewer === copilot) copilotSignedIn = !!status.isAuthenticated;
          if (reviewer === copilot && status.isAuthenticated) { copilotModels = status.models ?? []; for (const pipeline of jiraPipelines.values()) { pipeline.needsCopilot = false; pipeline.error = null; } }
          return json(res, { copilot: status });
        }
        if (path === '/api/jira-refresh') {
          // One update: the tickets on the board first (the finished ones leave, the changed
          // ones are downloaded again) and then the filter, whose new tickets reach Analizar.
          const settings = jiraSettings();
          if (!settings) throw fail('Configura Jira primero.');
          const client = store.data.mode === 'demo' ? new DemoJiraClient() : new JiraClient(settings, await jiraToken());
          const pipeline = jiraPipeline();
          if (client instanceof JiraClient) await saveJiraMe(await client.call('/rest/api/2/myself').catch(() => null));
          const ffmpeg = store.data.mode !== 'demo' && (await detectJiraTools()).ffmpeg;
          const options = { client, settings, tickets: pipeline.tickets, me: jiraMe(), ffmpeg, busyKey: pipeline.running?.key, scope: settings.collect, onProgress: progress };
          // A single ticket has to be in the filter: that is checked before touching anything.
          const single = settings.collect.mode === 'single' ? await collectFilter(options) : null;
          const sync = await syncTickets(options);
          // A ticket finished in Jira is no longer waiting for an agent.
          pipeline.queue = pipeline.queue.filter(q => !sync.closed.includes(q.key));
          if (sync.closed.includes(pipeline.focus)) pipeline.focus = null;
          const collect = single ?? await collectFilter(options);
          await pipeline.collectAll();
          return json(res, { result: { sync, collect }, jira: await jiraBoard(), state: publicState({ operationComplete: true }) });
        }
        if (path === '/api/jira-share' || path === '/api/jira-resume') {
          // The state of a ticket goes to Jira as an attachment, so another computer can
          // go on with it; or the one another computer left there replaces the one here.
          const settings = jiraSettings(), pipeline = jiraPipeline(), key = checkKey(input.key);
          const ticket = await pipeline.tickets.get(key);
          if (!ticket) throw fail('El ticket ya no está disponible.', 404);
          if (pipeline.running?.key === key) throw fail(`${key} tiene un paso en curso: detenlo o espera a que termine.`, 409);
          const client = store.data.mode === 'demo' ? new DemoJiraClient() : new JiraClient(settings, await jiraToken());
          if (path === '/api/jira-share') {
            // A state someone else uploaded and this computer has not brought is never
            // left behind: it has to be brought first.
            progress({ message: `Comprobando en Jira si hay un estado más reciente de ${key}…` });
            const latest = sharedOf((await client.issue(key)).fields?.attachment ?? []);
            if (latest && latest.id !== ticket.sharedSeen) {
              await pipeline.tickets.update(key, t => ({ ...t, shared: latest }));
              throw fail(`${latest.author || 'Otra persona'} subió un estado de ${key}${latest.created ? ` el ${new Date(latest.created).toLocaleString('es')}` : ''} que no has traído. Tráelo antes de subir el tuyo.`, 409);
            }
            progress({ message: `Preparando el estado de ${key}…` });
            const pack = await packState(pipeline.tickets, key, { by: jiraMe()?.name ?? '' });
            progress({ message: `Subiendo ${sharedName(key)} (${Math.max(1, Math.round(pack.data.length / 1e6))} MB) a ${key}…` });
            const attachment = await client.attach(key, sharedName(key), pack.data);
            const shared = { id: String(attachment?.id ?? ''), created: attachment?.created ?? new Date().toISOString(), author: jiraMe()?.name ?? '', size: pack.data.length, content: attachment?.content ?? null };
            await pipeline.tickets.update(key, t => ({ ...t, shared, sharedSeen: shared.id, sharedOwn: shared.id }));
            // The new one replaces the previous one only if this computer uploaded it.
            let replaced = false;
            if (latest && latest.id === ticket.sharedOwn && shared.id) {
              progress({ message: `Borrando el estado anterior de ${key}…` });
              replaced = await client.deleteAttachment(latest.id).then(() => true, () => false);
            }
            return json(res, { result: { key, files: pack.files, patch: pack.patch, size: pack.data.length, replaced }, jira: await jiraBoard(), state: publicState({ operationComplete: true }) });
          }
          if (!ticket.shared?.content) throw fail(`${key} no tiene un estado compartido en Jira. Actualiza el tablero para buscarlo.`, 404);
          progress({ message: `Descargando el estado de ${key} que subió ${ticket.shared.author || 'otra persona'}…` });
          const data = Buffer.from(await (await client.download(ticket.shared.content)).arrayBuffer());
          progress({ message: `Aplicando el estado de ${key}…` });
          pipeline.queue = pipeline.queue.filter(q => q.key !== key);
          const resumed = await unpackState({ tickets: pipeline.tickets, key, data, settings, me: jiraMe() });
          await pipeline.tickets.update(key, t => ({ ...t, sharedSeen: ticket.shared.id }));
          return json(res, { result: { key, warnings: resumed.warnings, backup: resumed.backup, by: resumed.manifest.by ?? '' }, jira: await jiraBoard(), state: publicState({ operationComplete: true }) });
        }
        if (path === '/api/jira-collect') {
          // What updating collects: the filter, only your tickets or a single one.
          const data = structuredClone(store.data);
          data.jiraCollect = collectScopeFrom(input);
          await store.save(data);
          return json(res, { state: publicState({ operationComplete: true }), jira: await jiraBoard() });
        }
        if (path === '/api/jira-seen') {
          // The person opened the ticket: its news are no longer new.
          const key = checkKey(input.key), pipeline = jiraPipeline();
          if (!(await pipeline.tickets.get(key))) throw fail('El ticket ya no está disponible.', 404);
          await pipeline.tickets.update(key, t => { const { news, ...rest } = t; return rest; });
          return json(res, { jira: await jiraBoard() });
        }
        if (path === '/api/jira-settings') {
          if (store.data.mode === 'demo') throw fail('En el ejemplo la configuración de Jira es fija.');
          const data = structuredClone(store.data);
          data.jira = jiraSettingsFrom(input.settings, data.jira ?? {});
          delete data.jira.models;
          if (typeof input.token === 'string' && input.token.trim()) {
            if (input.token.trim().length > 2000 || /\s/.test(input.token.trim())) throw Object.assign(fail('El token no es válido.'), { field: 'token' });
            await mkdir(store.directory, { recursive: true, mode: 0o700 });
            await writeFile(jiraTokenFile(), input.token.trim(), { mode: 0o600 });
          } else if (input.clearToken === true) await unlink(jiraTokenFile()).catch(() => {});
          await refreshJiraToken();
          await store.save(data);
          if (!jiraHasToken) throw Object.assign(fail(`Configuración guardada. ${TOKEN_HELP}`), { reason: 'jira-token', field: 'token' });
          // The connection is checked at once with the account of the token.
          progress({ message: 'Comprobando la conexión con Jira…' });
          const me = await new JiraClient(data.jira, await jiraToken()).call('/rest/api/2/myself')
            .catch(error => { throw Object.assign(fail(`Configuración guardada, pero Jira no aceptó la conexión: ${error.message}`, error.status === 401 ? 401 : 400), { reason: error.reason, field: error.status === 401 ? 'token' : 'url' }); });
          await saveJiraMe(me);
          return json(res, { ...publicState({ operationComplete: true }), jiraAccount: jiraMe()?.name ?? null });
        }
        if (path === '/api/jira-autolock') {
          // Whether the automatic mode may take this ticket; ▶ on it always works.
          const pipeline = jiraPipeline(), key = checkKey(input.key);
          if (typeof input.locked !== 'boolean') throw fail('Valor no válido.');
          if (!(await pipeline.tickets.get(key))) throw fail('El ticket ya no está disponible.', 404);
          await pipeline.tickets.update(key, t => ({ ...t, autoLock: input.locked }));
          if (!input.locked) pipeline.setAuto(pipeline.auto);
          return json(res, { jira: await jiraBoard() });
        }
        if (path === '/api/jira-comment') {
          // Only with the person's confirmation does a step's comment reach Jira.
          if (!Number.isInteger(input.index) || input.index < 0 || typeof input.publish !== 'boolean') throw fail('Valor no válido.');
          await jiraPipeline().decideComment(checkKey(input.key), input.index, input.publish);
          return json(res, { jira: await jiraBoard() });
        }
        if (path === '/api/jira-mode') {
          if (!stageOf(input.stage) || ['collect', 'build'].includes(input.stage) || !COLUMN_MODES.includes(input.mode)) throw fail('Modo no válido.');
          const data = structuredClone(store.data);
          data.jiraModes = { ...data.jiraModes };
          if (input.mode === 'auto') delete data.jiraModes[input.stage]; else data.jiraModes[input.stage] = input.mode;
          await store.save(data);
          // Back on autopilot, the waiting tickets of that column go on.
          if (input.mode === 'auto') jiraPipeline().setAuto(jiraPipeline().auto);
          return json(res, { state: publicState({ operationComplete: true }), jira: await jiraBoard() });
        }
        if (path === '/api/jira-model') {
          if (!stageOf(input.stage)) throw fail('Columna no válida.');
          const model = typeof input.model === 'string' ? input.model.trim() : '';
          if (model.length > 100 || (model && !/^[\w.:/-]+$/.test(model))) throw fail('Modelo no válido.');
          const data = structuredClone(store.data);
          data.jiraModels = { ...data.jiraModels };
          if (model) data.jiraModels[input.stage] = model; else delete data.jiraModels[input.stage];
          await store.save(data);
          return json(res, publicState());
        }
        if (path === '/api/jira-answer') {
          // The person's answer to a stuck agent: saved in the ticket and given to the
          // agent, which is run again unless its column is off.
          const pipeline = jiraPipeline(), key = checkKey(input.key);
          const answer = typeof input.answer === 'string' ? input.answer.trim() : '';
          if (!answer || answer.length > 10000) throw fail('Escribe la respuesta (hasta 10000 caracteres).');
          const ticket = await pipeline.tickets.get(key);
          if (!ticket) throw fail('El ticket ya no está disponible.', 404);
          if (ticket.status !== 'blocked') throw fail('Este ticket no está esperando una respuesta.', 409);
          await pipeline.tickets.update(key, t => ({ ...t, status: 'pending', note: null, question: null, answers: [...(t.answers ?? []), { at: new Date().toISOString(), stage: t.stage, question: t.question ?? null, answer }] }));
          if ((jiraSettings().modes?.[ticket.stage] ?? 'auto') !== 'off') await pipeline.enqueue(key);
          return json(res, { jira: await jiraBoard() });
        }
        if (path === '/api/jira-tell') {
          // What the person tells the agent at work, from its live log.
          // To the agent at work, to the agent of a step that ended, or to the general assistant.
          if (typeof input.message !== 'string') throw fail('Mensaje no válido.');
          const pipeline = jiraPipeline();
          if (input.general === true) await pipeline.talkGeneral(input.message);
          else if (input.index !== undefined) await pipeline.talkToStep(checkKey(input.key), input.index, input.message);
          else await pipeline.tell(input.message);
          return json(res, { jira: await jiraBoard() });
        }
        if (path === '/api/jira-general-reset') {
          await jiraPipeline().resetGeneral();
          return json(res, { jira: await jiraBoard() });
        }
        if (path === '/api/jira-pause') {
          // Pausar interrupts the agent where it is; Continuar lets it go on.
          if (typeof input.on !== 'boolean') throw fail('Valor no válido.');
          await jiraPipeline().pause(input.on);
          return json(res, { jira: await jiraBoard() });
        }
        if (path === '/api/jira-rewind') {
          // The latest step of the ticket is undone: it goes back to that column.
          await jiraPipeline().rewind(checkKey(input.key));
          return json(res, { jira: await jiraBoard() });
        }
        if (['/api/jira-run', '/api/jira-auto', '/api/jira-stop', '/api/jira-move', '/api/jira-archive', '/api/jira-learnings', '/api/jira-open'].includes(path)) {
          const pipeline = jiraPipeline();
          if (path === '/api/jira-run') await pipeline.enqueue(checkKey(input.key));
          else if (path === '/api/jira-auto') pipeline.setAuto(input.on === true);
          else if (path === '/api/jira-stop') {
            if (input.general === true) await pipeline.stopGeneral();
            else if (input.index !== undefined) await pipeline.stopChat(checkKey(input.key), input.index);
            else await pipeline.stop();
          }
          else if (path === '/api/jira-move' || path === '/api/jira-archive') {
            const key = checkKey(input.key);
            if (pipeline.running?.key === key) throw fail('Un agente está trabajando en este ticket. Detenlo antes.', 409);
            if (!(await pipeline.tickets.get(key))) throw fail('El ticket ya no está disponible.', 404);
            if (path === '/api/jira-move') {
              if (!STAGE_IDS.includes(input.stage)) throw fail('Columna no válida.');
              await pipeline.tickets.update(key, t => ({ ...t, stage: input.stage, status: input.stage === 'done' ? 'done' : 'pending', note: null, ...(input.resetIterations ? { iterations: 0, reproduceAttempts: 0 } : {}) }));
            } else await pipeline.tickets.update(key, t => ({ ...t, archived: input.archived !== false }));
            pipeline.queue = pipeline.queue.filter(q => q.key !== key);
          } else if (path === '/api/jira-learnings') {
            if (typeof input.text !== 'string' || input.text.length > 200000) throw fail('Texto no válido.');
            await pipeline.tickets.saveLearnings(input.scope, input.text);
          } else {
            const folder = input.key ? pipeline.tickets.folder(checkKey(input.key)) : join(pipeline.tickets.root, 'aprendizajes');
            await mkdir(folder, { recursive: true, mode: 0o700 });
            await openPath(folder);
          }
          return json(res, { jira: await jiraBoard() });
        }
        if (path === '/api/pr-finding') {
          const data = structuredClone(store.data), finding = findReview(data, input.id).findings.find(f => f.id === input.findingId);
          if (!finding) throw fail('El comentario ya no está disponible.');
          if (finding.published) throw fail('Este comentario ya está publicado en Azure DevOps.');
          if (input.body !== undefined) {
            if (typeof input.body !== 'string' || !input.body.trim() || input.body.length > REVIEW_LIMITS.body) throw fail(`El comentario no puede estar vacío ni superar ${REVIEW_LIMITS.body} caracteres.`);
            finding.body = input.body.trim();
          }
          // The suggested change can be adjusted, or removed by leaving it empty.
          if (input.suggestion !== undefined) {
            if (!finding.suggestion) throw fail('Este comentario no tiene un cambio propuesto.');
            if (!validSuggestionCode(input.suggestion)) throw fail(`El cambio propuesto no puede contener \`\`\` ni superar ${REVIEW_LIMITS.body} caracteres.`);
            const code = input.suggestion.replace(/\r\n/g, '\n').replace(/\n$/, '');
            finding.suggestion = code.trim() ? { ...finding.suggestion, code } : null;
          }
          if (input.selected !== undefined) {
            if (typeof input.selected !== 'boolean') throw fail('Selección no válida.');
            finding.selected = input.selected;
          }
          await store.save(data);
        } else if (path === '/api/pr-review-delete') {
          const data = structuredClone(store.data);
          findReview(data, input.id);
          data.prReviews = data.prReviews.filter(r => r.id !== input.id);
          await store.save(data);
        } else if (path === '/api/state-rules') {
          if (!stateReview) throw fail('No hay un estado pendiente de revisar.');
          const choices = input.choices;
          const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
          const allowed = new Set([stateReview.state, ...stateReview.states.map(s => s.name)].map(normalize));
          if (!Array.isArray(choices) || !choices.length || choices.length > 200 || choices.some(choice => !allowed.has(normalize(choice.state)) || !['include', 'exclude'].includes(choice.action)) || !choices.some(choice => normalize(choice.state) === normalize(stateReview.state))) throw fail('Indica cómo tratar el estado pendiente: importar o excluir.');
          const data = structuredClone(store.data);
          data.stateRules ||= [];
          for (const choice of choices) {
            const rule = { organization: stateReview.organization, project: stateReview.project, type: stateReview.type, state: choice.state.trim(), action: choice.action };
            data.stateRules = data.stateRules.filter(previous => !['organization', 'project', 'type', 'state'].every(key => normalize(previous[key]) === normalize(rule[key])));
            data.stateRules.push(rule);
          }
          await store.save(data);
          stateReview = null;
        } else if (path === '/api/maintenance-settings') {
          const data = structuredClone(store.data);
          data.maintenanceSettings = { ...data.maintenanceSettings, [maintenanceKey()]: maintenanceSettingsFrom(input) };
          await store.save(data); maintenance = null;
        } else if (path === '/api/config') {
          const config = configFrom(input.config);
          const data = structuredClone(store.data);
          if (data.azure && data.azure.config.organization.toLowerCase() !== config.organization.toLowerCase()) throw fail('La planificación conjunta utiliza proyectos de la misma organización.');
          data.config = config;
          stateReview = null;
          await store.save(data); planner.review = null;
        } else if(path==='/api/refresh-section') {
          stateReview=null;
          try {
            const workspace=store.data.mode==='demo' ? applyDemoImportRules(structuredClone(store.data.demo),input.section) : await refreshSection(store.data.azure,input.section,azure,store.data.stateRules ?? [],progress=>{
              if(operation.cancelRequested) throw fail('Actualización cancelada.');
              operation={...operation,...progress,step:null,updatedAt:Date.now()};
            });
            if(operation.cancelRequested) throw fail('Actualización cancelada.');
            const data=structuredClone(store.data);data[data.mode]=workspace;
            operation={...operation,cancellable:false};step('Calculando la planificación y guardando la copia local…');await store.save(data);planner.review=null;
          } catch(error) {
            explain(error);
            if(error.stateReview) {error.stateReview={...error.stateReview,section:input.section};stateReview=error.stateReview;operation={...operation,stateReview};}
            throw error;
          }
        } else if(path==='/api/download-capacity') {
          const workspace=await downloadCapacity(store.data.azure,input.iterationId,azure,progress=>{operation={...operation,...progress,step:null,updatedAt:Date.now()};});
          const data=structuredClone(store.data);data.azure=workspace;
          step('Guardando la copia local…');await store.save(data);planner.review=null;
        } else if (path === '/api/upload-capacity') {
          return json(res, { result: await planner.uploadCapacity(input.iterationId), state: publicState({ operationComplete: true }) });
        } else if (path === '/api/capacity-download-choice') {
          const data = structuredClone(store.data);
          chooseDownloadedCapacity(data[data.mode], input.iterationId, input.key, input.choice);
          await store.save(data); planner.review = null;
        } else if (path === '/api/import') {
          if (!store.data.config) throw fail('Configura Azure DevOps primero.');
          if (Object.keys(store.data.azure?.drafts ?? {}).length || Object.keys(store.data.azure?.capacityDrafts ?? {}).length) throw fail('Sincroniza o descarta los cambios pendientes antes de importar proyectos.');
          const id = typeof input.importId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(input.importId) ? input.importId : randomBytes(16).toString('hex');
          operation = { ...operation, id, message: 'Iniciando importación…' };
          stateReview = null;
          importProgress = operation;
          try {
            const configs = input.refreshAll && store.data.azure ? sourcesOf(store.data.azure).map(s=>s.config) : [store.data.config];
            let workspace = store.data.azure;
            // The saved calendar of projects already imported may be outdated. Compare
            // the incoming project with Azure's current dates, not with the local copy.
            if (workspace && (workspace.sources || configs.some(config => sourceId(workspace.config) !== sourceId(config)))) {
              step('Actualizando las iteraciones de los proyectos ya importados…');
              workspace = await refreshSection(workspace, 'iterations', azure, store.data.stateRules || [], progress => {
                if (operation.cancelRequested) throw fail('Importación cancelada.');
                operation = { ...operation, ...progress, step: null, updatedAt: Date.now() };
                importProgress = operation;
              });
            }
            for (const [projectIndex,config] of configs.entries()) {
            const imported = await azure.import(config, progress => {
              if (operation.cancelRequested) throw fail('Importación cancelada.');
              operation = { ...operation, ...progress, step: null, message: `${config.project} (${projectIndex+1}/${configs.length}) · ${progress.message}`, updatedAt: Date.now(), cancellable: progress.phase !== 'saving' };
              importProgress = operation;
            }, store.data.stateRules || []);
            const merge = workspace && (workspace.sources || sourceId(workspace.config)!==sourceId(config));
            if (merge) step(`${config.project} (${projectIndex+1}/${configs.length}) · Uniendo con la planificación existente…`);
            workspace = merge ? mergeProjects(workspace,imported) : imported;
            }
            if (operation.cancelRequested) throw fail('Importación cancelada.');
            operation = { ...operation, cancellable: false, phase: 'saving' };
            step('Calculando la planificación y guardando la copia local…');
            // States chosen as completed by the person take precedence over Azure's categories.
            workspace.completedStates = { ...workspace.completedStates, ...(store.data.azure?.completedStates || {}) };
            const data = structuredClone(store.data); data.azure = workspace; data.mode = 'azure';
            await store.save(data); planner.review = null;
            operation = { ...operation, status: 'complete', phase: 'complete', message: 'Importación completada. Copia local guardada.' };
            importProgress = operation;
          } catch (error) {
            explain(error);
            if(error.stateReview) error.stateReview={...error.stateReview,refreshAll:input.refreshAll===true};
            stateReview = error.stateReview || null;
            operation = { ...operation, status: 'failed', message: `Importación detenida: ${error.message}`, stateReview };
            importProgress = operation;
            throw error;
          }
        } else if (path === '/api/mode') {
          if (!['demo', 'azure'].includes(input.mode)) throw fail('Modo no válido.');
          const data = structuredClone(store.data); data.mode = input.mode;
          if (input.mode === 'demo') {
            if (!data.demo) data.demo = createDemo();
            upgradeDemoImportRules(data.demo);
          }
          await store.save(data); planner.review = null;
        } else if (path === '/api/create') {
          const data=structuredClone(store.data);createLocalItem(data[data.mode],input);await store.save(data);planner.review=null;
        } else if (path === '/api/comment' || path === '/api/comment-discard') {
          const data=structuredClone(store.data);
          if(path==='/api/comment') addComment(data[data.mode],input.id,input.text); else discardComment(data[data.mode],input.key);
          await store.save(data);planner.review=null;
        } else if (path === '/api/duplicate') {
          const data=structuredClone(store.data);duplicateItem(data[data.mode],input.id);await store.save(data);planner.review=null;
        } else if (path === '/api/import-rule') {
          const data=structuredClone(store.data);setImportRule(data,input);await store.save(data);planner.review=null;
        } else if (path === '/api/complete-task') {
          const data=structuredClone(store.data);completeTask(data[data.mode],input.id);
          await store.save(data);planner.review=null;
        } else if (path === '/api/stage') {
          const data = structuredClone(store.data), workspace = data[data.mode];
          if (!workspace) throw fail('Importa datos primero.');
          if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 200) throw fail('Cambios no válidos.');
          for (const edit of input.edits) {
            if (edit.discardStates === true) discardStateChanges(workspace, edit.id);
            stageChanges(workspace, edit.id, edit.changes);
          }
          await store.save(data); planner.review = null;
        } else if (path === '/api/capacity') {
          const data = structuredClone(store.data), workspace = data[data.mode];
          if (!workspace) throw fail('Importa datos primero.');
          stageCapacity(workspace, input.iterationId, input);
          await store.save(data); planner.review = null;
        } else if (path === '/api/discard-capacity') {
          const data = structuredClone(store.data), workspace = data[data.mode];
          if (!workspace) throw fail('No hay planificación.');
          discardCapacity(workspace, input.iterationId, input.key);
          await store.save(data); planner.review = null;
        } else if (path === '/api/discard-allocation') {
          const data = structuredClone(store.data), workspace = data[data.mode];
          if (!workspace?.sources) throw fail('No hay reparto de capacidad entre proyectos.');
          discardAllocation(workspace, input.sourceId, input.iterationId, input.key);
          await store.save(data); planner.review = null;
        } else if (path === '/api/resolve-capacity') {
          const data = structuredClone(store.data), before = store.data.version;
          if (!data[data.mode]) throw fail('No hay planificación.');
          if (input.sourceId && data[data.mode].sources) {
            const source=data[data.mode].sources.find(s=>s.id===input.sourceId);
            const plan=planner.review?.capacityPlans.find(p=>p.sourceId===input.sourceId && p.iterationId===input.iterationId && p.key===input.key && p.conflict);
            if (!source || !plan || input.choice!=='local') throw fail('Vuelve a revisar el reparto de capacidad.');
            const record=source.capacities?.[plan.remoteIterationId]?.teamMembers?.find(m=>m.teamMember.id===input.key);
            if(record) Object.assign(record,plan.remote);
            else { source.capacities[plan.remoteIterationId] ??= {teamMembers:[],daysOff:[]}; source.capacities[plan.remoteIterationId].teamMembers.push({teamMember:source.members.find(m=>m.id===input.key),...plan.remote}); }
          } else resolveCapacityConflict(data[data.mode], input.iterationId, input.key, input.choice);
          await store.save(data);
          keepReview(before, review => reviewCapacityChoice(review, input, input.choice));
          return json(res, { review: planner.review ? { ...planner.review } : null, state: publicState({ operationComplete: true }) });
        } else if (path === '/api/discard') {
          const data = structuredClone(store.data), workspace = data[data.mode];
          if (!workspace) throw fail('No hay planificación.');
          discardLocal(workspace,input.id);
          await store.save(data); planner.review = null;
        } else if (path === '/api/resolve') {
          const data = structuredClone(store.data), before = store.data.version;
          resolveConflict(data[data.mode], input.id, input.choice);
          await store.save(data);
          keepReview(before, review => reviewTaskChoice(review, data[data.mode], input.id));
          return json(res, { review: planner.review ? { ...planner.review } : null, state: publicState({ operationComplete: true }) });
        } else if (path === '/api/description') {
          // Written from the review: that review stays valid, so it is not compared again.
          const data = structuredClone(store.data), before = store.data.version;
          const item = setDescription(data[data.mode], input.id, input.description, input.field);
          await store.save(data);
          const plan = planner.review?.version === before && planner.review.plans.find(p => p.creation && p.id === input.id);
          if (plan) { plan.item = { ...plan.item, description: item.description, descriptionField: item.descriptionField }; planner.review.version = store.data.version; }
          else planner.review = null;
          return json(res, { review: planner.review ? { ...planner.review } : null, state: publicState({ operationComplete: true }) });
        } else if (path === '/api/review') return json(res, { review: await planner.prepareReview(), state: publicState({ operationComplete: true }) });
        else if (path === '/api/sync') return json(res, { result: await planner.sync(input.token), state: publicState({ operationComplete: true }) });
        else throw fail('Operación no encontrada.', 404);
        operation = { ...operation, step: 'Preparando la planificación para la interfaz' };
        return json(res, publicState({ operationComplete: true }));
      } catch (error) {
        explain(error);
        // Local edits fail with validation messages; disk and internal errors keep their report.
        if (LOCAL_PATHS.has(path) && !error.status && !error.code && !isInternalError(error)) error.status = 400;
        // Validation and cancellation are expected; anything else leaves a report.
        if (!operation.cancelRequested && !error.status && !error.stateReview) error.diagnostics = await saveDiagnostics('operation', error);
        operation = { ...operation, status: operation.cancelRequested ? 'cancelled' : 'failed', error: operation.cancelRequested ? 'Consulta cancelada.' : error.message, diagnostics: error.diagnostics ?? null };
        if (operation.cancelRequested) throw fail('Consulta cancelada.');
        throw error;
      } finally {
        busy = false;
        operation = { ...operation, status: operation.status === 'running' ? (operation.cancelRequested ? 'cancelled' : 'complete') : operation.status, cancellable: false, pendingCall: null, updatedAt: Date.now() };
        if (path === '/api/import') importProgress = operation;
      }
    }
    if (req.method !== 'GET') throw fail('Método no permitido.', 405);
    // Every section has its own address (/jira, /revision-prs/…): the page is the same.
    const route = /^\/(planificacion|mi-iteracion|mantenimiento|revision-prs|jira|permisos)(\/[^.]*)?$/.test(path);
    const file = path === '/' || route ? 'index.html' : path.slice(1);
    if (!['index.html', 'app.js', 'settings.js', 'hierarchy.js', 'permissions.js', 'maintenance.js', 'my-iteration.js', 'reviews.js', 'jira.js', 'style.css', 'favicon.svg'].includes(file)) throw fail('No encontrado.', 404);
    res.setHeader('Content-Type', types[file.split('.').at(-1)]);
    res.end(await readFile(root + file));
  } catch (error) {
    if (res.headersSent) { res.destroy(); return; }
    // Internal failures are server errors; Azure and validation answers keep 400.
    const status = error.status || (isInternalError(error) ? 500 : 400);
    json(res, { error: error.message || 'No se pudo completar la operación.', ...(error.reason ? { reason: error.reason } : {}), ...(error.field ? { field: error.field } : {}), ...(error.stateReview ? { stateReview: error.stateReview } : {}), ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) }, status);
  }
});
server.on('error', error => {
  console.error(error.code === 'EADDRINUSE'
    ? `[neo-team] El puerto ${port} ya está en uso. Cierra la otra instancia de Neo Team o elige otro con NEO_TEAM_PORT.`
    : `[neo-team] No se pudo iniciar el servidor local: ${error.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => console.log(`Neo Team: http://127.0.0.1:${port}`));
// A crash would otherwise only leave a lost connection in the interface.
process.on('uncaughtException', async error => { await saveDiagnostics('uncaughtException', error); process.exit(1); });
// A stray rejection (for example, from the MCP process closing) does not affect
// the saved copy: it is reported and the server keeps answering.
process.on('unhandledRejection', error => { void saveDiagnostics('unhandledRejection', error); });
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Promise.all([...jiraPipelines.values()].map(p => p.stop().catch(() => {})));
  await azure.close();
  process.exit(0);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
