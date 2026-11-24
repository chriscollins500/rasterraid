import { runCivitai } from './civitai-cli.mjs';

const browsingMask = value => Number.isInteger(value) && value >= 0 && value <= 63 ? value : null;
const scopeName = /^[a-z][a-z\d-]{0,39}(?::[a-z][a-z\d-]{0,39}){1,5}$/u;

export async function mintProbeToken(cli, origin) {
  const result = { tokenMinted: false, credential: null };
  try {
    const stdout = await runCivitai(cli, origin, ['app', 'dev-token', 'rasterraid']);
    const token = stdout.split(/\r?\n/u).map(line => line.trim()).find(line => /^[\w-]+\.[\w-]+\.[\w-]+$/u.test(line));
    if (token) {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      const scopes = Array.isArray(claims.scopes) && claims.scopes.length <= 64 &&
        claims.scopes.every(scope => typeof scope === 'string' && scopeName.test(scope)) ? [...new Set(claims.scopes)].sort() : null;
      return { token, tokenMinted: true, credential: {
        ceiling: browsingMask(claims.maxBrowsingLevel), viewerBrowsingLevel: browsingMask(claims.viewerBrowsingLevel), scopes,
        requestedSpendScope: false,
      } };
    }
  } catch (error) {
    const http = String(error.stderr ?? '').match(/\b(401|403|404|429|5\d\d)\b/u);
    result.mintFailure = { code: Number.isInteger(error.code) ? error.code : null, http: http ? Number(http[1]) : null };
  }
  return result;
}
