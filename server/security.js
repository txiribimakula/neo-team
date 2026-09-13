const lower = value => String(value || '').toLowerCase();
export const resourceKinds = ['repositories', 'builds', 'releases', 'areas', 'iterations', 'environments', 'endpoints', 'variablegroups', 'securefiles', 'queues', 'feeds'];
export const resourceLabels = { repositories: 'Repositorios', builds: 'Pipelines de compilación', releases: 'Pipelines de release', areas: 'Áreas', iterations: 'Iteraciones', environments: 'Entornos', endpoints: 'Conexiones de servicio', variablegroups: 'Grupos de variables', securefiles: 'Archivos seguros', queues: 'Colas de agentes', feeds: 'Feeds de paquetes' };
const has = (mask, bit) => (BigInt(mask || 0) & BigInt(bit)) !== 0n;
export function permissionRows(namespace, acl, identity, scope) {
  const ace = Object.entries(acl.acesDictionary || {}).find(([key, value]) => lower(value.descriptor || key) === lower(identity.descriptor))?.[1];
  if (!ace) return [];
  const ext = ace.extendedInfo || {};
  const masks = [ace.allow, ace.deny, ext.inheritedAllow, ext.inheritedDeny, ext.effectiveAllow, ext.effectiveDeny];
  return (namespace.actions || []).map(action => ({
    namespaceId: namespace.namespaceId, namespace: namespace.displayName || namespace.name, permission: action.displayName || action.name, action: action.name, bit: action.bit,
    token: acl.token, scope, source: identity.name, descriptor: identity.descriptor, membership: identity.direct ? 'direct' : 'inherited', inheritPermissions: acl.inheritPermissions,
    allow: has(ace.allow, action.bit), deny: has(ace.deny, action.bit), inheritedAllow: has(ext.inheritedAllow, action.bit), inheritedDeny: has(ext.inheritedDeny, action.bit),
    effectiveAllow: ext.effectiveAllow === undefined ? null : has(ext.effectiveAllow, action.bit), effectiveDeny: ext.effectiveDeny === undefined ? null : has(ext.effectiveDeny, action.bit),
    configured: masks.some(mask => has(mask, action.bit)),
  }));
}
export function tokenScope(token, projectId, resources, namespaceName = '') {
  const value = lower(token);
  const parts = value.split(/[^a-z0-9-]+/);
  // Only GUIDs are globally unique. Numeric build/queue IDs cannot identify a project alone.
  const numericKinds = { build: 'builds', releasemanagement: 'releases', environment: 'environments', agentqueue: 'queues' };
  const numericKind = numericKinds[lower(namespaceName)];
  const numericResource = numericKind && parts.includes(lower(projectId)) && resources.find(r => r.kind === numericKind && lower(r.id) === parts.at(-1));
  const resource = numericResource || resources.find(r => /^[a-f0-9-]{36}$/i.test(r.id) && parts.includes(lower(r.id)));
  return resource ? { kind: 'project', label: `${resourceLabels[resource.kind]} · ${resource.name}` } : parts.includes(lower(projectId)) ? { kind: 'project', label: 'Proyecto' } : { kind: 'unresolved', label: 'Organización u otro ámbito · sin atribuir al proyecto' };
}
export async function auditGroup(call, catalog, descriptor, progress = () => {}) {
  const group = catalog.groups.find(g => g.descriptor === descriptor);
  if (!group) throw new Error('El grupo no está en el catálogo del proyecto. Actualiza los grupos.');
  const report = { group, project: catalog.project, startedAt: new Date().toISOString(), identities: [], members: [], rows: [], roles: [], feedViews: [], resources: [], coverage: [...catalog.coverage], raw: [] };
  const counts = { namespacesRead: 0, namespaceTotal: catalog.namespaces.length, grants: 0, resources: 0, warnings: 0 };
  const emit = message => progress({ phase: 'security', message, counts: { ...counts } });
  async function attempt(name, fn) {
    emit(`Consultando ${name}…`);
    try { const result = await fn(); report.coverage.push({ name, status: 'ok', count: Array.isArray(result) ? result.length : undefined }); return result; }
    catch (error) { counts.warnings++; report.coverage.push({ name, status: 'error', message: error.message }); return null; }
  }
  emit(`Resolviendo el grupo ${group.name} y sus herencias…`);
  const root = (await call({ action: 'identity', descriptor }))[0];
  if (!root?.descriptor) throw new Error('No se pudo resolver la identidad de este grupo.');
  const queue = [{ ...root, direct: true }], seen = new Set();
  while (queue.length) {
    const identity = queue.shift();
    if (seen.has(lower(identity.descriptor))) continue;
    seen.add(lower(identity.descriptor)); report.identities.push(identity);
    for (const parent of identity.memberOf) {
      if (seen.has(lower(parent))) continue;
      const resolved = await attempt(`herencia de ${identity.name}`, () => call({ action: 'identity', descriptors: [parent] }));
      if (resolved?.length) queue.push(...resolved.map(i => ({ ...i, direct: false })));
      else if (resolved) report.coverage.push({ name: `Herencia ${parent}`, status: 'error', message: 'Azure no devolvió la identidad.' });
    }
  }
  for (let index = 0; index < root.members.length; index += 20) {
    const members = root.members.slice(index, index + 20);
    const resolved = await attempt('miembros directos', () => call({ action: 'identity', descriptors: members }));
    for (const member of members) report.members.push(resolved?.find(i => lower(i.descriptor) === lower(member)) || { descriptor: member, name: member, unresolved: true });
  }
  for (const kind of resourceKinds) {
    const resources = await attempt(resourceLabels[kind], () => call({ action: 'resources', project: catalog.project.id, kind }));
    report.resources.push(...resources || []); counts.resources = report.resources.length;
  }
  for (const namespace of catalog.namespaces) {
    const name = namespace.displayName || namespace.name;
    // Small descriptor batches keep URLs within proxy limits; raw responses retain each source.
    for (let index = 0; index < report.identities.length; index += 10) {
      const identities = report.identities.slice(index, index + 10);
      const acls = await attempt(`permisos de ${name}`, () => call({ action: 'acl', namespaceId: namespace.namespaceId, descriptors: identities.map(i => i.descriptor) }));
      for (const acl of acls || []) {
        const scope = tokenScope(acl.token, catalog.project.id, report.resources, namespace.name);
        report.raw.push({ namespace, acl, scope });
        for (const identity of identities) report.rows.push(...permissionRows(namespace, acl, identity, scope));
      }
    }
    counts.namespacesRead++; counts.grants = report.rows.filter(r => r.configured).length;
  }
  for (const resource of report.resources.filter(r => ['environments', 'endpoints', 'feeds'].includes(r.kind))) {
    const feed = resource.kind === 'feeds';
    const assignments = await attempt(`roles de ${resourceLabels[resource.kind]} · ${resource.name}`, () => call({ action: feed ? 'feedPermissions' : 'roles', project: catalog.project.id, resourceId: resource.id, kind: resource.kind }));
    for (const assignment of assignments || []) {
      const assignmentId = assignment.identity?.id || assignment.identityId;
      const identityDescriptor = typeof assignment.identityDescriptor === 'object' && assignment.identityDescriptor ? `${assignment.identityDescriptor.identityType};${assignment.identityDescriptor.identifier}` : assignment.identityDescriptor;
      const source = report.identities.find(i => (assignmentId && lower(i.id) === lower(assignmentId)) || (identityDescriptor && [i.descriptor, i.subjectDescriptor].some(d => lower(d) === lower(identityDescriptor))));
      if (source) report.roles.push({ resource, source: source.name, membership: source.direct ? 'direct' : 'inherited', assignment });
    }
    if (feed) {
      const views = await attempt(`visibilidad de vistas · ${resource.name}`, () => call({ action: 'feedViews', project: catalog.project.id, resourceId: resource.id }));
      report.feedViews.push(...(views || []).map(view => ({ ...view, feed: resource.name })));
    }
  }
  report.coverage.push(
    { name: 'Autorizaciones y checks de pipelines', status: 'partial', message: 'Se leen ACL y roles de recursos. No se evalúan las autorizaciones de cada pipeline, sus aprobaciones o checks de ejecución.' },
    { name: 'Grupos de Microsoft Entra y acceso de usuarios', status: 'partial', message: 'Se muestran las pertenencias publicadas por Azure DevOps. No se expande el directorio Entra ni se comprueban licencias o excepciones de administradores.' },
    { name: 'Recursos de organización y extensiones', status: 'partial', message: 'Se consultan todos los namespaces anunciados. Los inventarios se limitan al proyecto; pueden faltar feeds o pools de organización y la seguridad propia de extensiones.' },
  );
  report.coverage.push({ name: 'Límites de la evaluación', status: 'partial', message: 'Las ACL y los roles consultados no equivalen a una comprobación de acceso de cada usuario. No se evalúan licencias, pertenencia interna de grupos Entra, excepciones de administradores, autorizaciones y checks de pipelines, recursos no visibles para tu cuenta ni seguridad propia de extensiones. Los tokens sin resolver se conservan por separado; pueden afectar al proyecto desde la organización o pertenecer a otros proyectos. Las vistas de feeds pueden ampliar el acceso.' });
  report.completedAt = new Date().toISOString();
  emit('Consulta terminada. Preparando el informe y su cobertura.');
  return report;
}
