import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewFiles } from './assets.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
for (const route of Object.keys(previewFiles)) {
  const name = route.slice(1);
  const target = join(root, 'dist', name);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, name), target);
}
console.log('Built ' + Object.keys(previewFiles).length + ' static files in dist.');
