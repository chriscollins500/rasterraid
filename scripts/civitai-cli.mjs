import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, delimiter, dirname } from 'node:path';
import { promisify } from 'node:util';
import { SITE_ORIGINS } from '../src/catalog.mjs';

const run = promisify(execFile);
const command = process.platform === 'win32' ? 'civitai.exe' : 'civitai';

export async function runCivitai(cli, origin, args) {
  if (!SITE_ORIGINS.includes(origin)) throw new TypeError('Choose a supported Civitai host.');
  const env = { ...process.env, CIVITAI_BASE_URL: origin };
  if (cli && cli !== 'civitai' && cli !== command) {
    const installed = await realpath(cli);
    if (basename(installed).toLowerCase() !== command || !(await stat(installed)).isFile() || dirname(installed).includes(delimiter)) {
      throw new TypeError('Choose an installed Civitai CLI executable.');
    }
    const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
    env[key] = [dirname(installed), env[key]].filter(Boolean).join(delimiter);
  }
  const { stdout } = await run(command, ['--no-update-check', '--no-color', ...args], {
    cwd: new URL('..', import.meta.url), env, shell: false,
    timeout: 20_000, maxBuffer: 32_768, windowsHide: true,
  });
  return stdout;
}
