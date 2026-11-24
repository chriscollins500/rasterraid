import { copyFile, mkdir, readFile } from 'node:fs/promises';

const manifest = new URL('../.openai/hosting.json', import.meta.url);
const settings = JSON.parse(await readFile(manifest, 'utf8'));
if (!settings.project_id || settings.static) throw new Error('Expected the saved Sites Worker identity.');
await Promise.all([
  mkdir(new URL('../dist/server/', import.meta.url), { recursive: true }),
  mkdir(new URL('../dist/.openai/', import.meta.url), { recursive: true }),
]);
await Promise.all([
  copyFile(manifest, new URL('../dist/.openai/hosting.json', import.meta.url)),
  copyFile(new URL('../worker/index.js', import.meta.url), new URL('../dist/server/index.js', import.meta.url)),
]);
