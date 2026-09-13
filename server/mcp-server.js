import { createBrowserAuthenticator } from './browser-auth.js';
import { createCachedTokenProvider } from './token-cache.js';
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
let useBrowser = false;
const tokenProvider = createCachedTokenProvider(async options => {
  if (options.interactive === true) useBrowser = true;
  const organizationTenant = tenant || await getOrgTenant(organization);
  return useBrowser ? createBrowserAuthenticator(organizationTenant) : createAuthenticator(authentication, organizationTenant);
});
const connectionProvider = async () => new WebApi(`https://dev.azure.com/${organization}`, getBearerHandler(await tokenProvider()));
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
}, async args => ({ content: [{ type: 'text', text: JSON.stringify(await readSecurity(args)) }] }));

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
  return { content: [{ type: 'text', text: JSON.stringify(await api.getTeamDaysOff({ project, team }, iterationId)) }] };
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
