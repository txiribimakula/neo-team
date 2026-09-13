import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { normalizeItem } from './planner.js';
import { isExecutable } from '../dist/hierarchy.js';

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

export class AzureGateway {
  async open(config) {
    const key = JSON.stringify([config.organization, config.authentication, config.tenant || '']);
    if (this.key === key && this.client) return;
    await this.close();
    const client = new Client({ name: 'neo-team', version: '0.1.0' });
    this.openingClient = client;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('./mcp-server.js', import.meta.url)), config.organization, config.authentication, config.tenant || ''],
      stderr: 'pipe',
    });
    // Drain logs without retaining or exposing authentication details.
    transport.stderr?.on('data', () => {});
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      for (const name of ['work', 'wit_backlog', 'wit_work_item', 'wit_work_item_write', 'neo_team_members', 'neo_team_days_off', 'neo_team_capacity_write', 'neo_team_days_off_write', 'neo_work_item_states', 'neo_security_read', 'neo_security_login']) {
        if (!tools.some(t => t.name === name)) throw new Error(`El MCP no ofrece ${name}`);
      }
      if (this.openingClient !== client) throw new Error('Conexión cancelada.');
      this.openingClient = null;
      this.client = client; this.key = key;
      client.onclose = () => { if (this.client === client) { this.client = null; this.key = null; } };
    } catch (error) { if (this.openingClient === client) this.openingClient = null; await client.close().catch(() => {}); throw error; }
  }
  async close() {
    const clients = [this.client, this.openingClient].filter(Boolean);
    this.client = null; this.openingClient = null; this.key = null;
    await Promise.all(clients.map(client => client.close().catch(() => {})));
  }
  async call(name, args) {
    if (!this.client) throw new Error('Conecta Azure DevOps para continuar.');
    const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    return parseToolResult(result);
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
    // get_batch's defaults omit iteration and effort. Individual full reads also
    // accommodate custom fields and differences between Agile/Scrum/Basic.
    for (const id of ids) result.push(normalizeItem(await this.call('wit_work_item', { action: 'get', project: config.project, id, expand: 'Fields' })));
    return result;
  }
  async completedState(config, type) {
    const states = await this.call('neo_work_item_states', { project: config.project, type });
    if (!Array.isArray(states)) throw new Error(`No se pudieron consultar los estados de «${type}».`);
    return workflowStates(states).find(s => s.category === 'completed')?.name ?? null;
  }
  async capacity(config, iterationId) {
    const context = { project: config.project, team: config.team };
    const capacity = await this.call('work', { action: 'get_team_capacity', ...context, iterationId });
    const daysOff = await this.call('neo_team_days_off', { ...context, iterationId });
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
  async import(config, onProgress = () => {}, stateRules = []) {
    let counts = {};
    const report = (phase, message, updates = {}) => {
      counts = { ...counts, ...updates };
      onProgress({ phase, message, counts: { ...counts } });
    };
    report('connection', 'Conectando con Azure DevOps. Completa el acceso de Microsoft si se solicita.');
    await this.open(config);
    const context = { project: config.project, team: config.team };
    report('settings', 'Leyendo la configuración del equipo…');
    const rawSettings = await this.call('work', { action: 'get_team_settings', ...context });
    const settings = { ...rawSettings, backlogIteration: normalizeIteration(rawSettings?.backlogIteration, config.project, 'el backlog') };
    if (typeof settings.defaultIteration?.path === 'string') settings.defaultIteration = normalizeIteration(settings.defaultIteration, config.project, 'la iteración predeterminada');
    report('iterations', 'Consultando las iteraciones del equipo…', { settings: 1 });
    const rawIterations = await this.call('work', { action: 'list_team_iterations', ...context });
    if (!Array.isArray(rawIterations)) throw new Error('Azure DevOps no devolvió una lista válida de iteraciones del equipo.');
    const today = new Date().toISOString().slice(0, 10);
    // Past iterations are skipped except the latest one, whose open work is
    // reviewed before planning the next iteration. Azure lists them in order.
    const previous = rawIterations.filter(iteration => isPastIteration(iteration, today)).at(-1);
    const iterations = rawIterations.filter(iteration => iteration === previous || !isPastIteration(iteration, today))
      .map(iteration => ({ ...normalizeIteration(iteration, config.project, 'una iteración del equipo'), ...(iteration === previous ? { past: true } : {}) }));
    report('members', 'Obteniendo los integrantes del equipo…', { iterations: iterations.length, iterationsExcluded: rawIterations.length - iterations.length });
    const members = await this.call('neo_team_members', context);
    if (!Array.isArray(members)) throw new Error('Azure DevOps no devolvió una lista válida de integrantes del equipo.');
    report('backlogs', 'Consultando los niveles de backlog…', { members: members.length });
    const levels = await this.call('wit_backlog', { action: 'list', ...context });
    if (!Array.isArray(levels)) throw new Error('Azure DevOps no devolvió una lista válida de niveles de backlog del equipo.');
    const ids = new Set();
    const addRelations = data => {
      for (const item of data.workItems ?? []) if (item.target?.id || item.id) ids.add(item.target?.id || item.id);
      for (const rel of data.workItemRelations ?? []) if (rel.target?.id) ids.add(rel.target.id);
    };
    report('backlogs', 'Leyendo los elementos del backlog…', { backlogs: 0, backlogTotal: levels.length, discovered: 0 });
    for (const level of levels) {
      report('backlogs', `Leyendo el backlog «${level.name || level.id}»…`);
      addRelations(await this.call('wit_backlog', { action: 'list_work_items', ...context, backlogId: level.id }));
      report('backlogs', `Backlog «${level.name || level.id}» obtenido.`, { backlogs: counts.backlogs + 1, discovered: ids.size });
    }
    const capacities = {}, warnings = [];
    report('capacity', 'Consultando tareas y capacidad de las iteraciones…', { capacities: 0, iterationsRead: 0 });
    for (const iteration of iterations) {
      report('capacity', `Leyendo tareas de «${iteration.name}»…`);
      addRelations(await this.call('wit_work_item', { action: 'list_for_iteration', ...context, iterationId: iteration.id }));
      // The previous iteration is only reviewed, so its capacity is not needed.
      if (!iteration.past) {
        report('capacity', `Obteniendo capacidad y días libres de «${iteration.name}»…`, { discovered: ids.size });
        try {
          capacities[iteration.id] = await this.capacity(config, iteration.id);
        } catch { warnings.push(`No se pudo consultar la capacidad completa de «${iteration.name}». Se mostrará como desconocida.`); }
      }
      report('capacity', `Iteración «${iteration.name}» consultada.`, { iterationsRead: counts.iterationsRead + 1, capacities: Object.keys(capacities).length, warnings: warnings.length });
    }
    // Follow hierarchy links through MCP so unscheduled child tasks are included.
    const items = [], fetched = new Map();
    const stateCategories = new Map(), excluded = new Set();
    const stateKey = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
    const loadStates = async (project, type) => {
      const typeKey = JSON.stringify([project, type]);
      if (!stateCategories.has(typeKey)) {
        const states = await this.call('neo_work_item_states', { project, type });
        if (!Array.isArray(states)) throw new Error(`Estados de «${type}» no válidos.`);
        stateCategories.set(typeKey, workflowStates(states));
      }
      return stateCategories.get(typeKey);
    };
    const isOpen = async raw => {
      const type = raw.fields?.['System.WorkItemType'], state = raw.fields?.['System.State'];
      const project = raw.fields?.['System.TeamProject'] || config.project;
      const typeKey = JSON.stringify([project, type]);
      if (!type || !state) throw new Error(`No se pudo comprobar si el elemento #${raw.id} sigue abierto: falta su tipo o estado.`);
      const rule = stateRules.find(rule => stateKey(rule.organization) === stateKey(config.organization) && stateKey(rule.project) === stateKey(project) && stateKey(rule.type) === stateKey(type) && stateKey(rule.state) === stateKey(state));
      if (rule) { if (rule.action === 'exclude') excluded.add(raw.id); return rule.action === 'include'; }
      if (stateKey(state) === 'discarded') { excluded.add(raw.id); return false; }
      const needsDecision = (message, states = []) => Object.assign(new Error(message), {
        stateReview: { organization: config.organization, project, type, state, item: { id: raw.id, fields: raw.fields }, states },
      });
      if (!stateCategories.has(typeKey)) {
        try { await loadStates(project, type); }
        catch { throw needsDecision(`No se pudieron consultar los estados de «${type}». Indica cómo tratar «${state}».`); }
      }
      const stateName = stateKey(state);
      // Explicit workflow categories take precedence over conventional names.
      // Some responses omit categories for standard terminal states.
      const category = stateCategories.get(typeKey).find(s => stateKey(s.name) === stateName)?.category || ({ closed: 'completed', done: 'completed', removed: 'removed' })[stateName];
      if (['completed', 'removed'].includes(category)) { excluded.add(raw.id); return false; }
      if (['proposed', 'inprogress', 'resolved'].includes(category)) return true;
      throw needsDecision(`No se pudo determinar la categoría del estado «${state}» de «${type}». Indica si debe importarse.`, stateCategories.get(typeKey));
    };
    const queue = [...ids];
    report('items', 'Leyendo los detalles y las tareas hijas abiertas…', { read: 0, imported: 0, excluded: 0 });
    for (let i = 0; i < queue.length; i++) {
      report('items', `Leyendo el elemento #${queue[i]} (${i + 1} de ${queue.length} detectados)…`, { read: i, discovered: queue.length, imported: items.length, excluded: excluded.size });
      const raw = await this.call('wit_work_item', { action: 'get', project: config.project, id: queue[i], expand: 'All' });
      fetched.set(raw.id,raw);
      const fields = raw.fields ?? {};
      if (String(fields['System.TeamProject'] ?? '').toLowerCase() !== config.project.toLowerCase()) continue;
      const areas = settings.areaPaths ?? [];
      if (areas.length && !areas.some(a => fields['System.AreaPath'] === a.value || (a.includeChildren && fields['System.AreaPath']?.startsWith(a.value + '\\')))) continue;
      // Traverse closed parents too: they can still have open child tasks.
      for (const relation of raw.relations ?? []) {
        if (relation.rel !== 'System.LinkTypes.Hierarchy-Forward') continue;
        const id = Number(relation.url?.match(/\/workItems\/(\d+)$/i)?.[1]);
        if (id && !ids.has(id)) { ids.add(id); queue.push(id); }
      }
      if (await isOpen(raw)) items.push(normalizeItem(raw));
    }
    // A portfolio parent may live outside the team's area or visible backlog
    // levels. Fetch ancestors as context without importing sibling team tasks.
    report('parents', 'Completando los padres abiertos de la jerarquía…', { read: queue.length, discovered: queue.length, imported: items.length, parents: 0, excluded: excluded.size });
    const included = new Set(items.map(i=>i.id)), attempted = new Set();
    let parentCount = 0;
    for (let index=0; index<items.length; index++) {
      const parent = Number(items[index].parent);
      if (!parent || included.has(parent) || attempted.has(parent)) continue;
      attempted.add(parent);
      report('parents', `Leyendo el padre #${parent}…`);
      try {
        const raw = fetched.get(parent) || await this.call('wit_work_item',{action:'get',project:config.project,id:parent,expand:'All'});
        if (await isOpen(raw)) {
          const item = normalizeItem(raw);
          item.contextOnly = true; items.push(item); included.add(item.id); parentCount++;
        }
      } catch (error) { if (error.stateReview) throw error; warnings.push(`No se pudo leer el padre #${parent}. Sus tareas seguirán visibles sin ese nivel de la jerarquía.`); }
      report('parents', 'Completando la jerarquía…', { parents: parentCount, imported: items.length, warnings: warnings.length, excluded: excluded.size });
    }
    // Tasks and bugs can be closed with the first completed state of their
    // workflow. Without one, they can only be carried over to the next iteration.
    const completedStates = {};
    for (const type of new Set(items.filter(isExecutable).map(item => item.type))) {
      const completed = (await loadStates(config.project, type).catch(() => [])).find(s => s.category === 'completed');
      if (completed) completedStates[type] = completed.name;
    }
    report('saving', 'Guardando la copia local…', { imported: items.length, warnings: warnings.length });
    return { mode: 'azure', config, importedAt: new Date().toISOString(), settings, iterations, members, capacities, items, completedStates, warnings, drafts: {}, conflicts: {}, participants: {} };
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
      updates: [{ op: 'test', path: '/rev', value: revision }, ...Object.entries(fields).map(([key, value]) => ({ op: 'add', path: `/fields/${fieldNames[key]}`, value }))],
    }));
  }
}
