// Local extension of Microsoft's pinned MCP tool implementations. No Azure calls
// are made by the HTTP application: all data access goes through this MCP server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
let authenticator, cachedToken, refreshAt = 0;
const tokenProvider = async () => {
  if (cachedToken && Date.now() < refreshAt) return cachedToken;
  authenticator ??= createAuthenticator(authentication, tenant || await getOrgTenant(organization));
  cachedToken = await authenticator();
  // The official browser fallback does not always retain an account for silent
  // auth. Keep its access token only in this process until shortly before expiry.
  let expires = Date.now() + 40 * 60000;
  try {
    const payload = JSON.parse(Buffer.from(cachedToken.split('.')[1], 'base64url').toString());
    if (Number.isFinite(payload.exp)) expires = Math.min(expires, payload.exp * 1000 - 120000);
  } catch { /* An opaque token is retained for at most 40 minutes. */ }
  refreshAt = expires;
  return cachedToken;
};
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
