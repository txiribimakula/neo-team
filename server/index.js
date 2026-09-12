import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { LocalStore } from './store.js';
import { AzureGateway } from './azure.js';
import { Planner, createLocalItem, discardLocal, stageChanges, resolveConflict, planningWorkspace, confirmPerson, setParticipants, selectTasks, toggleParticipation, stageCapacity, discardCapacity, resolveCapacityConflict, capacityChanges } from './planner.js';
import { createDemo } from './demo.js';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.NEO_TEAM_PORT || 4310);
const types = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml' };
const store = new LocalStore(resolve(process.env.NEO_TEAM_DATA_DIR || fileURLToPath(new URL('../.neo-team/', import.meta.url))));
await store.load();
const azure = new AzureGateway(), planner = new Planner(store, azure);
const csrf = randomBytes(32).toString('hex');
let busy = false;
let importProgress = null;
let operation = null;
let stateReview = null;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
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
  return { csrf, version: store.data.version, config: store.data.config, mode: store.data.mode, hasAzure: !!store.data.azure, busy, operation: busy ? operation : null, stateReview,
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
      const labels = { '/api/import': 'Importando equipo', '/api/projects': 'Buscando proyectos', '/api/teams': 'Buscando equipos', '/api/review': 'Revisando cambios', '/api/sync': 'Sincronizando cambios' };
      operation = { id: randomBytes(16).toString('hex'), path, status: 'running', title: labels[path] || 'Guardando cambios locales', phase: 'connection', message: 'Preparando la operación…', counts: {}, startedAt: Date.now(), updatedAt: Date.now(), cancellable: ['/api/import', '/api/projects', '/api/teams'].includes(path) };
      try {
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
        } else if (path === '/api/config') {
          const config = configFrom(input.config);
          const data = structuredClone(store.data);
          if (scope(data.config) !== scope(config)) {
            if (pendingChanges(data.azure)) throw fail('Hay cambios pendientes en el equipo anterior. Sincronízalos o descártalos antes de cambiar de equipo.');
            data.azure = null;
            stateReview = null;
          }
          data.config = config;
          if (data.azure) data.azure.config = config;
          await store.save(data); planner.review = null;
        } else if (path === '/api/import') {
          if (!store.data.config) throw fail('Configura Azure DevOps primero.');
          if (pendingChanges(store.data.azure)) throw fail('Sincroniza o descarta los cambios pendientes antes de volver a importar.');
          const id = typeof input.importId === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(input.importId) ? input.importId : randomBytes(16).toString('hex');
          operation = { ...operation, id, message: 'Iniciando importación…' };
          stateReview = null;
          importProgress = operation;
          try {
            const workspace = await azure.import(store.data.config, progress => {
              if (operation.cancelRequested) throw fail('Importación cancelada.');
              operation = { ...operation, ...progress, updatedAt: Date.now(), cancellable: progress.phase !== 'saving' };
              importProgress = operation;
            }, store.data.stateRules || []);
            if (operation.cancelRequested) throw fail('Importación cancelada.');
            operation = { ...operation, cancellable: false, phase: 'saving', message: 'Guardando la copia local…', updatedAt: Date.now() };
            workspace.confirmations = structuredClone(store.data.azure?.confirmations || {});
            workspace.participants = Object.fromEntries(Object.entries(store.data.azure?.participants || {}).filter(([id])=>workspace.items.some(i=>i.id === Number(id))).map(([id,keys])=>[id,keys.filter(key=>workspace.members.some(m=>(m.uniqueName || m.id || m.displayName || '').toLowerCase() === key))]));
            workspace.participantExclusions = Object.fromEntries(Object.entries(store.data.azure?.participantExclusions || {}).filter(([id])=>workspace.items.some(i=>i.id === Number(id))).map(([id,keys])=>[id,keys.filter(key=>workspace.members.some(m=>(m.uniqueName || m.id || m.displayName || '').toLowerCase() === key))]));
            const data = structuredClone(store.data); data.azure = workspace; data.mode = 'azure';
            await store.save(data); planner.review = null;
            operation = { ...operation, status: 'complete', phase: 'complete', message: 'Importación completada. Copia local guardada.' };
            importProgress = operation;
          } catch (error) {
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
          setParticipants(workspace, input.assignments);
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
          resolveCapacityConflict(data[data.mode], input.iterationId, input.key, input.choice);
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
        return json(res, publicState());
      } catch (error) {
        operation = { ...operation, status: operation.cancelRequested ? 'cancelled' : 'failed', error: operation.cancelRequested ? 'Consulta cancelada.' : error.message };
        if (operation.cancelRequested) throw fail('Consulta cancelada.');
        throw error;
      } finally {
        busy = false;
        operation = { ...operation, status: operation.status === 'running' ? (operation.cancelRequested ? 'cancelled' : 'complete') : operation.status, cancellable: false, updatedAt: Date.now() };
        if (path === '/api/import') importProgress = operation;
      }
    }
    if (req.method !== 'GET') throw fail('Método no permitido.', 405);
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!['index.html', 'app.js', 'hierarchy.js', 'style.css', 'favicon.svg'].includes(file)) throw fail('No encontrado.', 404);
    res.setHeader('Content-Type', types[file.split('.').at(-1)]);
    res.end(await readFile(root + file));
  } catch (error) { json(res, { error: error.message || 'No se pudo completar la operación.', ...(error.stateReview ? { stateReview: error.stateReview } : {}) }, error.status || 400); }
});
server.listen(port, '127.0.0.1', () => console.log(`Neo Team: http://127.0.0.1:${port}`));
async function shutdown() { server.close(); await azure.close(); process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
