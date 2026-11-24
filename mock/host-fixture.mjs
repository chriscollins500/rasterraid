export function blockFixtureToken({ viewerId = 21, instance = 'page_fixture', blockId = 'rasterraid', scopes = [], advertised = scopes,
  maxLevel = 3, viewerLevel = maxLevel, exp = Math.floor(Date.now() / 1000) + 600 } = {}) {
  const claims = { blockId, blockInstanceId: instance, sub: viewerId === null ? 'anon' : 'user:' + viewerId,
    scopes, maxBrowsingLevel: maxLevel, viewerBrowsingLevel: viewerLevel, exp };
  const raw = 'fixture.' + Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url') + '.fixture';
  return { kind: 'block', raw, scopes: advertised, expiresAt: new Date(exp * 1000).toISOString() };
}
