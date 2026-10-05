import { IMPORT_FIELDS, importWiql, stateAction, isImportType } from './import-query.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { normalizeItem, descriptionHtml } from './planner.js';
import { isExecutable } from '../dist/hierarchy.js';
import { activityReader, describeCall, seconds } from './activity.js';
import { MAINTENANCE_FIELDS, MAINTENANCE_LIMIT, maintenanceIssue, maintenanceWiql } from './maintenance.js';
import { MY_ITERATION_FIELDS, MY_ITERATION_LIMIT, boardItem, currentIteration, myIterationBoard, myIterationWiql, parentsWiql } from './my-iteration.js';

export function parseToolResult(result) {
  const blocks = (result.content ?? []).filter(b => b.type === 'text').map(b => {
    let text = b.text.trim();
    // Microsoft wraps JSON in randomized untrusted-content delimiters.
    const match = text.match(/^<<([a-f0-9]{32})>>[^\n]*\n([\s\S]*)\n<<\/\1>>$/);
    if (match) text = match[2];
    return text;
  });
  if (result.isError) throw new Error(blocks.join('\n').slice(0,1500) || 'Azure DevOps devolvió un error');
  if (result.structuredContent) return result.structuredContent;
  for (const block of blocks) { try { return JSON.parse(block); } catch { /* try next text block */ } }
  throw new Error('El MCP no devolvió datos JSON válidos. No se ha modificado la planificación.');
}

function normalizeIteration(iteration, project, label) {
  if (!iteration || typeof iteration.path !== 'string') {
    throw new Error(`Azure DevOps no devolvió una ruta válida para ${label}. Revisa las iteraciones en la configuración del equipo.`);
  }
  // Team settings can return the project root as "" and descendants as
  // "\\Release\\Sprint". Work item fields require the project-qualified path.
  const path = iteration.path === '' ? project : iteration.path.startsWith('\\') ? project + iteration.path : iteration.path;
  return { ...iteration, path };
}

function isPastIteration(iteration, today) {
  const { timeFrame, finishDate } = iteration?.attributes || {};
  if (timeFrame === 0 || String(timeFrame).toLowerCase() === 'past') return true;
  if ([1, 2, 'current', 'future'].includes(typeof timeFrame === 'string' ? timeFrame.toLowerCase() : timeFrame)) return false;
  // Dates in Azure iteration metadata are calendar dates, with an inclusive end.
  // Keep undated iterations: they cannot reliably be classified as historical.
  const finish = typeof finishDate === 'string' ? finishDate.slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(finish) && Number.isFinite(Date.parse(finish)) && finish < today;
}

// Workflow states with a normalized category, such as 'inprogress' or 'completed'.
function workflowStates(states) {
  const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  return states.filter(s => s && normalize(s.name)).map(s => ({ name: s.name, category: normalize(s.category || s.stateCategory).replace(/\s/g, '') }));
}

const REVISION_CHANGED = /TF401289|\b(409|412)\b|Precondition Failed|test operation|\/rev\b/i;
// Writes that would be duplicated if repeated after an uncertain answer. They are
// never retried here: their callers look for the result before sending again.
const NOT_REPEATABLE = new Set(['neo_create_item', 'neo_pull_request_comment_write', 'wit_work_item_comment_write']);
const isTransient = error => [-32001, -32000].includes(error?.code) || /Connection closed|Conecta Azure DevOps|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|socket hang up|timed out|\b(408|429|500|502|503|504)\b/i.test(String(error?.message ?? ''));

export class AzureGateway {
  async open(config) {
    this.lastConfig = config;
    const key =JSON.stringify([config.organization, config.authentication, config.tenant || '']);
    if (this.key === key && this.client) return;
    await this.close();
    const client = new Client({ name: 'neo-team', version: '0.1.0' });
    this.openingClient = client;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-server.js', import.meta.url)), config.organization, config.authentication, config.tenant || ''],
      stderr: 'pipe',
    });
    // Drain logs; only the MCP's own activity lines are read, never raw auth logs.
    transport.stderr?.on('data', activityReader(entry => this.report(entry.kind, entry.message)));
    this.report('mcp', 'Iniciando el proceso MCP local de Azure DevOps…');
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      // Every tool used by imports, reviews and writes, so a missing one is reported
      // on connecting rather than in the middle of a synchronization.
      for (const name of ['work', 'wit_backlog', 'wit_work_item', 'wit_work_item_write', 'wit_query', 'neo_create_item', 'neo_team_members', 'neo_team_days_off', 'neo_team_capacity_write', 'neo_team_days_off_write', 'neo_work_item_states', 'neo_security_read', 'neo_security_login', 'neo_query_work_items', 'neo_work_item_types', 'neo_work_items_batch', 'neo_work_item_texts', 'neo_git_repositories', 'neo_pull_requests', 'neo_pull_request', 'neo_pull_request_threads', 'neo_pull_request_comment_write']) {
        if (!tools.some(t => t.name === name)) throw new Error(`El MCP no ofrece ${name}`);
      }
      if (this.openingClient !== client) throw new Error('Conexión cancelada.');
      this.openingClient = null;
      this.client = client; this.key = key;
      this.report('mcp', `Proceso MCP listo · ${tools.length} herramientas disponibles.`);
      client.onclose = () => { if (this.client === client) { this.client = null; this.key = null; } };
    } catch (error) { if (this.openingClient === client) this.openingClient = null; await client.close().catch(() => {}); throw error; }
  }
  async close() {
    this.generation = (this.generation ?? 0) + 1;
    const clients = [this.client, this.openingClient].filter(Boolean);
    this.client = null; this.openingClient = null; this.key = null;
    await Promise.all(clients.map(client => client.close().catch(() => {})));
  }
  // Activity listeners see each step, with the call still waiting (if any).
  report(kind, message) {
    if (kind === 'auth' && this.pendingCall) this.pendingCall.waitedForAuth = true;
    this.onActivity?.({ at: Date.now(), kind, message, pending: this.pendingCall ?? null });
  }
  // Transient failures (timeouts, a closed MCP process, throttling or server errors)
  // are retried after reconnecting. Creations and comments are never replayed here:
  // their callers recover them by a marker to avoid duplicates. A cancellation stops retries.
  async call(name, args) {
    const timeout = /_write$|^neo_create_item$/.test(name) ? 600000 : 180000;
    let generation = this.generation;
    for (let attempt = 1; ; attempt++) {
      try { return await this.callOnce(name, args, timeout); }
      catch (error) {
        if (attempt >= 3 || NOT_REPEATABLE.has(name) || !this.lastConfig || this.generation !== generation || !isTransient(error)) throw error;
        this.report('info', `Reintentando ${describeCall(name, args)} (intento ${attempt + 1} de 3)…`);
        await new Promise(resolve => setTimeout(resolve, attempt * (this.retryDelay ?? 2000)));
        if (this.generation !== generation) throw error;
        if (!this.client) { await this.open(this.lastConfig); generation = this.generation; }
      }
    }
  }
  async callOnce(name, args, timeout) {
    if (!this.client) throw new Error('Conecta Azure DevOps para continuar.');
    const label = describeCall(name, args), startedAt = Date.now();
    this.pendingCall = { label, startedAt };
    this.report('call', `Esperando respuesta: ${label}`);
    try {
      const result = parseToolResult(await this.client.callTool({ name, arguments: args }, undefined, { timeout }));
      if (name === 'neo_security_read' && result?.securityError) throw Object.assign(new Error(result.securityError.message), { code: result.securityError.code, diagnostics: result.securityError.diagnostics });
      this.pendingCall = null;
      this.report('call', `${label} respondió en ${seconds(Date.now() - startedAt)}.`);
      return result;
    } catch (error) {
      const waitedForAuth = !!this.pendingCall?.waitedForAuth;
      this.pendingCall = null;
      this.report('error', `${label} falló tras ${seconds(Date.now() - startedAt)}: ${String(error?.message ?? error).slice(0, 500)}`);
      // MCP RequestTimeout: say which call did not answer, and whether a write may have been applied.
      if (error?.code === -32001) {
        const write = /_write$|^neo_create_item$/.test(name);
        throw Object.assign(new Error(`Azure DevOps no respondió en ${seconds(Date.now() - startedAt)} a ${label}.${waitedForAuth ? ' Estaba esperando el inicio de sesión de Microsoft: complétalo y vuelve a intentarlo.' : ''}${write ? ' Puede que el cambio se aplicara: vuelve a revisar los cambios; lo que ya esté aplicado no se reenvía.' : ''}`), { code: error.code, cause: error });
      }
      throw error;
    }
  }
  async projects() {
    const result = [];
    for (let skip = 0; ; skip += 100) {
      const page = await this.call('core_list_projects', { top: 100, skip });
      if (!Array.isArray(page)) throw new Error('Respuesta de proyectos no válida');
      result.push(...page.map(p => ({ id: p.id, name: p.name })));
      if (page.length < 100) return result;
    }
  }
  async teams(project) {
    const result = [];
    for (let skip = 0; ; skip += 100) {
      const page = await this.call('core_list_project_teams', { project, top: 100, skip });
      if (!Array.isArray(page)) throw new Error('Respuesta de equipos no válida');
      result.push(...page.map(t => ({ id: t.id, name: t.name })));
      if (page.length < 100) return result;
    }
  }
  async getItems(config, ids) {
    const result = [];
    for (let offset=0;offset<ids.length;offset+=200) {
      const batch=await this.call('neo_work_items_batch',{project:config.project,ids:ids.slice(offset,offset+200)});
      if(!Array.isArray(batch)) throw new Error('No se pudieron leer las tareas.');
      // Deleted or inaccessible items are omitted: each one is reported on its own.
      result.push(...batch.filter(Boolean).map(normalizeItem));
    }
    return result;
  }
  // Maintenance: every item of the chosen type whose state is not one of the
  // closed states, in a single MCP call (WIQL plus parallel batched fields).
  async functionalIssues(config, settings, onProgress = () => {}) {
    onProgress({ message: `Consultando los «${settings.type}» no cerrados del proyecto ${config.project}…` });
    const result = await this.call('neo_query_work_items', { project: config.project, wiql: maintenanceWiql(settings), fields: MAINTENANCE_FIELDS, top: MAINTENANCE_LIMIT });
    if (!Array.isArray(result?.workItems)) throw new Error('Azure DevOps no devolvió una lista válida de elementos.');
    const order = new Map((result.ids ?? []).map((id, index) => [id, index]));
    const issues = result.workItems.map(raw => maintenanceIssue(raw, settings.states)).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    onProgress({ message: `${issues.length} elementos obtenidos.`, counts: { issuesFound: issues.length, issuesRead: issues.length } });
    return { type: settings.type, closedStates: settings.closedStates, fetchedAt: new Date().toISOString(), limited: !!result.limited, demo: false, organization: config.organization, project: config.project, issues };
  }
  // My iteration: what the signed-in account has assigned in the team's current
  // iteration, with the parents as rows and the task states as columns.
  async myIteration(config, onProgress = () => {}) {
    onProgress({ message: `Buscando la iteración actual de ${config.team}…` });
    const rawIterations = await this.call('work', { action: 'list_team_iterations', project: config.project, team: config.team });
    if (!Array.isArray(rawIterations)) throw new Error('Azure DevOps no devolvió una lista válida de iteraciones del equipo.');
    const found = currentIteration(rawIterations), board = { organization: config.organization, project: config.project, team: config.team, iteration: null, me: '', columns: [], lanes: [], limited: false };
    if (!found) return board;
    const iteration = normalizeIteration(found, config.project, 'la iteración actual');
    board.iteration = { name: iteration.name, path: iteration.path, startDate: iteration.attributes?.startDate ?? null, finishDate: iteration.attributes?.finishDate ?? null };
    onProgress({ message: `Consultando tus elementos en «${iteration.name}»…` });
    const result = await this.call('neo_query_work_items', { project: config.project, wiql: myIterationWiql(iteration.path), fields: MY_ITERATION_FIELDS, top: MY_ITERATION_LIMIT });
    if (!Array.isArray(result?.workItems)) throw new Error('Azure DevOps no devolvió una lista válida de elementos.');
    const mine = result.workItems.map(boardItem), known = new Set(mine.map(i => i.id));
    const missing = [...new Set(mine.map(i => i.parent).filter(id => id && !known.has(id)))], parents = [];
    for (let offset = 0; offset < missing.length; offset += 200) {
      onProgress({ message: 'Leyendo los elementos padre…' });
      const page = await this.call('neo_query_work_items', { project: config.project, wiql: parentsWiql(missing.slice(offset, offset + 200)), fields: MY_ITERATION_FIELDS, top: 200 });
      parents.push(...(page?.workItems ?? []).map(boardItem));
    }
    const states = {};
    for (const type of new Set(['Task', ...mine.map(i => i.type).filter(Boolean)])) {
      onProgress({ message: `Consultando los estados de «${type}»…` });
      try { states[type] = await this.workItemStates(config, type); }
      catch (error) { if (mine.some(i => i.type === type)) throw error; }
    }
    return { ...board, me: mine.find(i => i.assignedTo)?.assignedTo ?? '', limited: !!result.limited, ...myIterationBoard(mine, parents, states) };
  }
  async workItemStates(config, type) {
    const states = await this.call('neo_work_item_states', { project: config.project, type });
    if (!Array.isArray(states)) throw new Error(`No se pudieron consultar los estados de «${type}».`);
    return workflowStates(states);
  }
  async capacity(config, iterationId) {
    const context = { project: config.project, team: config.team };
    let capacity;
    // The official tool answers with an error when nobody has capacity in the iteration.
    try { capacity = await this.call('work', { action: 'get_team_capacity', ...context, iterationId }); }
    catch (error) { if (!/No team capacity assigned/i.test(String(error?.message))) throw error; capacity = { teamMembers: [] }; }
    const daysOff = await this.call('neo_team_days_off', { ...context, iterationId });
    if (!daysOff || typeof daysOff !== 'object') throw new Error(`Azure DevOps no devolvió los días libres de la iteración ${iterationId} (equipo «${config.team}»).`);
    return { ...capacity, daysOff: daysOff.daysOff ?? [] };
  }
  async updateMemberCapacity(config, iterationId, teamMemberId, activities, daysOff) {
    const raw = await this.call('neo_team_capacity_write', { project: config.project, team: config.team, iterationId, teamMemberId, activities, daysOff });
    return { activities: raw.activities ?? [], daysOff: raw.daysOff ?? [] };
  }
  async updateTeamDaysOff(config, iterationId, daysOff) {
    const raw = await this.call('neo_team_days_off_write', { project: config.project, team: config.team, iterationId, daysOff });
    return { activities: [], daysOff: raw.daysOff ?? [] };
  }
  async import(config, onProgress = () => {}, stateRules = [], options = {}) {
    let counts = {};
    const report = (phase, message, updates = {}) => {
      counts = { ...counts, ...updates };
      onProgress({ phase, message, counts: { ...counts } });
    };
    report('connection', 'Conectando con Azure DevOps. Completa el acceso de Microsoft si se solicita.');
    await this.open(config);
    const context = { project: config.project, team: config.team };
    const snapshot=options.snapshot, section=options.section;
    if(section==='capacity') {
      const capacities={};
      for(const iteration of snapshot.iterations.filter(i=>!i.past)) {
        report('capacity',`Actualizando capacidad de «${iteration.name}»…`);
        try {capacities[iteration.id]=await this.capacity(config,iteration.id);}
        catch(error) {error.message=`Capacidad de «${iteration.name}» en ${config.project}: ${error.message}`;throw error;}
      }
      return {...snapshot,capacities};
    }
    // Downloading tasks asks Azure with the team's current settings and iterations,
    // so work in a sprint or area added after the import is not left out.
    const live = !snapshot || section==='tasks';
    if(live) report('settings', 'Leyendo la configuración del equipo…');
    const rawSettings = live ? await this.call('work', { action: 'get_team_settings', ...context }) : snapshot.settings;
    const settings = { ...rawSettings, backlogIteration: normalizeIteration(rawSettings?.backlogIteration, config.project, 'el backlog') };
    if (typeof settings.defaultIteration?.path === 'string') settings.defaultIteration = normalizeIteration(settings.defaultIteration, config.project, 'la iteración predeterminada');
    if(section!=='tasks') report('iterations', 'Consultando las iteraciones del equipo…', { settings: 1 });
    const rawIterations = await this.call('work', { action: 'list_team_iterations', ...context });
    if (!Array.isArray(rawIterations)) throw new Error('Azure DevOps no devolvió una lista válida de iteraciones del equipo.');
    const today = new Date().toISOString().slice(0, 10);
    const pastPaths=rawIterations.filter(i=>isPastIteration(i,today)).map(i=>normalizeIteration(i,config.project,'una iteración anterior').path);
    const iterations=rawIterations.filter(i=>!isPastIteration(i,today)).map(i=>normalizeIteration(i,config.project,'una iteración del equipo'));
    if(section==='iterations') return {...snapshot,iterations};
    const added=section==='tasks' ? iterations.filter(i=>!snapshot.iterations.some(known=>known.id===i.id)) : [];
    const querySettings={...settings,importIterationPaths:iterations.map(i=>i.path)};
    if(!snapshot) report('members', 'Obteniendo los integrantes del equipo…', { iterations: iterations.length, iterationsExcluded: rawIterations.length - iterations.length });
    const members = snapshot ? snapshot.members : await this.call('neo_team_members', context);
    if (!Array.isArray(members)) throw new Error('Azure DevOps no devolvió una lista válida de integrantes del equipo.');
    if(!snapshot?.backlogLevels) report('backlogs', 'Consultando los niveles de backlog…', { members: members.length });
    const levels = snapshot?.backlogLevels ?? await this.call('wit_backlog', { action: 'list', ...context });
    if (!Array.isArray(levels)) throw new Error('Azure DevOps no devolvió una lista válida de niveles de backlog del equipo.');
    report('states','Comprobando los estados antes de descargar tareas…');
    const catalog=await this.call('neo_work_item_types',{project:config.project});
    if(!Array.isArray(catalog)) throw new Error('Azure no devolvió los tipos del proyecto.');
    const relevant=new Set(['Task','Bug',...levels.flatMap(l=>(l.workItemTypes ?? []).map(t=>typeof t==='string' ? t : t.name))]);
    if(relevant.size===2) for(const type of ['Epic','Feature','User Story','Product Backlog Item','Requirement','Issue']) relevant.add(type);
    const types=catalog.filter(t=>relevant.has(t.name)), workflows=[], completedStates={}, workItemStates={};
    const fieldName=(type,ref)=>type.fields.find(f=>f.referenceName===ref)?.name ?? null;
    const estimateFields=Object.fromEntries(types.filter(t=>Array.isArray(t.fields)).map(t=>[t.name,{originalEstimate:fieldName(t,'Microsoft.VSTS.Scheduling.OriginalEstimate'),remainingWork:fieldName(t,'Microsoft.VSTS.Scheduling.RemainingWork')}]));
    // Classification is complete before the large queries run. Unknown custom
    // states request a decision, with one example item rather than the backlog.
    for(const {name:type} of types) {
      report('states',`Comprobando estados de «${type}»…`);
      const states=await this.workItemStates(config,type), open=[];
      if(!states.length) throw new Error(`No se pudieron clasificar los estados de «${type}». Azure no devolvió su flujo de trabajo.`);
      for(const state of states) {
        const action=isImportType(type) ? stateAction(config,type,state,stateRules) : 'include';
        if(action==='include') open.push(state.name);
        else if(!action) {
          const sample=await this.call('neo_query_work_items',{project:config.project,wiql:importWiql(config,querySettings,pastPaths,type,[state.name]),fields:IMPORT_FIELDS,top:1});
          if(sample.workItems?.length) throw Object.assign(new Error(`Indica si «${state.name}» de «${type}» sigue abierto.`),{stateReview:{organization:config.organization,project:config.project,type,state:state.name,states,item:sample.workItems[0]}});
        }
      }
      workItemStates[type]=states;
      const completed=states.find(s=>s.category==='completed');
      if(completed) completedStates[type]=completed.name;
      workflows.push({type,open,states:states.map(s=>s.name)});
    }
    const items=[], warnings=[], capacities={};
    const query=async(type,open,ids=null)=>{
      if(!open.length) return [];
      let after=0;const found=[];
      for(;;) {
        const result=await this.call('neo_query_work_items',{project:config.project,wiql:importWiql(config,querySettings,pastPaths,type,open,after,ids),fields:IMPORT_FIELDS,top:5000});
        if(!Array.isArray(result.workItems)) throw new Error('Azure no devolvió una lista válida de elementos.');
        found.push(...result.workItems.filter(raw=>open.some(state=>state.trim().toLowerCase()===String(raw.fields?.['System.State'] ?? '').trim().toLowerCase())).map(normalizeItem));
        report('items',`«${type}»: ${found.length} elementos leídos por lotes.`,{read:items.length+found.length});
        if(!result.limited) return found;
        const next=Math.max(...result.workItems.map(i=>i.id));
        if(!(next>after)) throw new Error('La consulta paginada no avanza. No se guardará una importación incompleta.');
        after=next;
      }
    };
    for(const {type,open} of workflows.filter(w=>isImportType(w.type))) items.push(...await query(type,open));
    const included=new Set(items.map(i=>i.id)),attempted=new Set();
    for(;;) {
      const parents=[...new Set(items.map(i=>i.parent).filter(id=>id && !included.has(id) && !attempted.has(id)))];
      if(!parents.length) break;
      parents.forEach(id=>attempted.add(id));
      report('parents','Completando la jerarquía de las tareas…');
      for(let offset=0;offset<parents.length;offset+=200) for(const {type,states} of workflows) {
        const found=await query(type,states,parents.slice(offset,offset+200));
        for(const item of found) if(!included.has(item.id)) {items.push({...item,contextOnly:true});included.add(item.id);}
      }
    }
    for(const iteration of section==='tasks' ? [] : iterations) {
      report('capacity',`Consultando capacidad de «${iteration.name}»…`,{imported:items.length});
      try {capacities[iteration.id]=await this.capacity(config,iteration.id);}
      catch(error) {warnings.push(`No se pudo consultar la capacidad de «${iteration.name}» en ${config.project}: ${String(error?.message ?? error).slice(0,500)}`);}
      report('capacity',`Capacidad consultada: «${iteration.name}».`,{capacities:Object.keys(capacities).length});
    }
    if(added.length) warnings.push(`${config.project}: el equipo tiene iteraciones nuevas en Azure DevOps (${added.map(i=>i.name).join(', ')}). Sus tareas ya se han descargado; actualiza las iteraciones para planificarlas.`);
    report('saving', 'Guardando la copia local…', { imported: items.length, warnings: warnings.length });
    return { mode: 'azure', config, importedAt: new Date().toISOString(), settings, iterations, members, capacities:section==='tasks' ? snapshot.capacities : capacities, backlogLevels:levels, items, completedStates, workItemStates, estimateFields, warnings, drafts: {}, conflicts: {}, participants: {} };
  }
  // Pull request review: repositories, pull requests and their changes are read
  // through the local MCP; comments are only added after the person confirms them.
  async repositories(config) {
    const result = await this.call('neo_git_repositories', { project: config.project });
    if (!Array.isArray(result)) throw new Error('Azure DevOps no devolvió una lista válida de repositorios.');
    return result;
  }
  async pullRequests(config, repository) {
    const result = await this.call('neo_pull_requests', { project: config.project, repository, top: 100 });
    if (!Array.isArray(result)) throw new Error('Azure DevOps no devolvió una lista válida de pull requests.');
    return result;
  }
  async pullRequest(config, repository, pullRequestId, { includeFiles = false, includeThreads = includeFiles, maxFiles = 300, maxFileBytes = 5000000, maxTotalBytes = 50000000 } = {}) {
    const result = await this.call('neo_pull_request', { project: config.project, repository, pullRequestId, includeFiles, includeThreads, maxFiles, maxFileBytes, maxTotalBytes });
    if (!result?.pullRequest || !Array.isArray(result.files)) throw new Error('Azure DevOps no devolvió un pull request válido.');
    return result;
  }
  async pullRequestThreads(config, repositoryId, pullRequestId) {
    const result = await this.call('neo_pull_request_threads', { project: config.project, repositoryId, pullRequestId });
    if (!Array.isArray(result)) throw new Error('Azure DevOps no devolvió los comentarios del pull request.');
    return result;
  }
  async addPullRequestComment(config, { repositoryId, pullRequestId, content, filePath, line }) {
    const result = await this.call('neo_pull_request_comment_write', { project: config.project, repositoryId, pullRequestId, content, ...(filePath ? { filePath } : {}), ...(filePath && line ? { line } : {}) });
    if (!Number.isInteger(result?.id)) throw new Error('Azure DevOps no confirmó el comentario.');
    return result;
  }
  // Finds a creation whose response was lost, by what it contains: same type and
  // title, created by this account since the day it was sent, with the same parent
  // and not already in the plan. Several matches are left for the person to check.
  async findCreation(config, item, sentAt, knownIds = new Set()) {
    const quote = value => `'${String(value).replace(/'/g, "''")}'`;
    const since = new Date(new Date(sentAt).getTime() - 86400000).toISOString().slice(0, 10);
    const result=await this.call('wit_query',{action:'wiql',project:config.project,top:20,wiql:`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.WorkItemType] = ${quote(item.type)} AND [System.Title] = ${quote(item.title)} AND [System.CreatedBy] = @Me AND [System.CreatedDate] >= ${quote(since)}`});
    if(!Array.isArray(result.workItems)) throw new Error('No se pudo comprobar si la creación ya existe.');
    const ids=result.workItems.map(w=>w.id).filter(id=>!knownIds.has(id));
    const found=(ids.length ? await this.getItems(config,ids) : []).filter(candidate=>(candidate.parent ?? null)===(item.parent ?? null));
    if(found.length>1) throw new Error(`Hay ${found.length} elementos en Azure DevOps que coinciden con esta creación («${item.title}»). Comprueba cuál es y descarta la creación local si ya existe.`);
    return found[0] ?? null;
  }
  async create(config,item,validateOnly=false) {
    const fields={'System.Title':item.title,'System.AreaPath':item.areaPath,'System.IterationPath':item.iterationPath,'Microsoft.VSTS.Common.Priority':item.priority};
    if(item.tags?.length) fields['System.Tags']=item.tags.join('; ');
    if(item.assignedTo) fields['System.AssignedTo']=item.assignedTo;
    if(item.remainingWork!==null) fields['Microsoft.VSTS.Scheduling.RemainingWork']=item.remainingWork;
    if(item.originalEstimate!=null) fields['Microsoft.VSTS.Scheduling.OriginalEstimate']=item.originalEstimate;
    Object.assign(fields,item.texts);
    // What the person wrote in the review replaces the copied text of that field.
    if(item.description) fields[item.descriptionField ?? 'System.Description']=descriptionHtml(item.description);
    const raw=await this.call('neo_create_item',{project:config.project,type:item.type,fields,parent:item.parent,validateOnly});
    return validateOnly ? raw : normalizeItem(raw);
  }
  // Description fields of an item (only those with content), copied to its duplicate.
  async itemTexts(config, id) {
    const result = await this.call('neo_work_item_texts', { project: config.project, id });
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.values(result).some(value => typeof value !== 'string')) throw new Error(`No se pudo leer la descripción de #${id}.`);
    return result;
  }
  async addComment(config, id, text) {
    return this.call('wit_work_item_comment_write', { action: 'add', project: config.project, workItemId: id, text, format: 'Markdown' });
  }
  async update(config, id, revision, fields) {
    const fieldNames = { title:'System.Title', assignedTo: 'System.AssignedTo', iterationPath: 'System.IterationPath', priority: 'Microsoft.VSTS.Common.Priority', remainingWork: 'Microsoft.VSTS.Scheduling.RemainingWork', originalEstimate: 'Microsoft.VSTS.Scheduling.OriginalEstimate', state: 'System.State' };
    const guarded = revision !== null && revision !== undefined;
    try {
      return normalizeItem(await this.call('wit_work_item_write', {
        action: 'update', project: config.project, id,
        // Without a revision the local value overwrites whatever Azure has.
        updates: [...(guarded ? [{ op: 'test', path: '/rev', value: revision }] : []), ...Object.entries(fields).map(([key, value]) => ({ op: 'add', path: `/fields/${fieldNames[key]}`, value }))],
      }));
    } catch (error) {
      // Azure rejects the whole update when the revision differs: nothing was written.
      if (guarded && REVISION_CHANGED.test(String(error?.message))) throw Object.assign(new Error(`#${id} ha cambiado en Azure DevOps y no se pudo comparar durante la revisión. No se ha modificado: vuelve a revisar los cambios.`), { cause: error });
      throw error;
    }
  }
}
