// Read-only Azure REST adapter, used exclusively inside the MCP process.
const enc = encodeURIComponent;
export function securityReader(organization, tokenProvider, fetcher = fetch) {
  async function get(host, path, query = {}) {
    const url = new URL(`https://${host}/${enc(organization)}/${path}`);
    for (const [key, value] of Object.entries({ 'api-version': '7.1', ...query })) if (value !== undefined) url.searchParams.set(key, value);
    const response = await fetcher(url, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${await tokenProvider()}`, Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Azure HTTP ${response.status}: ${response.status === 403 ? 'tu cuenta no puede consultar esta seguridad' : response.status === 401 ? 'la sesión no permite acceder a estos datos' : 'no se pudo consultar esta fuente'}`);
    return { data: await response.json(), next: response.headers.get('x-ms-continuationtoken') };
  }
  async function list(host, path, query = {}) {
    const values = [], seen = new Set();
    let next;
    do {
      const page = await get(host, path, { ...query, continuationToken: next });
      if (!Array.isArray(page.data.value)) throw new Error('Azure devolvió una lista de seguridad no válida.');
      values.push(...page.data.value);
      next = page.next;
      if (next && seen.has(next)) throw new Error('Azure repitió la página; la consulta no está completa.');
      seen.add(next);
    } while (next);
    return values;
  }
  const dev = 'dev.azure.com', graph = 'vssps.dev.azure.com';
  const cleanIdentity = i => ({ id: i.id, descriptor: i.descriptor, subjectDescriptor: i.subjectDescriptor, name: i.providerDisplayName || i.customDisplayName || i.descriptor, isContainer: i.isContainer, members: i.members || [], memberOf: i.memberOf || [] });
  return async ({ action, project, descriptor, namespaceId, descriptors, kind, resourceId }) => {
    const p = enc(project);
    if (action === 'catalog') {
      const { data: info } = await get(dev, `_apis/projects/${p}`);
      const { data: scope } = await get(graph, `_apis/graph/descriptors/${enc(info.id)}`, { 'api-version': '7.1-preview.1' });
      const scoped = await list(graph, '_apis/graph/groups', { scopeDescriptor: scope.value, 'api-version': '7.1-preview.1' });
      const groups = scoped.map(g => ({ descriptor: g.descriptor, name: g.displayName, principalName: g.principalName, description: g.description, scope: 'project' }));
      const coverage = [];
      try {
        const all = await list(graph, '_apis/graph/groups', { 'api-version': '7.1-preview.1' });
        const ids = new Set(groups.map(g => g.descriptor));
        for (const g of all) if (!ids.has(g.descriptor)) groups.push({ descriptor: g.descriptor, name: g.displayName, principalName: g.principalName, description: g.description, scope: 'other' });
        coverage.push({ name: 'Otros grupos visibles de la organización', status: 'ok' });
      } catch (e) { coverage.push({ name: 'Otros grupos de la organización', status: 'error', message: e.message }); }
      return { project: { id: info.id, name: info.name, visibility: info.visibility }, groups, namespaces: await list(dev, '_apis/securitynamespaces'), coverage, fetchedAt: new Date().toISOString() };
    }
    if (action === 'identity') return (await list(graph, '_apis/identities', { ...(descriptor ? { subjectDescriptors: descriptor } : { descriptors: descriptors.join(',') }), queryMembership: 'Direct' })).map(cleanIdentity);
    if (action === 'acl') return list(dev, `_apis/accesscontrollists/${enc(namespaceId)}`, { descriptors: descriptors.join(','), includeExtendedInfo: true, recurse: true });
    if (action === 'resources') {
      const routes = {
        repositories: ['git/repositories', {}], builds: ['build/definitions', {}], releases: ['release/definitions', {}],
        areas: ['wit/classificationnodes/areas', { '$depth': 100 }], iterations: ['wit/classificationnodes/iterations', { '$depth': 100 }],
        environments: ['distributedtask/environments', {}], endpoints: ['serviceendpoint/endpoints', {}],
        variablegroups: ['distributedtask/variablegroups', {}], securefiles: ['distributedtask/securefiles', {}], queues: ['distributedtask/queues', {}],
        feeds: ['packaging/feeds', {}],
      };
      if (!routes[kind]) throw new Error('Inventario no permitido.');
      const [route, params] = routes[kind];
      const host = kind === 'feeds' ? 'feeds.dev.azure.com' : kind === 'releases' ? 'vsrm.dev.azure.com' : dev;
      let resources;
      if (['areas', 'iterations'].includes(kind)) {
        const { data } = await get(host, `${p}/_apis/${route}`, params);
        resources = [];
        const visit = node => { resources.push(node); for (const child of node.children || []) visit(child); };
        visit(data);
      } else resources = await list(host, `${p}/_apis/${route}`, params);
      // Never expose endpoint authorization, variable values or secure-file data.
      return resources.map(r => ({ id: String(r.identifier || r.id), name: ['builds', 'releases'].includes(kind) ? `${r.path || ''}/${r.name}` : r.path || r.name, kind }));
    }
    if (action === 'roles') {
      const roleScopes = { environments: 'distributedtask.environmentreferencerole', endpoints: 'distributedtask.serviceendpointrole' };
      if (!roleScopes[kind]) throw new Error('Ámbito de roles no permitido.');
      return (await list(dev, `_apis/securityroles/scopes/${roleScopes[kind]}/roleassignments/resources/${enc(`${project}_${resourceId}`)}`, { 'api-version': '7.1-preview.1' })).map(r => ({ identity: { id: r.identity?.id, name: r.identity?.displayName }, role: r.role, access: r.access }));
    }
    if (action === 'feedPermissions') return list('feeds.dev.azure.com', `${p}/_apis/packaging/feeds/${enc(resourceId)}/permissions`, { includeIds: true });
    if (action === 'feedViews') return (await list('feeds.dev.azure.com', `${p}/_apis/packaging/feeds/${enc(resourceId)}/views`, {})).map(v => ({ id: v.id, name: v.name, visibility: v.visibility }));
    throw new Error('Consulta de seguridad no permitida.');
  };
}
