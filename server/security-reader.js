// Read-only Azure REST adapter, used exclusively inside the MCP process.
const enc = encodeURIComponent;
const identityProperty = (identity, name) => {
  const value = identity.properties?.[name];
  return value && typeof value === 'object' ? value.$value : value;
};
function identityIsGroup(identity) {
  if (typeof identity.isContainer === 'boolean') return identity.isContainer;
  // Azure omits false isContainer values in user responses. SchemaClassName
  // supplies an explicit type for these responses and for trimmed groups.
  const kind = String(identityProperty(identity, 'SchemaClassName') || identity.subjectKind || '').toLowerCase();
  if (kind === 'group') return true;
  if (['user', 'serviceprincipal'].includes(kind)) return false;
  return null;
}
export function securityReader(organization, tokenProvider, fetcher = fetch) {
  return async ({ action, project, descriptor, namespaceId, descriptors, kind, resourceId }) => {
    let refreshed = false;
    async function get(host, path, query = {}) {
      const url = new URL(`https://${host}/${enc(organization)}/${path}`);
      for (const [key, value] of Object.entries({ 'api-version': '7.1', ...query })) if (value !== undefined) url.searchParams.set(key, value);
      const source = `${host} · ${path.split('_apis/').at(-1).split('/').slice(0, 2).join('/')}`;
      const send = async (token, target = url) => fetcher(target, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'X-TFS-FedAuthRedirect': 'Suppress' }, signal: AbortSignal.timeout(60000) });
      let token = await tokenProvider();
      let response = await send(token);
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await response.body?.cancel();
        try { token = await tokenProvider({ forceRefresh: true }); }
        catch { throw Object.assign(new Error(`Azure HTTP 401 en ${source}: no se pudo renovar la sesión. Reconecta o revisa el método de acceso en Configuración.`), { code: 'AZURE_AUTHENTICATION_REQUIRED' }); }
        response = await send(token);
      }
      if (!response.ok) {
        let comparison = '';
        if (response.status === 401 && project && !(host === 'dev.azure.com' && path === `_apis/projects/${enc(project)}`)) {
          // Use the very same credential against the project API. A working
          // project read distinguishes source-specific rejection from a wholly
          // invalid session; it does not prove the cause of the security denial.
          try {
            const probeUrl = new URL(`https://dev.azure.com/${enc(organization)}/_apis/projects/${enc(project)}?api-version=7.1`);
            const probe = await send(token, probeUrl);
            if (probe.ok) {
              const info = await probe.json();
              if (typeof info.id === 'string' && typeof info.name === 'string') comparison = 'La misma credencial SÍ puede leer el proyecto. El rechazo afecta a esta fuente de seguridad; iniciar sesión otra vez no garantiza resolverlo. ';
            } else {
              if (probe.status === 401) comparison = 'La misma credencial también recibe 401 al consultar el proyecto. ';
              await probe.body?.cancel();
            }
          } catch { /* Preserve the original source failure if the comparison is unavailable. */ }
        }
        throw Object.assign(new Error(`Azure HTTP ${response.status} en ${source}: ${response.status === 403 ? 'tu cuenta no puede consultar esta seguridad' : response.status === 401 ? comparison + 'Azure sigue rechazando la autenticación tras intentar renovar la sesión. Reconecta con una cuenta con acceso a la organización; si usas Azure CLI, renueva su inicio de sesión o elige Microsoft en Configuración.' : 'no se pudo consultar esta fuente'}`), { code: response.status === 401 ? 'AZURE_AUTHENTICATION_REQUIRED' : 'AZURE_SECURITY_ERROR' });
      }
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
    const dev = 'dev.azure.com', identityHost = 'vssps.dev.azure.com';
    const cleanIdentity = i => ({ id: i.id, descriptor: i.descriptor, subjectDescriptor: i.subjectDescriptor, name: i.providerDisplayName || i.customDisplayName || i.descriptor, isContainer: identityIsGroup(i), members: i.members || [], memberOf: i.memberOf || [] });
    const p = enc(project);
    if (action === 'catalog') {
      const { data: info } = await get(dev, `_apis/projects/${p}`);
      if (typeof info.id !== 'string' || !info.id) throw new Error('Azure no devolvió el ID del proyecto.');
      // Microsoft IdentityClient.read_identities_by_scope (7.1): use the core
      // project ID directly, without Graph descriptors or an organization scan.
      const scoped = await list(identityHost, '_apis/identities', { scopeId: info.id, queryMembership: 'None', 'api-version': '7.1-preview.1' });
      const groups = [], coverage = [], seen = new Set();
      const diagnostics = { received: scoped.length, resolved: 0, users: 0, otherScopes: 0, unclassified: 0, groups: 0, samples: [] };
      // Scope queries can return trimmed identities. Resolve their IDs before
      // deciding whether they represent users or groups.
      const sparse = scoped.filter(i => !i || typeof i !== 'object' || identityIsGroup(i) === null || (identityIsGroup(i) && !i.descriptor));
      const replacements = new Map();
      const identityKey = i => typeof i === 'string' ? i : i?.id || i?.descriptor;
      for (let offset = 0; offset < sparse.length; offset += 20) {
        const batch = sparse.slice(offset, offset + 20);
        const ids = batch.map(i => typeof i === 'string' ? i : i?.id).filter(id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id));
        const descriptors = batch.filter(i => typeof i === 'object' && i && !ids.includes(i.id)).map(i => i.descriptor).filter(d => typeof d === 'string' && d);
        for (const query of [ids.length ? { identityIds: ids.join(',') } : null, descriptors.length ? { descriptors: descriptors.join(',') } : null].filter(Boolean)) {
          try {
            const full = await list(identityHost, '_apis/identities', { ...query, queryMembership: 'None' });
            for (const identity of full) {
              if (!identity || typeof identity !== 'object') continue;
              if (identity.id) replacements.set(identity.id, identity);
              if (identity.descriptor) replacements.set(identity.descriptor, identity);
            }
          } catch (error) { coverage.push({ name: 'Detalle de identidades', status: 'error', message: error.message }); }
        }
      }
      for (const original of scoped) {
        const replacement = replacements.get(identityKey(original));
        if (replacement) diagnostics.resolved++;
        const identity = replacement ? { ...(typeof original === 'object' && original || {}), ...replacement, properties: { ...original?.properties, ...replacement.properties } } : original;
        if (!identity || typeof identity !== 'object') { diagnostics.unclassified++; if (diagnostics.samples.length < 5) diagnostics.samples.push({ valueType: identity === null ? 'null' : typeof identity }); continue; }
        const property = name => identityProperty(identity, name);
        const identityScope = property('LocalScopeId') || property('ScopeId');
        if (diagnostics.samples.length < 5) diagnostics.samples.push({ fields: Object.keys(identity), isContainer: identity.isContainer, schemaClassName: property('SchemaClassName'), scopeId: property('ScopeId'), localScopeId: property('LocalScopeId') });
        if (identityScope && String(identityScope).toLowerCase() !== info.id.toLowerCase()) { diagnostics.otherScopes++; continue; }
        const isGroup = identityIsGroup(identity);
        if (isGroup === null) { diagnostics.unclassified++; continue; }
        if (!isGroup) { diagnostics.users++; continue; }
        if (typeof identity.descriptor !== 'string' || !identity.descriptor) throw new Error('Azure devolvió un grupo sin identificador. La lista no se puede considerar completa.');
        if (seen.has(identity.descriptor)) continue;
        seen.add(identity.descriptor);
        groups.push({
          descriptor: identity.subjectDescriptor || identity.descriptor,
          legacyDescriptor: identity.descriptor,
          name: identity.providerDisplayName || identity.customDisplayName || property('Account') || identity.descriptor,
          principalName: property('Account') || identity.providerDisplayName,
          description: property('Description') || '', scope: 'project',
        });
      }
      diagnostics.groups = groups.length;
      const unclassified = diagnostics.unclassified;
      if (!groups.length) coverage.push({ name: 'Lista de grupos vacía', status: 'partial', message: `Azure devolvió ${diagnostics.received} identidades: ${diagnostics.users} usuarios, ${diagnostics.otherScopes} de otro ámbito y ${diagnostics.unclassified} sin clasificar. No se ha podido confirmar la lista de grupos del proyecto.` });
      if (unclassified) coverage.push({ name: 'Identidades sin tipo', status: 'partial', count: unclassified, message: `${unclassified} identidades no indicaron si son grupos o usuarios y no se han incluido. Los grupos identificados siguen disponibles.` });
      return { project: { id: info.id, name: info.name, visibility: info.visibility }, groups, coverage, diagnostics, fetchedAt: new Date().toISOString() };
    }
    if (action === 'namespaces') return list(dev, '_apis/securitynamespaces');
    if (action === 'identity') return (await list(identityHost, '_apis/identities', { ...(descriptor ? { subjectDescriptors: descriptor } : { descriptors: descriptors.join(',') }), queryMembership: 'Direct' })).map(cleanIdentity);
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
