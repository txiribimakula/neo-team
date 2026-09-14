import { IMPORT_FIELDS, importWiql, stateAction } from './import-query.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { normalizeItem } from './planner.js';
import { isExecutable } from '../dist/hierarchy.js';
import { activityReader, describeCall, seconds } from './activity.js';
import { MAINTENANCE_FIELDS, MAINTENANCE_LIMIT, maintenanceIssue, maintenanceWiql } from './maintenance.js';

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
      for (const name of ['work', 'wit_backlog', 'wit_work_item', 'wit_work_item_write', 'neo_team_members', 'neo_team_days_off', 'neo_team_capacity_write', 'neo_team_days_off_write', 'neo_work_item_states', 'neo_security_read', 'neo_security_login', 'neo_query_work_items', 'neo_work_item_types', 'neo_work_items_batch']) {
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
  // are retried after reconnecting. Creations are never replayed here: the planner
  // recovers them by their marker to avoid duplicates. A cancellation stops retries.
  async call(name, args) {
    const timeout = /_write$|^neo_create_item$/.test(name) ? 600000 : 180000;
    let generation = this.generation;
    for (let attempt = 1; ; attempt++) {
      try { return await this.callOnce(name, args, timeout); }
      catch (error) {
        if (attempt >= 3 || name === 'neo_create_item' || !this.lastConfig || this.generation !== generation || !isTransient(error)) throw error;
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
      result.push(...batch.map(normalizeItem));
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
  async workItemStates(config, type) {
    const states = await this.call('neo_work_item_states', { project: config.project, type });
    if (!Array.isArray(states)) throw new Error(`No se pudieron consultar los estados de «${type}».`);
    return workflowStates(states);
  }
  async capacity(config, iterationId) {
    const context = { project: config.project, team: config.team };
    const capacity = await this.call('work', { action: 'get_team_capacity', ...context, iterationId });
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
    if(!snapshot) report('settings', 'Leyendo la configuración del equipo…');
    const rawSettings = snapshot ? snapshot.settings : await this.call('work', { action: 'get_team_settings', ...context });
    const settings = { ...rawSettings, backlogIteration: normalizeIteration(rawSettings?.backlogIteration, config.project, 'el backlog') };
    if (typeof settings.defaultIteration?.path === 'string') settings.defaultIteration = normalizeIteration(settings.defaultIteration, config.project, 'la iteración predeterminada');
    if(section!=='tasks') report('iterations', 'Consultando las iteraciones del equipo…', { settings: 1 });
    const rawIterations = section==='tasks' ? snapshot.iterations : await this.call('work', { action: 'list_team_iterations', ...context });
    if (!Array.isArray(rawIterations)) throw new Error('Azure DevOps no devolvió una lista válida de iteraciones del equipo.');
    const today = new Date().toISOString().slice(0, 10);
    const pastPaths=rawIterations.filter(i=>isPastIteration(i,today)).map(i=>normalizeIteration(i,config.project,'una iteración anterior').path);
    const iterations=rawIterations.filter(i=>!isPastIteration(i,today)).map(i=>normalizeIteration(i,config.project,'una iteración del equipo'));
    if(section==='iterations') return {...snapshot,iterations};
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
    const types=catalog.filter(t=>relevant.has(t.name)), workflows=[], completedStates={};
    // Classification is complete before the large queries run. Unknown custom
    // states request a decision, with one example item rather than the backlog.
    for(const {name:type} of types) {
      report('states',`Comprobando estados de «${type}»…`);
      const states=await this.workItemStates(config,type), open=[];
      if(!states.length) throw new Error(`No se pudieron clasificar los estados de «${type}». Azure no devolvió su flujo de trabajo.`);
      for(const state of states) {
        const action=stateAction(config,type,state,stateRules);
        if(action==='include') open.push(state.name);
        else if(!action) {
          const sample=await this.call('neo_query_work_items',{project:config.project,wiql:importWiql(config,querySettings,pastPaths,type,[state.name]),fields:IMPORT_FIELDS,top:1});
          if(sample.workItems?.length) throw Object.assign(new Error(`Indica si «${state.name}» de «${type}» sigue abierto.`),{stateReview:{organization:config.organization,project:config.project,type,state:state.name,states,item:sample.workItems[0]}});
        }
      }
      const completed=states.find(s=>s.category==='completed');
      if(completed) completedStates[type]=completed.name;
      workflows.push({type,open});
    }
    const items=[], warnings=[], capacities={};
    const query=async(type,open,ids=null)=>{
      if(!open.length) return [];
      let after=0;const found=[];
      for(;;) {
        const result=await this.call('neo_query_work_items',{project:config.project,wiql:importWiql(config,querySettings,pastPaths,type,open,after,ids),fields:IMPORT_FIELDS,top:5000});
        if(!Array.isArray(result.workItems)) throw new Error('Azure no devolvió una lista válida de elementos abiertos.');
        found.push(...result.workItems.filter(raw=>open.some(state=>state.trim().toLowerCase()===String(raw.fields?.['System.State'] ?? '').trim().toLowerCase())).map(normalizeItem));
        report('items',`«${type}»: ${found.length} elementos abiertos leídos por lotes.`,{read:items.length+found.length});
        if(!result.limited) return found;
        const next=Math.max(...result.workItems.map(i=>i.id));
        if(!(next>after)) throw new Error('La consulta paginada no avanza. No se guardará una importación incompleta.');
        after=next;
      }
    };
    for(const {type,open} of workflows) items.push(...await query(type,open));
    const included=new Set(items.map(i=>i.id)),attempted=new Set();
    for(;;) {
      const parents=[...new Set(items.map(i=>i.parent).filter(id=>id && !included.has(id) && !attempted.has(id)))];
      if(!parents.length) break;
      parents.forEach(id=>attempted.add(id));
      report('parents','Completando los padres abiertos, sin descargar los cerrados…');
      for(let offset=0;offset<parents.length;offset+=200) for(const {type,open} of workflows) {
        const found=await query(type,open,parents.slice(offset,offset+200));
        for(const item of found) if(!included.has(item.id)) {items.push({...item,contextOnly:true});included.add(item.id);}
      }
    }
    for(const iteration of section==='tasks' ? [] : iterations) {
      report('capacity',`Consultando capacidad de «${iteration.name}»…`,{imported:items.length});
      try {capacities[iteration.id]=await this.capacity(config,iteration.id);}
      catch(error) {warnings.push(`No se pudo consultar la capacidad de «${iteration.name}» en ${config.project}: ${String(error?.message ?? error).slice(0,500)}`);}
      report('capacity',`Capacidad consultada: «${iteration.name}».`,{capacities:Object.keys(capacities).length});
    }
    report('saving', 'Guardando la copia local…', { imported: items.length, warnings: warnings.length });
    return { mode: 'azure', config, importedAt: new Date().toISOString(), settings, iterations, members, capacities:section==='tasks' ? snapshot.capacities : capacities, backlogLevels:levels, items, completedStates, warnings, drafts: {}, conflicts: {}, participants: {} };
  }
  async findCreation(config, creationKey) {
    if(!/^[a-f0-9-]{36}$/.test(creationKey)) throw new Error('Identificador de creación no válido.');
    const result=await this.call('wit_query',{action:'wiql',project:config.project,top:2,wiql:`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS 'neo-create-${creationKey}'`});
    if(!Array.isArray(result.workItems)) throw new Error('No se pudo comprobar si la creación ya existe.');
    if(result.workItems.length>1) throw new Error('Hay varios elementos con la misma marca de creación. Revisa Azure antes de continuar.');
    return result.workItems.length ? (await this.getItems(config,[result.workItems[0].id]))[0] : null;
  }
  async create(config,item,validateOnly=false) {
    const fields={'System.Title':item.title,'System.Tags':`neo-create-${item.creationKey}`,'System.AreaPath':item.areaPath,'System.IterationPath':item.iterationPath,'Microsoft.VSTS.Common.Priority':item.priority};
    if(item.assignedTo) fields['System.AssignedTo']=item.assignedTo;
    if(item.remainingWork!==null) fields['Microsoft.VSTS.Scheduling.RemainingWork']=item.remainingWork;
    const raw=await this.call('neo_create_item',{project:config.project,type:item.type,fields,parent:item.parent,validateOnly});
    return validateOnly ? raw : normalizeItem(raw);
  }
  async update(config, id, revision, fields) {
    const fieldNames = { title:'System.Title', assignedTo: 'System.AssignedTo', iterationPath: 'System.IterationPath', priority: 'Microsoft.VSTS.Common.Priority', remainingWork: 'Microsoft.VSTS.Scheduling.RemainingWork', state: 'System.State' };
    return normalizeItem(await this.call('wit_work_item_write', {
      action: 'update', project: config.project, id,
      // Without a revision the local value overwrites whatever Azure has.
      updates: [...(revision === null || revision === undefined ? [] : [{ op: 'test', path: '/rev', value: revision }]), ...Object.entries(fields).map(([key, value]) => ({ op: 'add', path: `/fields/${fieldNames[key]}`, value }))],
    }));
  }
}
