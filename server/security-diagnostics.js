// A deliberately small allowlist: never retain the token, identity claims,
// cookies, challenge claims, or Azure's full error body.
export async function securityDiagnostics(url, token, response) {
  const diagnostic = { method: 'GET', host: url.hostname, path: url.pathname, apiVersion: url.searchParams.get('api-version'), status: response.status };
  if (url.pathname.endsWith('/distributedtask/environments')) diagnostic.documentedScope = 'vso.environment_manage';
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (typeof claims.scp === 'string') diagnostic.delegatedScopes = claims.scp.split(/\s+/).filter(s => /^[a-zA-Z0-9_.-]{1,100}$/.test(s));
    diagnostic.audienceIsAzureDevOps = ['499b84ac-1321-427f-aa17-267ca6975798', 'https://app.vssps.visualstudio.com', 'https://app.vssps.visualstudio.com/'].includes(claims.aud);
  } catch { diagnostic.tokenClaimsReadable = false; }
  const challenge = response.headers.get('www-authenticate') || '';
  const challengeError = challenge.match(/\berror="(invalid_token|insufficient_scope|insufficient_claims)"/i)?.[1];
  if (challengeError) diagnostic.challengeError = challengeError.toLowerCase();
  const correlation = response.headers.get('x-vss-e2eid');
  if (correlation && /^[a-f0-9-]{36}$/i.test(correlation)) diagnostic.requestId = correlation;
  try {
    const body = await response.json();
    if (typeof body.typeKey === 'string' && /^[a-zA-Z][a-zA-Z0-9.]{0,99}$/.test(body.typeKey)) diagnostic.azureErrorType = body.typeKey;
    if (Number.isSafeInteger(body.errorCode)) diagnostic.azureErrorCode = body.errorCode;
    const tfCode = typeof body.message === 'string' && body.message.match(/\bTF\d{5,10}\b/)?.[0];
    if (tfCode) diagnostic.azureMessageCode = tfCode;
  } catch { /* HTML, empty and non-JSON failures keep only HTTP metadata. */ }
  return diagnostic;
}
