import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pages, site } from './content.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const output = fileURLToPath(new URL('../docs/', import.meta.url));
const checking = process.argv.includes('--check');
const basePath = new URL(site.canonical).pathname;
const navigation = ['guide', 'coverage', 'deep-search', 'workspace', 'releases'];
const secondary = ['privacy', 'development', 'support'];
const expected = new Map();
const escaped = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function route(page) {
  return page.slug === '404.html' ? page.slug : [page.slug, 'index.html'].filter(Boolean).join('/');
}

function navLink(slug, active, root) {
  const item = pages.find(page => page.slug === slug);
  assert.ok(item, 'Unknown site route ' + slug);
  return `<a href="${root}${slug}/"${slug === active ? ' aria-current="page"' : ''}>${escaped(item.name)}</a>`;
}

function render(page) {
  const home = page.slug === '';
  const missing = page.slug === '404.html';
  const root = home ? './' : missing ? basePath : '../';
  const title = home ? `${site.name} · ${page.title}` : `${page.title} · ${site.name}`;
  const canonical = new URL(home ? '' : page.slug + '/', site.canonical).href;
  const contents = page.body.replaceAll('{{root}}', root);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="${escaped(page.description)}">
  <meta name="referrer" content="strict-origin-when-cross-origin">
  <meta name="theme-color" content="#111319">
  <title>${escaped(title)}</title>
  ${missing ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escaped(title)}">
  <meta property="og:description" content="${escaped(page.description)}">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${site.canonical}assets/rasterraid-preview.png">`}
  <link rel="stylesheet" href="${root}assets/site.css">
  ${page.slug === 'coverage' ? `<script src="${root}assets/coverage.js" defer></script>` : ''}
</head>
<body${home ? ' class="home"' : ''}>
  <a class="skip" href="#main-content">Skip to content</a>
  <header class="masthead">
    <div class="masthead-inner page-width">
      <a class="wordmark" href="${root}" aria-label="${site.name} home"><span class="brand-mark" aria-hidden="true"></span><span>Raster<span>Raid</span></span></a>
      <nav class="navigation" aria-label="Main navigation">${navigation.map(slug => navLink(slug, page.slug, root)).join('')}</nav>
      <a class="repo-link" href="${site.repository}">GitHub<span aria-hidden="true"> ↗</span></a>
    </div>
  </header>
  <main id="main-content" tabindex="-1"${home ? '' : ' class="doc page-width"'}>
    ${home ? contents : `<div class="doc-heading"><h1>${escaped(page.title)}</h1></div><div class="doc-content">${contents}</div>`}
  </main>
  <footer class="footer"><div class="page-width footer-inner"><p>RasterRaid for Civitai</p><nav aria-label="Project information">${secondary.map(slug => navLink(slug, page.slug, root)).join('')}</nav></div></footer>
</body>
</html>
`.replace(/^[\t ]+$/gmu, '');
}

for (const page of pages) expected.set(route(page), Buffer.from(render(page)));
for (const file of ['site.css', 'coverage.js', 'rasterraid-preview.png']) {
  expected.set('assets/' + file, await readFile(join(dir, 'assets', file)));
}
const sitemap = pages.filter(page => page.slug !== '404.html').map(page =>
  `<url><loc>${site.canonical}${page.slug ? page.slug + '/' : ''}</loc></url>`).join('\n');
expected.set('sitemap.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemap}\n</urlset>\n`));
expected.set('.nojekyll', Buffer.alloc(0));

for (const page of pages) {
  const path = route(page);
  const address = new URL(path.endsWith('index.html') ? path.slice(0, -10) : path, site.canonical);
  const html = expected.get(path).toString();
  for (const [, reference] of html.matchAll(/\b(?:href|src)="([^"]+)"/gu)) {
    const target = new URL(reference, address);
    if (target.origin !== address.origin) continue;
    assert.ok(target.pathname.startsWith(basePath), `${path} links outside this project site`);
    const name = target.pathname.slice(basePath.length) + (target.pathname.endsWith('/') ? 'index.html' : '');
    assert.ok(expected.has(name), `${path} links to missing ${name}`);
    if (target.hash) assert.ok(expected.get(name).toString().includes(`id="${target.hash.slice(1)}"`), `${path} links to missing ${target.hash}`);
  }
}

if (checking) {
  const entries = await readdir(output, { recursive: true, withFileTypes: true });
  assert.ok(entries.every(entry => entry.isDirectory() || entry.isFile()), 'Unexpected link or special file in docs');
  const paths = entries.filter(entry => entry.isFile()).map(entry => relative(output, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
  assert.deepEqual(paths.sort(), [...expected.keys()].sort(), 'Generated documentation file list changed');
}

for (const [file, contents] of expected) {
  const path = join(output, file);
  if (checking) assert.ok(contents.equals(await readFile(path)), 'Regenerate docs to update ' + file);
  else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
}
console.log(`${checking ? 'Verified' : 'Built'} ${pages.length} RasterRaid pages and ${expected.size - pages.length} site assets.`);
