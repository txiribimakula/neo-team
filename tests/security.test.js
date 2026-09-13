import test from 'node:test';
import assert from 'node:assert/strict';
import { auditGroup, permissionRows, tokenScope } from '../server/security.js';
import { securityReader } from '../server/security-reader.js';
import { permissionsView, resetPermissionFilters } from '../dist/permissions.js';
const projectId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const namespace = { namespaceId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'Git', actions: [{ name: 'Read', bit: 1 }, { name: 'Write', bit: 2 }, { name: 'High', bit: 2147483648 }] };
const root = { id: 'root-id', descriptor: 'legacy-root', name: 'Readers', members: ['user'], memberOf: ['legacy-parent'] };
const parent = { id: 'parent-id', descriptor: 'legacy-parent', name: 'Contributors', members: [], memberOf: ['legacy-root'] };
const catalog = { project: { id: projectId, name: 'Project' }, groups: [{ descriptor: 'graph-root', name: 'Readers', scope: 'project' }], namespaces: [namespace, { ...namespace, namespaceId: 'unavailable', name: 'Unavailable' }], coverage: [], fetchedAt: new Date().toISOString() };
async function mockCall(args) {
  if (args.action === 'identity') return args.descriptor ? [root] : args.descriptors.map(d => d === parent.descriptor ? parent : d === root.descriptor ? root : { descriptor: d, name: 'Member' });
  if (args.action === 'resources') return args.kind === 'environments' ? [{ id: '7', name: 'Production', kind: 'environments' }] : [];
  if (args.action === 'acl') {
    if (args.namespaceId === 'unavailable') throw new Error('HTTP 403');
    return [{ token: `repoV2/${projectId}/repository`, inheritPermissions: false, acesDictionary: { 'legacy-root': { allow: 1, deny: 2 }, 'legacy-parent': { allow: 2, deny: 0, extendedInfo: { inheritedAllow: 2147483648, effectiveAllow: 2147483650 } } } }, { token: 'another-project', acesDictionary: { 'legacy-parent': { allow: 1 } } }];
  }
  if (args.action === 'roles') return [{ identity: { id: parent.id }, role: { name: 'Administrator' } }, { identity: { id: 'other-group' }, role: { name: 'Reader' } }];
  throw new Error('Unexpected action');
}
test('audit follows transitive group membership without cycles, preserves conflicting sources and partial failures', async () => {
  const progress = [];
  const report = await auditGroup(mockCall, catalog, 'graph-root', p => progress.push(p));
  assert.equal(report.identities.length, 2);
  assert.equal(report.members[0].name, 'Member');
  const write = report.rows.filter(r => r.action === 'Write' && r.scope.kind === 'project');
  assert.equal(write.find(r => r.membership === 'direct').deny, true);
  assert.equal(write.find(r => r.membership === 'inherited').allow, true);
  assert.equal(report.rows.find(r => r.action === 'High' && r.membership === 'inherited').inheritedAllow, true);
  assert.ok(report.coverage.some(c => c.status === 'error' && c.message === 'HTTP 403'));
  assert.ok(report.rows.some(r => r.scope.kind === 'unresolved'));
  assert.equal(report.roles.length, 1);
  assert.equal(report.roles[0].source, parent.name);
  assert.equal(progress.at(-1).counts.namespacesRead, 2);
});
test('missing effective masks stay unknown; zero masks are not a denied access conclusion', () => {
  const rows = permissionRows(namespace, { acesDictionary: { 'legacy-root': { allow: 0, deny: 0 } } }, root, {});
  assert.ok(rows.every(r => !r.configured && r.effectiveAllow === null && r.effectiveDeny === null));
});
test('token attribution requires project or globally unique resource ID, never numeric IDs', () => {
  assert.equal(tokenScope('123', projectId, [{ id: '123' }]).kind, 'unresolved');
  assert.equal(tokenScope(`repoV2/${projectId}/123`, projectId, []).kind, 'project');
  assert.equal(tokenScope(`${projectId}x`, projectId, []).kind, 'unresolved');
});
test('reader paginates scoped identities and does not expose resource secrets', async () => {
  const urls = [];
  const reader = securityReader('organization', async () => 'test-token', async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); urls.push(url);
    let data;
    if (url.pathname.includes('/projects/')) data = { id: projectId, name: 'Project' };
    else if (url.pathname.endsWith('/identities')) {
      if (!url.searchParams.has('continuationToken')) return new Response(JSON.stringify({ value: [{ descriptor: 'one', providerDisplayName: 'One', isContainer: true }] }), { headers: { 'x-ms-continuationtoken': 'next' } });
      data = { value: [{ descriptor: 'two', providerDisplayName: 'Two', isContainer: true }] };
    } else if (url.pathname.includes('/endpoints')) data = { value: [{ id: 'endpoint', name: 'Connection', authorization: { secret: 'never-return' }, data: { secret: 'never-return' } }] };
    else data = { value: [namespace] };
    return new Response(JSON.stringify(data));
  });
  const result = await reader({ action: 'catalog', project: 'Project' });
  assert.equal(result.groups.length, 2); assert.ok(urls.some(u => u.searchParams.get('scopeId') === projectId));
  const resources = await reader({ action: 'resources', project: projectId, kind: 'endpoints' });
  assert.deepEqual(resources, [{ id: 'endpoint', name: 'Connection', kind: 'endpoints' }]);
});
test('reader refuses redirects and does not include Azure error bodies or credentials in failures', async () => {
  const reader = securityReader('organization', async () => 'sensitive', async () => new Response('sensitive detail', { status: 403 }));
  await assert.rejects(reader({ action: 'acl', namespaceId: namespace.namespaceId, descriptors: [root.descriptor] }), e => /HTTP 403/.test(e.message) && !e.message.includes('sensitive'));
});
test('cancellation escapes the audit instead of being recorded as another coverage failure', async () => {
  await assert.rejects(auditGroup(mockCall, catalog, 'graph-root', () => { throw new Error('cancelled'); }), /cancelled/);
});
test('security UI escapes group, resource, token and coverage text', async () => {
  const report = await auditGroup(mockCall, catalog, 'graph-root');
  report.group = { ...report.group, name: '<img src=x onerror=alert(1)>' };
  report.coverage.push({ name: '<script>', status: 'error', message: '<iframe>' });
  resetPermissionFilters();
  const html = permissionsView({ catalog, report }, { project: 'Project' });
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;iframe&gt;')); assert.ok(html.includes('Exportar informe'));
});

test('401 renews the token once and retries the same read without leaking credentials', async () => {
  const tokens = [], requests = [];
  const reader = securityReader('organization', async options => {
    tokens.push(options?.forceRefresh === true);
    return options?.forceRefresh ? 'fresh-token' : 'cached-token';
  }, async (url, options) => {
    requests.push({ url: url.href, authorization: options.headers.Authorization });
    return requests.length === 1 ? new Response('private server detail', { status: 401 }) : new Response(JSON.stringify({ value: [] }));
  });
  assert.deepEqual(await reader({ action: 'acl', namespaceId: namespace.namespaceId, descriptors: [root.descriptor] }), []);
  assert.deepEqual(tokens, [false, true]);
  assert.equal(requests[0].url, requests[1].url);
  assert.equal(requests[1].authorization, 'Bearer fresh-token');
});
test('persistent 401 is bounded, identifies its source and stops the audit', async () => {
  let requests = 0, refreshes = 0;
  const reader = securityReader('organization', async options => { if (options?.forceRefresh) refreshes++; return 'sensitive-token'; }, async () => {
    requests++; return new Response('sensitive body', { status: 401 });
  });
  await assert.rejects(reader({ action: 'identity', descriptor: 'group' }), error => {
    assert.equal(error.code, 'AZURE_AUTHENTICATION_REQUIRED');
    assert.match(error.message, /vssps.dev.azure.com.*identities/);
    assert.ok(!error.message.includes('sensitive')); return true;
  });
  assert.equal(requests, 2); assert.equal(refreshes, 1);
  let resources = 0;
  await assert.rejects(auditGroup(async args => {
    if (args.action === 'resources') { resources++; throw new Error('Azure HTTP 401 en dev.azure.com'); }
    return mockCall(args);
  }, catalog, 'graph-root'), /401/);
  assert.equal(resources, 1, 'does not continue through every resource and trigger repeated logins');
});
test('403 is a coverage failure and never triggers token renewal', async () => {
  const options = [];
  const reader = securityReader('organization', async option => { options.push(option); return 'token'; }, async () => new Response('', { status: 403 }));
  await assert.rejects(reader({ action: 'acl', namespaceId: namespace.namespaceId, descriptors: [root.descriptor] }), /403/);
  assert.deepEqual(options, [undefined]);
});
test('failed login during renewal is sanitized and remains recoverable as an authentication error', async () => {
  const reader = securityReader('organization', async options => {
    if (options?.forceRefresh) throw new Error('private authentication details');
    return 'token';
  }, async () => new Response('', { status: 401 }));
  await assert.rejects(reader({ action: 'identity', descriptor: 'group' }), e => {
    assert.equal(e.code, 'AZURE_AUTHENTICATION_REQUIRED');
    assert.match(e.message, /no se pudo renovar/);
    assert.ok(!e.message.includes('private')); return true;
  });
});
test('security rejection is contrasted with a project read using exactly the same renewed credential', async () => {
  const requests = [];
  const reader = securityReader('organization', async options => options?.forceRefresh ? 'fresh' : 'original', async (url, options) => {
    requests.push({ path: url.pathname, token: options.headers.Authorization });
    return url.pathname.includes('/projects/') ? new Response(JSON.stringify({ id: projectId, name: 'Project' })) : new Response('', { status: 401 });
  });
  await assert.rejects(reader({ action: 'identity', descriptor: 'group', project: 'Project' }), e => {
    assert.match(e.message, /SÍ puede leer el proyecto/);
    assert.match(e.message, /vssps.dev.azure.com/);
    assert.ok(!e.message.includes('fresh')); return true;
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[1].token, requests[2].token);
  assert.equal(requests[2].path, '/organization/_apis/projects/Project');
});

test('initial catalog reads project and scoped identities without any Graph or organization query', async () => {
  const paths = [];
  const reader = securityReader('organization', async () => 'token', async url => {
    paths.push(url.pathname);
    if (url.pathname.includes('/projects/')) return new Response(JSON.stringify({ id: projectId, name: 'Project' }));
    if (url.pathname.endsWith('/identities') && url.searchParams.get('scopeId') === projectId && url.searchParams.get('queryMembership') === 'None') return new Response(JSON.stringify({ value: [{ descriptor: 'group', providerDisplayName: 'Readers', isContainer: true }] }));
    assert.fail('Initial catalog requested organization/security data: ' + url.pathname);
  });
  const result = await reader({ action: 'catalog', project: 'Project' });
  assert.equal(paths.length, 2);
  assert.equal(result.groups[0].name, 'Readers');
  assert.equal(result.namespaces, undefined);
});
test('namespaces are discovered only when auditing a selected group, with denied reads reported as coverage', async () => {
  const { namespaces, ...minimalCatalog } = catalog;
  let discoveries = 0;
  const report = await auditGroup(async args => {
    if (args.action === 'namespaces') { discoveries++; throw new Error('Azure HTTP 403'); }
    return mockCall(args);
  }, minimalCatalog, 'graph-root');
  assert.equal(discoveries, 1);
  assert.equal(report.group.name, 'Readers');
  assert.ok(report.coverage.some(c => c.name === 'catálogo de ámbitos de seguridad' && c.status === 'error'));
  assert.equal(report.roles.length, 1, 'resource roles remain available even if namespaces cannot be read');
});
test('project group list has no organization loader and excludes older organization entries', () => {
  const html = permissionsView({ catalog: { ...catalog, groups: [...catalog.groups, { descriptor:'org-group',name:'Organization-only',scope:'other' }] } }, { project:'Project' });
  assert.ok(!html.includes('Organization-only'));
  assert.ok(!html.includes('security-other-groups'));
  assert.ok(!html.includes('security-group-scope'));
  assert.ok(html.includes('Readers'));
});
test('scoped catalog keeps custom groups and excludes users, other scopes and duplicates', async () => {
  const reader = securityReader('organization', async () => 'token', async url => new Response(JSON.stringify(url.pathname.includes('/projects/') ? { id: projectId, name:'Project' } : { value: [
    { descriptor:'custom', subjectDescriptor:'graph-custom', isContainer:true, providerDisplayName:'Custom QA', properties:{ ScopeId:{$value:projectId}, Description:{$value:'Test team'}, Account:{$value:'[Project]\\Custom QA'} } },
    { descriptor:'custom', isContainer:true },
    { descriptor:'user', isContainer:false },
    { descriptor:'foreign', isContainer:true, properties:{ScopeId:{$value:'other-project'}} },
  ] })));
  const result = await reader({ action:'catalog', project:'Project' });
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].legacyDescriptor, 'custom');
  assert.equal(result.groups[0].descriptor, 'graph-custom');
  assert.equal(result.groups[0].name, 'Custom QA');
  assert.equal(result.groups[0].description, 'Test team');
});
test('group detail resolves legacy descriptors directly, without requiring a Graph descriptor', async () => {
  const selectedCatalog = { ...catalog, groups:[{descriptor:root.descriptor,legacyDescriptor:root.descriptor,name:root.name,scope:'project'}] };
  const calls = [];
  await auditGroup(async args => {
    calls.push(args);
    if (args.action === 'identity' && args.descriptors?.[0] === root.descriptor) return [root];
    return mockCall(args);
  }, selectedCatalog, root.descriptor);
  assert.deepEqual(calls[0], {action:'identity',descriptors:[root.descriptor]});
  assert.ok(!calls.some(c => c.descriptor));
});
