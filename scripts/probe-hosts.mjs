import { SITE_ORIGINS } from '../src/catalog.mjs';
import { runHostProbe } from '../src/probe.mjs';
import { mintProbeToken } from './civitai-probe-token.mjs';

const cli = process.argv[2];

if (!cli) {
  console.error('Pass the installed Civitai CLI path as the only argument.');
  process.exitCode = 2;
} else {
  const hosts = [];
  for (const origin of SITE_ORIGINS) {
    const { token, ...credential } = await mintProbeToken(cli, origin);
    const routes = await runHostProbe(origin, { token, headerProbe: true });
    hosts.push({ origin, ...credential, routes });
  }
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), transport: 'cli development token and Node HTTP, opaque-origin header', hosts }, null, 2));
}
