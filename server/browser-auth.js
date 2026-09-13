import { PublicClientApplication } from '@azure/msal-node';
import open from 'open';

// Same registered public client and Azure DevOps scope as the pinned Microsoft
// MCP. Explicit recovery uses the browser directly, without the native broker.
export function createBrowserAuthenticator(tenant, Client = PublicClientApplication, openBrowser = open) {
  const authorityTenant = tenant && tenant !== '00000000-0000-0000-0000-000000000000' ? tenant : 'common';
  const client = new Client({ auth: { clientId: '0d50963b-7bb9-4fe7-94c7-a99af00b5136', authority: `https://login.microsoftonline.com/${authorityTenant}` } });
  return async () => {
    const result = await client.acquireTokenInteractive({
      scopes: ['499b84ac-1321-427f-aa17-267ca6975798/.default'],
      prompt: 'select_account',
      openBrowser: async url => { await openBrowser(url); },
    });
    if (!result?.accessToken) throw new Error('Microsoft no devolvió una sesión de Azure DevOps.');
    return result.accessToken;
  };
}
