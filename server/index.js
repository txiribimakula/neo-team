import {refreshSection} from './refresh.js';
import { mergeProjects, sourcesOf, sourceId } from './multi-project.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LocalStore } from './store.js';
import { auditGroup } from './security.js';
import { AzureGateway } from './azure.js';
import { Planner, createLocalItem, discardLocal, stageChanges, resolveConflict, planningWorkspace, confirmPerson, setParticipants, selectTasks, toggleParticipation, stageCapacity, discardCapacity, resolveCapacityConflict, capacityChanges, setCompletedState, completeTask } from './planner.js';
import { createDemo, demoFunctionalIssues, DEMO_STATES } from './demo.js';
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
const csrf = randomBytes(32).toString('hex');
let busy = false;
let importProgress = null;
let operation = null;
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
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
function configFrom(input, requireTeam = true) {
  let organization = String(input?.organization || '').trim();
  if (organization.startsWith('https://dev.azure.com/')) organization = organization.replace(/^https:\/\/dev\.azure\.com\//,'').replace(/\/$/,'');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(organization)) throw fail('Indica el nombre de tu organización o su URL https://dev.azure.com/organización.');
  const project = String(input?.project || '').trim(), team = String(input?.team || '').trim();
  if (requireTeam && (!project || !team || project.length > 200 || team.length > 200)) throw fail('Indica un proyecto y un equipo válidos.');
  const authentication = input?.authentication || 'interactive';
  if (!['interactive', 'azcli'].includes(authentication)) throw fail('Método de autenticación no válido.');
  const tenant = String(input?.tenant || '').trim();
  if (tenant && !/^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(tenant)) throw fail('El tenant debe ser un identificador de Microsoft Entra válido.');
  return { organization, project, team, authentication, tenant };
}
const pendingChanges = workspace => Object.keys(workspace?.drafts || {}).length + capacityChanges(workspace).length;
const scope = c => c ? [c.organization,c.project,c.team].map(v=>v.toLowerCase()).join('\n') : '';
function publicState() {
  const workspace = planner.workspace();
  return { csrf, version: store.data.version, config: store.data.config, mode: store.data.mode, hasAzure: !!store.data.azure, maintenanceSettings: currentMaintenanceSettings(), busy, operation: busy ? operation : null, stateReview,
    workspace: workspace ? planningWorkspace(workspace) : null };
}
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail('Se requiere JSON.', 415);
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 100000) throw fail('Petición demasiado grande.', 413); }
  try { return JSON.parse(text || '{}'); } catch { throw fail('JSON no válido.'); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host)) throw fail('Host no permitido.', 403);
    if (req.headers.origin && !allowedHosts.map(h=>`http://${h}`).includes(req.headers.origin)) throw fail('Origen no permitido.', 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (req.method === 'GET' && path === '/api/state') return json(res, publicState());
    if (req.method === 'GET' && path === '/api/operation') {
      if (req.headers['x-neo-csrf'] !== csrf) throw fail('Recarga la aplicación para renovar la sesión local.', 403);
      return json(res, { operation: operation?.id === url.searchParams.get('id') ? operation : null });
    }
    if (req.method === 'GET' && path === '/api/import-progress') {
      if (req.headers['x-neo-csrf'] !== csrf) throw fail('Recarga la aplicación para renovar la sesión local.', 403);
      return json(res, { progress: importProgress?.id === url.searchParams.get('id') ? importProgress : null });
    }
    if (req.method === 'GET' && path === '/api/security') {
      if (req.headers['x-neo-csrf'] !== csrf) throw fail('Recarga la aplicación para renovar la sesión local.', 403);
      return json(res, { security: currentSecurity() });
    }
    if (req.method === 'GET' && path === '/api/maintenance') {
      if (req.headers['x-neo-csrf'] !== csrf) throw fail('Recarga la aplicación para renovar la sesión local.', 403);
      return json(res, { maintenance: currentMaintenance() });
    }
    if (req.method === 'GET' && path === '/api/export') {
      res.setHeader('Content-Disposition', 'attachment; filename="neo-team-planificacion.json"');
      return json(res, { exportedAt: new Date().toISOString(), workspace: planner.workspace() });
    }
    if (req.method === 'POST' && path.startsWith('/api/')) {
      if (req.headers['x-neo-csrf'] !== csrf) throw fail('Recarga la aplicación para renovar la sesión local.', 403);
      const input = await body(req);
      if (path === '/api/cancel-operation') {
        if (!busy || !operation || input.id !== operation.id) throw fail('La operación ya terminó o cambió. Actualiza su estado.', 409);
        if (!operation.cancellable) throw fail('Esta operación no se puede cancelar mientras guarda o sincroniza datos.', 409);
        operation = { ...operation, cancelRequested: true, cancellable: false, message: 'Cancelando la consulta…', updatedAt: Date.now() };
        await azure.close();
        return json(res, { cancelling: true });
      }
      if (busy) throw fail('Hay una operación en curso. Espera a que termine.', 409);
      if (input.version !== store.data.version) throw fail('La planificación cambió en otra ventana. Recarga para ver la versión actual.', 409);
      busy = true;
      const labels = { '/api/maintenance': 'Consultando mantenimiento', '/api/maintenance-states': 'Consultando estados', '/api/security-groups': 'Consultando grupos de permisos', '/api/security-audit': 'Analizando permisos del grupo', '/api/refresh-section':'Actualizando sección', '/api/import': 'Importando equipo', '/api/projects': 'Buscando proyectos', '/api/teams': 'Buscando equipos', '/api/review': 'Revisando cambios', '/api/work-item-states': 'Consultando estados', '/api/sync': 'Sincronizando cambios' };
      operation = { id: typeof input.operationId === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(input.operationId) ? input.operationId : randomBytes(16).toString('hex'), path, status: 'running', title: labels[path] || 'Guardando cambios locales', phase: 'connection', message: 'Preparando la operación…', counts: {}, startedAt: Date.now(), updatedAt: Date.now(), cancellable: ['/api/refresh-section', '/api/import', '/api/projects', '/api/teams', '/api/security-groups', '/api/security-audit', '/api/maintenance', '/api/maintenance-states', '/api/work-item-states'].includes(path) };
      try {
        // On demand, cancellable: the person chooses the completed state from this list.
        if (path === '/api/work-item-states') {
          const workspace = planner.workspace();
          if (!workspace?.items.some(i => i.type === input.type)) throw fail('Elige un tipo de elemento de esta planificación.');
          if (workspace.mode === 'demo') return json(res, { states: DEMO_STATES });
          operation = { ...operation, message: 'Conectando con Azure DevOps. Completa el acceso de Microsoft si se solicita.', updatedAt: Date.now() };
          // Each project has its own workflow for the same type.
          const config = workspace.sources?.find(s => s.id === input.sourceId)?.config ?? workspace.config;
          await azure.open(configFrom(config));
          if (operation.cancelRequested) throw fail('Consulta cancelada.');
          operation = { ...operation, message: `Consultando los estados de «${input.type}» en ${config.project}…`, updatedAt: Date.now() };
          return json(res, { states: await azure.workItemStates(config, input.type) });
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
        if (path === '/api/state-rules') {
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
            const workspace=await refreshSection(store.data.azure,input.section,azure,store.data.stateRules ?? [],progress=>{
              if(operation.cancelRequested) throw fail('Actualización cancelada.');
              operation={...operation,...progress,step:null,updatedAt:Date.now()};
            });
            if(operation.cancelRequested) throw fail('Actualización cancelada.');
            const data=structuredClone(store.data);data.azure=workspace;
            operation={...operation,cancellable:false};step('Calculando la planificación y guardando la copia local…');await store.save(data);planner.review=null;
          } catch(error) {
            explain(error);
            if(error.stateReview) {error.stateReview={...error.stateReview,section:input.section};stateReview=error.stateReview;operation={...operation,stateReview};}
            throw error;
          }
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
            workspace.confirmations = structuredClone(store.data.azure?.confirmations || {});
            // States chosen as completed by the person take precedence over Azure's categories.
            workspace.completedStates = { ...workspace.completedStates, ...(store.data.azure?.completedStates || {}) };
            workspace.participants = Object.fromEntries(Object.entries(store.data.azure?.participants || {}).filter(([id])=>workspace.items.some(i=>i.id === Number(id))).map(([id,keys])=>[id,keys.filter(key=>workspace.members.some(m=>(m.uniqueName || m.id || m.displayName || '').toLowerCase() === key))]));
            workspace.participantExclusions = Object.fromEntries(Object.entries(store.data.azure?.participantExclusions || {}).filter(([id])=>workspace.items.some(i=>i.id === Number(id))).map(([id,keys])=>[id,keys.filter(key=>workspace.members.some(m=>(m.uniqueName || m.id || m.displayName || '').toLowerCase() === key))]));
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
          if (input.mode === 'demo' && !data.demo) data.demo = createDemo();
          await store.save(data); planner.review = null;
        } else if (path === '/api/create') {
          const data=structuredClone(store.data);createLocalItem(data[data.mode],input);await store.save(data);planner.review=null;
        } else if (path === '/api/confirm-person') {
          const data=structuredClone(store.data);
          confirmPerson(data[data.mode],input.member,input.iterationId);
          await store.save(data);planner.review=null;
        } else if (path === '/api/task-selection' || path === '/api/participation') {
          const data=structuredClone(store.data),workspace=data[data.mode];
          if(path==='/api/task-selection') selectTasks(workspace,input.member,input.ids,input.iterationId,input.selected);
          else toggleParticipation(workspace,input.id,input.member,input.selected,input.iterationId);
          await store.save(data);planner.review=null;
        } else if (path === '/api/plan-tasks') {
          const undo=await planner.planBatch(input.member,input.ids,input.iterationId);
          return json(res,{state:publicState(),undo});
        } else if (path === '/api/undo-plan') {
          await planner.undoPlan(input.token);
        } else if (path === '/api/participants') {
          const data = structuredClone(store.data), workspace = data[data.mode];
          setParticipants(workspace, input.assignments, input.iterationId);
          await store.save(data); planner.review = null;
        } else if (path === '/api/complete-task' || path === '/api/completed-state') {
          const data = structuredClone(store.data), workspace = data[data.mode];
          if (path === '/api/complete-task') completeTask(workspace, input.id);
          else setCompletedState(workspace, input.type, input.state, input.sourceId);
          await store.save(data); planner.review = null;
        } else if (path === '/api/stage') {
          const data = structuredClone(store.data), workspace = data[data.mode];
          if (!workspace) throw fail('Importa datos primero.');
          if (!Array.isArray(input.edits) || !input.edits.length || input.edits.length > 200) throw fail('Cambios no válidos.');
          for (const edit of input.edits) stageChanges(workspace, edit.id, edit.changes);
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
        } else if (path === '/api/resolve-capacity') {
          const data = structuredClone(store.data);
          if (input.sourceId && data[data.mode].sources) {
            const source=data[data.mode].sources.find(s=>s.id===input.sourceId);
            const plan=planner.review?.capacityPlans.find(p=>p.sourceId===input.sourceId && p.iterationId===input.iterationId && p.key===input.key && p.conflict);
            if (!source || !plan || input.choice!=='local') throw fail('Vuelve a revisar el reparto de capacidad.');
            const record=source.capacities?.[plan.remoteIterationId]?.teamMembers?.find(m=>m.teamMember.id===input.key);
            if(record) Object.assign(record,plan.remote);
            else { source.capacities[plan.remoteIterationId] ??= {teamMembers:[],daysOff:[]}; source.capacities[plan.remoteIterationId].teamMembers.push({teamMember:source.members.find(m=>m.id===input.key),...plan.remote}); }
          } else resolveCapacityConflict(data[data.mode], input.iterationId, input.key, input.choice);
          await store.save(data); planner.review = null;
        } else if (path === '/api/discard') {
          const data = structuredClone(store.data), workspace = data[data.mode];
          if (!workspace) throw fail('No hay planificación.');
          discardLocal(workspace,input.id);
          await store.save(data); planner.review = null;
        } else if (path === '/api/resolve') {
          const data = structuredClone(store.data);
          resolveConflict(data[data.mode], input.id, input.choice);
          await store.save(data); planner.review = null;
        } else if (path === '/api/review') return json(res, { review: await planner.prepareReview(), state: publicState() });
        else if (path === '/api/sync') return json(res, { result: await planner.sync(input.token), state: publicState() });
        else throw fail('Operación no encontrada.', 404);
        operation = { ...operation, step: 'Preparando la planificación para la interfaz' };
        return json(res, publicState());
      } catch (error) {
        explain(error);
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
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!['index.html', 'app.js', 'hierarchy.js', 'permissions.js', 'maintenance.js', 'style.css', 'favicon.svg'].includes(file)) throw fail('No encontrado.', 404);
    res.setHeader('Content-Type', types[file.split('.').at(-1)]);
    res.end(await readFile(root + file));
  } catch (error) { json(res, { error: error.message || 'No se pudo completar la operación.', ...(error.stateReview ? { stateReview: error.stateReview } : {}), ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}) }, error.status || 400); }
});
server.listen(port, '127.0.0.1', () => console.log(`Neo Team: http://127.0.0.1:${port}`));
// A crash would otherwise only leave a lost connection in the interface.
for (const kind of ['uncaughtException', 'unhandledRejection']) process.on(kind, async error => { await saveDiagnostics(kind, error); process.exit(1); });
async function shutdown() { server.close(); await azure.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
