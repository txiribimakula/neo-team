import { createBrowserAuthenticator } from './browser-auth.js';
import { createCachedTokenProvider } from './token-cache.js';
import { activityLine, seconds } from './activity.js';
import open from 'open';
import { logger } from '@azure-devops/mcp/dist/logger.js';
// Local extension of Microsoft's pinned MCP tool implementations. No Azure calls
// are made by the HTTP application: all data access goes through this MCP server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { securityReader } from './security-reader.js';
import { WebApi, getBearerHandler } from 'azure-devops-node-api';
import { z } from 'zod';
import { createAuthenticator } from '@azure-devops/mcp/dist/auth.js';
import { getOrgTenant } from '@azure-devops/mcp/dist/org-tenants.js';
import { configureCoreTools } from '@azure-devops/mcp/dist/tools/core.js';
import { configureWorkTools } from '@azure-devops/mcp/dist/tools/work.js';
import { configureWorkItemTools } from '@azure-devops/mcp/dist/tools/work-items.js';
import { wrapExternalToolResponse } from '@azure-devops/mcp/dist/shared/content-safety.js';

const [organization, authentication = 'interactive', tenant] = process.argv.slice(2);
if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}$/.test(organization ?? '')) throw new Error('Organización inválida');
if (!['interactive', 'azcli'].includes(authentication)) throw new Error('Autenticación inválida');
// The local app shows these steps while a query waits. Messages are fixed texts:
// never the raw authentication logs, which include sign-in URLs.
const emit = (kind, message) => process.stderr.write(activityLine(kind, message));
const authSteps = [
  ['Attempting silent token acquisition', 'Intentando reutilizar la sesión de Microsoft guardada…'],
  ['Silent token acquisition failed', 'No se pudo reutilizar la sesión guardada.'],
  ['No cached account available', 'No hay una sesión de Microsoft en este proceso: hace falta iniciar sesión.'],
  ['Starting interactive token acquisition without broker', 'Abriendo el inicio de sesión de Microsoft en el navegador…'],
  ['Starting interactive token acquisition', 'Esperando el inicio de sesión con la ventana de cuentas del sistema. Puede aparecer detrás de otras ventanas.'],
  ['Opening browser for authentication', 'Se ha abierto el navegador para iniciar sesión con Microsoft. Complétalo para continuar.'],
  ['Interactive token acquisition failed', 'El inicio de sesión con la ventana del sistema no se completó; se intentará con el navegador.'],
];
const debug = logger.debug.bind(logger);
logger.debug = (message, ...rest) => {
  const step = typeof message === 'string' && authSteps.find(([text]) => message.includes(text));
  if (step) emit('auth', step[1]);
  return debug(message, ...rest);
};
let useBrowser = false, waiting;
const tokenProvider = createCachedTokenProvider(async options => {
  if (options.interactive === true) useBrowser = true;
  if (!tenant) emit('auth', 'Buscando el directorio de Microsoft de la organización…');
  const organizationTenant = tenant || await getOrgTenant(organization);
  if (useBrowser) return createBrowserAuthenticator(organizationTenant, undefined, async url => { emit('auth', 'Se ha abierto el navegador para elegir la cuenta de Microsoft. Complétalo para continuar.'); await open(url); });
  if (authentication === 'azcli') emit('auth', 'Usando la sesión de Azure CLI…');
  return createAuthenticator(authentication, organizationTenant);
}, Date.now, event => {
  clearInterval(waiting);
  if (event.type === 'authenticating') {
    const started = Date.now();
    emit('auth', 'Obteniendo un token de acceso de Azure DevOps…');
    waiting = setInterval(() => emit('auth', `Sigue esperando el inicio de sesión de Microsoft (${Math.round((Date.now() - started) / 1000)} s). Comprueba si hay una ventana de Microsoft abierta.`), 10000);
    waiting.unref();
  } else emit('auth', event.type === 'authenticated' ? `Token de acceso obtenido en ${seconds(event.ms)}.` : `No se pudo obtener el token de acceso tras ${seconds(event.ms)}.`);
});
const connectionProvider = async () => {
  const handler = getBearerHandler(await tokenProvider());
  const prepare = handler.prepareRequest.bind(handler);
  handler.prepareRequest = options => { emit('http', `Petición a Azure DevOps: ${options.method || 'GET'} ${String(options.path || '').split('?')[0]}`); return prepare(options); };
  return new WebApi(`https://dev.azure.com/${organization}`, handler);
};
const server = new McpServer({ name: 'Neo Team · Azure DevOps MCP', version: '0.1.0' });
// Keep the official untrusted-content boundary on every registered tool.
const originalTool = server.tool.bind(server);
server.tool = (...args) => {
  const callback = args.pop();
  return originalTool(...args, async (...input) => wrapExternalToolResponse(await callback(...input), 'Azure DevOps'));
};
configureCoreTools(server, tokenProvider, connectionProvider, () => 'NeoTeam/0.1.0');
configureWorkTools(server, tokenProvider, connectionProvider);
configureWorkItemTools(server, tokenProvider, connectionProvider, () => 'NeoTeam/0.1.0');

server.tool('neo_security_login', 'Explicitly open Microsoft account selection in the browser for this MCP session.', {}, async () => {
  await tokenProvider({ forceRefresh: true, interactive: true });
  return { content: [{ type: 'text', text: JSON.stringify({ authenticated: true, method: 'browser' }) }] };
});
const readSecurity = securityReader(organization, tokenProvider);
server.tool('neo_security_read', 'Read project groups, memberships, ACLs and resource roles. Does not change permissions.', {
  action: z.enum(['catalog', 'identity', 'acl', 'resources', 'roles', 'feedPermissions', 'feedViews', 'namespaces']),
  project: z.string().min(1).max(200).optional(), descriptor: z.string().max(2000).optional(),
  namespaceId: z.string().uuid().optional(), descriptors: z.array(z.string().max(2000)).max(20).optional(),
  kind: z.string().max(40).optional(), resourceId: z.string().max(200).optional(),
}, async args => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await readSecurity(args)) }] }; }
  catch (error) {
    if (!['AZURE_SECURITY_SOURCE_DENIED', 'AZURE_AUTHENTICATION_REQUIRED', 'AZURE_SECURITY_ERROR'].includes(error.code)) throw error;
    return { content: [{ type: 'text', text: JSON.stringify({ securityError: { code: error.code, message: error.message, diagnostics: error.diagnostics } }) }] };
  }
});

server.tool('neo_work_item_types', 'List project work item types before selecting open workflow states.', {
  project: z.string().min(1),
}, async ({project}) => {
  const api=await (await connectionProvider()).getWorkItemTrackingApi();
  return {content:[{type:'text',text:JSON.stringify((await api.getWorkItemTypes(project)).filter(t=>!t.isDisabled).map(t=>({name:t.name})))}]};
});
server.tool('neo_work_items_batch', 'Read complete work item fields in batches of up to 200.', {
  project:z.string().min(1), ids:z.array(z.number().int().positive()).max(200),
}, async ({project,ids}) => {
  const api=await (await connectionProvider()).getWorkItemTrackingApi();
  return {content:[{type:'text',text:JSON.stringify(ids.length ? await api.getWorkItemsBatch({ids,fields:['System.Title', 'System.WorkItemType', 'System.State', 'System.AssignedTo', 'System.IterationPath', 'System.AreaPath', 'System.Parent', 'System.Tags', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Scheduling.RemainingWork', 'Microsoft.VSTS.Scheduling.StoryPoints', 'Microsoft.VSTS.Scheduling.Effort', 'Microsoft.VSTS.Scheduling.Size']},project) : [])}]};
});

server.tool('neo_work_item_states', 'Read workflow state categories for a work item type, including custom states.', {
  project: z.string().min(1), type: z.string().min(1),
}, async ({ project, type }) => {
  const api = await (await connectionProvider()).getWorkItemTrackingApi();
  return { content: [{ type: 'text', text: JSON.stringify(await api.getWorkItemTypeStates(project, type)) }] };
});

// The official 2.10.0 core tools list teams, but do not expose their complete
// membership. This read-only extension also includes team-wide holidays.
server.tool('neo_team_members', 'List every team member, including members without capacity or assigned work.', {
  project: z.string().min(1), team: z.string().min(1),
}, async ({ project, team }) => {
  const api = await (await connectionProvider()).getCoreApi();
  const members = [];
  for (let skip = 0; ; skip += 100) {
    const page = await api.getTeamMembersWithExtendedProperties(project, team, 100, skip);
    members.push(...page.map(({ identity, isTeamAdmin }) => ({ id: identity.id, displayName: identity.displayName, uniqueName: identity.uniqueName, isTeamAdmin })));
    if (page.length < 100) break;
  }
  return { content: [{ type: 'text', text: JSON.stringify(members) }] };
});
server.tool('neo_team_days_off', 'Read team-wide days off for an iteration.', {
  project: z.string().min(1), team: z.string().min(1), iterationId: z.string().min(1),
}, async ({ project, team, iterationId }) => {
  const api = await (await connectionProvider()).getWorkApi();
  const where = `proyecto «${project}», equipo «${team}», iteración ${iterationId}`;
  let daysOff;
  try { daysOff = await api.getTeamDaysOff({ project, team }, iterationId); }
  catch (error) { throw new Error(`${error.statusCode ? `HTTP ${error.statusCode}` : error.name || 'Error'} al leer los días libres (${where}): ${error.message}`); }
  // The REST client resolves a 404 as null instead of rejecting.
  if (!daysOff) throw new Error(`HTTP 404 al leer los días libres (${where}): Azure DevOps no encontró la iteración en ese equipo.`);
  return { content: [{ type: 'text', text: JSON.stringify(daysOff) }] };
});
// Capacity writes replace the complete value of one member, or the team-wide
// days off, so a stale partial patch cannot mix with what Azure already has.
const dayRange = z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const asDates = ranges => ranges.map(({ start, end }) => ({ start: new Date(`${start}T00:00:00Z`), end: new Date(`${end}T00:00:00Z`) }));
server.tool('neo_team_capacity_write', 'Replace the activities and days off of one team member in an iteration.', {
  project: z.string().min(1), team: z.string().min(1), iterationId: z.string().min(1), teamMemberId: z.string().min(1),
  activities: z.array(z.object({ name: z.string().max(128), capacityPerDay: z.number().min(0).max(24) })).max(20),
  daysOff: z.array(dayRange).max(100),
}, async ({ project, team, iterationId, teamMemberId, activities, daysOff }) => {
  const api = await (await connectionProvider()).getWorkApi();
  const updated = await api.updateCapacityWithIdentityRef({ activities, daysOff: asDates(daysOff) }, { project, team }, iterationId, teamMemberId);
  return { content: [{ type: 'text', text: JSON.stringify(updated) }] };
});
server.tool('neo_team_days_off_write', 'Replace the team-wide days off of an iteration.', {
  project: z.string().min(1), team: z.string().min(1), iterationId: z.string().min(1), daysOff: z.array(dayRange).max(100),
}, async ({ project, team, iterationId, daysOff }) => {
  const api = await (await connectionProvider()).getWorkApi();
  return { content: [{ type: 'text', text: JSON.stringify(await api.updateTeamDaysOff({ daysOff: asDates(daysOff) }, { project, team }, iterationId)) }] };
});
// A query and the fields of its results in one tool call: batches of 200 are
// read in parallel inside the MCP instead of one round trip per batch.
server.tool('neo_query_work_items', 'Run a WIQL query and return the requested fields of the matching work items.', {
  project: z.string().min(1), wiql: z.string().min(1).max(32768), fields: z.array(z.string().min(1).max(200)).min(1).max(50), top: z.number().int().min(1).max(5000),
}, async ({ project, wiql, fields, top }) => {
  const api = await (await connectionProvider()).getWorkItemTrackingApi();
  const result = await api.queryByWiql({ query: wiql }, { project }, false, top + 1);
  const ids = (result.workItems ?? []).map(item => item.id), selected = ids.slice(0, top);
  emit('info', `La consulta encontró ${ids.length > top ? `más de ${top}` : ids.length} elementos. Leyendo sus campos…`);
  const chunks = [];
  for (let start = 0; start < selected.length; start += 200) chunks.push(selected.slice(start, start + 200));
  const batches = [];
  for(let offset=0;offset<chunks.length;offset+=4) {
    batches.push(...await Promise.all(chunks.slice(offset,offset+4).map(chunk=>api.getWorkItemsBatch({ids:chunk,fields},project))));
    emit('info', `${Math.min((offset+4)*200,selected.length)} / ${selected.length} elementos leídos.`);
  }
  return { content: [{ type: 'text', text: JSON.stringify({ ids: selected, limited: ids.length > top, workItems: batches.flat() }) }] };
});
// Atomic creation includes the parent link and a recovery tag in the same request.
server.tool('neo_create_item', 'Create or validate one work item with its parent link and recovery marker.', {
  project:z.string().min(1), type:z.enum(['Epic','Feature','User Story','Task','Bug']),
  fields:z.record(z.union([z.string(),z.number()])), parent:z.number().int().positive().nullable(), validateOnly:z.boolean(),
}, async ({project,type,fields,parent,validateOnly})=>{
  const api=await (await connectionProvider()).getWorkItemTrackingApi();
  const allowed=['System.Title','System.Tags','System.AreaPath','System.IterationPath','System.AssignedTo','Microsoft.VSTS.Scheduling.RemainingWork','Microsoft.VSTS.Common.Priority'];
  if(Object.keys(fields).some(k=>!allowed.includes(k))) throw new Error('Campo no permitido.');
  const document=Object.entries(fields).map(([name,value])=>({op:'add',path:`/fields/${name}`,value}));
  if(parent) document.push({op:'add',path:'/relations/-',value:{rel:'System.LinkTypes.Hierarchy-Reverse',url:`https://dev.azure.com/${organization}/_apis/wit/workItems/${parent}`}});
  const result=await api.createWorkItem({},document,project,type,validateOnly,false,false);
  return {content:[{type:'text',text:JSON.stringify(result)}]};
});
await server.connect(new StdioServerTransport());
