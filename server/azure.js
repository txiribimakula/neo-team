import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { normalizeItem } from './planner.js';

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

export class AzureGateway {
  async open(config) {
    const key = JSON.stringify([config.organization, config.authentication, config.tenant || '']);
    if (this.key === key && this.client) return;
    await this.close();
    const client = new Client({ name: 'neo-team', version: '0.1.0' });
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
      for (const name of ['work', 'wit_backlog', 'wit_work_item', 'wit_work_item_write', 'neo_team_members', 'neo_team_days_off']) {
        if (!tools.some(t => t.name === name)) throw new Error(`El MCP no ofrece ${name}`);
      }
      this.client = client; this.key = key;
      client.onclose = () => { if (this.client === client) { this.client = null; this.key = null; } };
    } catch (error) { await client.close().catch(() => {}); throw error; }
  }
  async close() { const client = this.client; this.client = null; this.key = null; if (client) await client.close().catch(() => {}); }
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
  async import(config) {
    await this.open(config);
    const context = { project: config.project, team: config.team };
    const settings = await this.call('work', { action: 'get_team_settings', ...context });
    const iterations = await this.call('work', { action: 'list_team_iterations', ...context });
    const members = await this.call('neo_team_members', context);
    const levels = await this.call('wit_backlog', { action: 'list', ...context });
    if (!Array.isArray(iterations) || !Array.isArray(members) || !Array.isArray(levels) || !settings.backlogIteration?.path) throw new Error('El equipo no tiene una configuración de backlog válida.');
    const ids = new Set();
    const addRelations = data => {
      for (const item of data.workItems ?? []) if (item.target?.id || item.id) ids.add(item.target?.id || item.id);
      for (const rel of data.workItemRelations ?? []) if (rel.target?.id) ids.add(rel.target.id);
    };
    for (const level of levels) addRelations(await this.call('wit_backlog', { action: 'list_work_items', ...context, backlogId: level.id }));
    const capacities = {}, warnings = [];
    for (const iteration of iterations) {
      addRelations(await this.call('wit_work_item', { action: 'list_for_iteration', ...context, iterationId: iteration.id }));
      try {
        const capacity = await this.call('work', { action: 'get_team_capacity', ...context, iterationId: iteration.id });
        const daysOff = await this.call('neo_team_days_off', { ...context, iterationId: iteration.id });
        capacities[iteration.id] = { ...capacity, daysOff: daysOff.daysOff ?? [] };
      } catch { warnings.push(`No se pudo consultar la capacidad completa de «${iteration.name}». Se mostrará como desconocida.`); }
    }
    // Follow hierarchy links through MCP so unscheduled child tasks are included.
    const items = [], fetched = new Map();
    const queue = [...ids];
    for (let i = 0; i < queue.length; i++) {
      const raw = await this.call('wit_work_item', { action: 'get', project: config.project, id: queue[i], expand: 'All' });
      fetched.set(raw.id,raw);
      const fields = raw.fields ?? {};
      if (String(fields['System.TeamProject'] ?? '').toLowerCase() !== config.project.toLowerCase()) continue;
      const areas = settings.areaPaths ?? [];
      if (areas.length && !areas.some(a => fields['System.AreaPath'] === a.value || (a.includeChildren && fields['System.AreaPath']?.startsWith(a.value + '\\')))) continue;
      items.push(normalizeItem(raw));
      for (const relation of raw.relations ?? []) {
        if (relation.rel !== 'System.LinkTypes.Hierarchy-Forward') continue;
        const id = Number(relation.url?.match(/\/workItems\/(\d+)$/i)?.[1]);
        if (id && !ids.has(id)) { ids.add(id); queue.push(id); }
      }
    }
    // A portfolio parent may live outside the team's area or visible backlog
    // levels. Fetch ancestors as context without importing sibling team tasks.
    const included = new Set(items.map(i=>i.id)), attempted = new Set();
    for (let index=0; index<items.length; index++) {
      const parent = Number(items[index].parent);
      if (!parent || included.has(parent) || attempted.has(parent)) continue;
      attempted.add(parent);
      try {
        const raw = fetched.get(parent) || await this.call('wit_work_item',{action:'get',project:config.project,id:parent,expand:'All'});
        const item = normalizeItem(raw);
        item.contextOnly = true; items.push(item); included.add(item.id);
      } catch { warnings.push(`No se pudo leer el padre #${parent}. Sus tareas seguirán visibles sin ese nivel de la jerarquía.`); }
    }
    return { mode: 'azure', config, importedAt: new Date().toISOString(), settings, iterations, members, capacities, items, warnings, drafts: {}, conflicts: {}, participants: {} };
  }
  async update(config, id, revision, fields) {
    const fieldNames = { assignedTo: 'System.AssignedTo', iterationPath: 'System.IterationPath', priority: 'Microsoft.VSTS.Common.Priority', remainingWork: 'Microsoft.VSTS.Scheduling.RemainingWork' };
    return normalizeItem(await this.call('wit_work_item_write', {
      action: 'update', project: config.project, id,
      updates: [{ op: 'test', path: '/rev', value: revision }, ...Object.entries(fields).map(([key, value]) => ({ op: 'add', path: `/fields/${fieldNames[key]}`, value }))],
    }));
  }
}
