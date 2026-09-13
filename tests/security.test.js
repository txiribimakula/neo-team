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
test('reader paginates Graph groups and does not expose resource secrets', async () => {
  const urls = [];
  const reader = securityReader('organization', async () => 'test-token', async (url, options) => {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error'); urls.push(url);
    let data;
    if (url.pathname.includes('/projects/')) data = { id: projectId, name: 'Project' };
    else if (url.pathname.includes('/descriptors/')) data = { value: 'scope' };
    else if (url.pathname.includes('/groups')) {
      if (!url.searchParams.has('continuationToken')) return new Response(JSON.stringify({ value: [{ descriptor: 'one', displayName: 'One' }] }), { headers: { 'x-ms-continuationtoken': 'next' } });
      data = { value: [{ descriptor: 'two', displayName: 'Two' }] };
    } else if (url.pathname.includes('/endpoints')) data = { value: [{ id: 'endpoint', name: 'Connection', authorization: { secret: 'never-return' }, data: { secret: 'never-return' } }] };
    else data = { value: [namespace] };
    return new Response(JSON.stringify(data));
  });
  const result = await reader({ action: 'catalog', project: 'Project' });
  assert.equal(result.groups.length, 2); assert.ok(urls.some(u => u.searchParams.get('scopeDescriptor') === 'scope'));
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
  report.group.name = '<img src=x onerror=alert(1)>';
  report.coverage.push({ name: '<script>', status: 'error', message: '<iframe>' });
  resetPermissionFilters();
  const html = permissionsView({ catalog, report }, { project: 'Project' });
  assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;iframe&gt;')); assert.ok(html.includes('Exportar informe'));
});
