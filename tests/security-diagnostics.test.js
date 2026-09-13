import test from 'node:test';
import assert from 'node:assert/strict';
import { securityDiagnostics } from '../server/security-diagnostics.js';

test('401 diagnostic exposes only request metadata, delegated scopes and sanitized Azure error codes', async () => {
  const token = `header.${Buffer.from(JSON.stringify({ aud:'499b84ac-1321-427f-aa17-267ca6975798', scp:'vso.identity vso.work', name:'Private Name', preferred_username:'private@example.test', oid:'private-id' })).toString('base64url')}.private-signature`;
  const response = new Response(JSON.stringify({typeKey:'UnauthorizedRequestException',errorCode:0,message:`TF400813 private@example.test ${token}`,details:{secret:'secret'}}), {status:401,headers:{'www-authenticate':'Bearer error="insufficient_scope", claims="private-claims"','x-vss-e2eid':'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','set-cookie':'secret'}});
  const result=await securityDiagnostics(new URL('https://dev.azure.com/org/project/_apis/distributedtask/environments?api-version=7.1'),token,response);
  assert.equal(result.documentedScope,'vso.environment_manage');
  assert.deepEqual(result.delegatedScopes,['vso.identity','vso.work']);
  assert.equal(result.audienceIsAzureDevOps,true);
  assert.equal(result.azureMessageCode,'TF400813');
  assert.equal(result.challengeError,'insufficient_scope');
  assert.equal(result.azureErrorType,'UnauthorizedRequestException');
  assert.equal(result.requestId,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  assert.ok(!/private|secret/i.test(JSON.stringify(result)));
});
test('opaque tokens and non-JSON errors do not become diagnostic failures', async () => {
  const result=await securityDiagnostics(new URL('https://dev.azure.com/org/project/_apis/distributedtask/environments?api-version=7.1'),'opaque-secret',new Response('<html>Private error</html>',{status:401}));
  assert.equal(result.tokenClaimsReadable,false);
  assert.equal(result.status,401);
  assert.ok(!JSON.stringify(result).includes('Private'));
});
