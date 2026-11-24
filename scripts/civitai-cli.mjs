import { execFile } from 'node:child_process';
import { basename, delimiter, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SITE_ORIGINS } from '../src/catalog.mjs';

const run = promisify(execFile);
const command = process.platform === 'win32' ? 'civitai.exe' : 'civitai';

export async function runCivitai(cli, origin, args) {
  if (!SITE_ORIGINS.includes(origin)) throw new TypeError('Choose a supported Civitai host.');
  const env = { ...process.env, CIVITAI_BASE_URL: origin };
  let cwd = new URL('..', import.meta.url);
  if (cli && cli !== 'civitai' && cli !== command) {
    const installed = resolve(cli);
    const directory = dirname(installed);
    const filename = basename(installed);
    if ((process.platform === 'win32' ? filename.toLowerCase() : filename) !== command || directory.includes(delimiter)) {
      throw new TypeError('Choose an installed Civitai CLI executable.');
    }
    const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
    env[key] = directory;
    cwd = directory;
  }
  const { stdout } = await run(command, ['--no-update-check', '--no-color', ...args], {
    cwd, env, shell: false,
    timeout: 20_000, maxBuffer: 32_768, windowsHide: true,
  });
  return stdout;
}
