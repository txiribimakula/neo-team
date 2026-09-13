// Tokens live only inside the MCP process. A rejected token must not be reused,
// even if its nominal expiry date is still in the future (revocation, CA, etc.).
// onEvent reports when a request waits for authentication; cached tokens are silent.
export function createCachedTokenProvider(createAuthenticator, now = Date.now, onEvent = () => {}) {
  let authenticator, cachedToken, refreshAt = 0;
  return async (options = {}) => {
    if (options.forceRefresh === true) {
      cachedToken = undefined;
      refreshAt = 0;
      authenticator = undefined;
    }
    if (cachedToken && now() < refreshAt) return cachedToken;
    const started = now();
    onEvent({ type: 'authenticating' });
    let token;
    try {
      authenticator ??= await createAuthenticator(options);
      token = await authenticator();
    } catch (error) {
      onEvent({ type: 'failed', ms: now() - started });
      throw error;
    }
    onEvent({ type: 'authenticated', ms: now() - started });
    let expires = now() + 40 * 60000;
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      if (Number.isFinite(payload.exp)) expires = Math.min(expires, payload.exp * 1000 - 120000);
    } catch { /* Opaque tokens are retained for at most 40 minutes. */ }
    cachedToken = token;
    refreshAt = expires;
    return token;
  };
}
