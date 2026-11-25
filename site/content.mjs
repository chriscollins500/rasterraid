export const site = {
  name: 'RasterRaid',
  repository: 'https://github.com/chriscollins500/rasterraid',
  canonical: 'https://chriscollins500.github.io/rasterraid/',
  version: '0.0.4',
  developerVersion: '0.0.6',
  checked: '2026-11-24',
  previews: { com: 'https://civitai.com/apps/dev/rasterraid', red: 'https://civitai.red/apps/dev/rasterraid' },
};

const coverageGroups = [
  ['Models and media', [
    ['Models, LoRAs and checkpoints', 'Search in RasterRaid', 'Filter by Civitai model family, type, creator and download access. Inspect exact releases and example pictures.'],
    ['Workflows and files', 'Search and open on Civitai', 'Resolve exact versions, files, AIR addresses and hashes. Ask Civitai to read an eligible workflow graph or open the release.'],
    ['Gallery images', 'Search in RasterRaid', 'Search by description, tag, creator, exact release, link or visual reference. Browse the returned pictures.'],
    ['Videos', 'Search in RasterRaid', 'Play eligible clips and compare short sections by appearance, motion or sound.'],
    ['Audio and music', 'Search in RasterRaid', 'Find audio models and playable public examples. Compare eligible excerpts by acoustic traits.'],
    ['3D assets', 'Search and open on Civitai', 'Find public 3D collections. Individual assets and interactive previews open in the Civitai 3D gallery.'],
    ['Posts', 'Search in RasterRaid', 'Find published posts and show eligible picture previews.'],
    ['Tags and topics', 'Search and open on Civitai', 'Find catalog tags, sample topic pictures and open the broader native feeds.'],
  ]],
  ['People, guides and tools', [
    ['Articles and guides', 'Search in RasterRaid', 'Search titles, browse eligible covers and sort supported fields. Follow a guide’s links into a cited report.'],
    ['Creators and users', 'Search in RasterRaid', 'Find public profiles by name or study one creator’s published work across several areas.'],
    ['Collections', 'Search in RasterRaid', 'Find public collections and open eligible collections into a report of pictures, posts and releases.'],
    ['Comics', 'Search in RasterRaid', 'Filter by creator and genre. Browse eligible chapters and open the Civitai reader.'],
    ['Storylines', 'Search and open on Civitai', 'Find public story references and open the original stories on Civitai.'],
    ['Tools and App Store', 'Search in RasterRaid', 'Find Civitai’s public tools and apps. Open the original listing for details.'],
    ['AI services', 'Search in RasterRaid', 'Explore the live Orchestration registry by task and media type.'],
    ['Hubs and communities', 'Search and open on Civitai', 'Find public guides, collections and shared hub links. Native Hubs handles private feeds and follows.'],
    ['Reviews and comments', 'Search and open on Civitai', 'Find the relevant model version or discussion parent. Native pages display the review text and comment threads.'],
  ]],
  ['Events and marketplaces', [
    ['Bounties', 'Search in RasterRaid', 'Find listings with public pictures and rewards where available.'],
    ['Challenges', 'Search and open on Civitai', 'Find references and open the current feed, status filters or winners page.'],
    ['Crucibles', 'Search and open on Civitai', 'Find public contest references and open the native entries and standings.'],
    ['Leaderboards', 'Open on Civitai', 'Choose a board and open the current, season or legacy view.'],
    ['Creator Services', 'Search and open on Civitai', 'Find commission guides and storefront links. Civitai shows active offers and prices.'],
    ['Buzz Marketplace', 'Search and open on Civitai', 'Find official Buzz guides and open the native marketplace.'],
    ['Auctions and prizes', 'Search and open on Civitai', 'Find public announcements. Live bids, featured lots and My Prizes open on Civitai.'],
  ]],
  ['Your Civitai account', [
    ['Saved and followed', 'Requires sign-in', 'Search eligible collections. Private collections use a separate Civitai consent prompt. Full followed feeds open on Civitai.'],
    ['Vault and downloads', 'Open on Civitai', 'Open the viewer’s native Vault and download history.'],
    ['Creation history', 'Requires sign-in', 'Use Civitai’s picture picker for selected creations or open the full generation history.'],
    ['My published models', 'Requires sign-in', 'Search releases under your own account and build a report with eligible pictures and posts.'],
    ['My public work', 'Requires sign-in', 'Preview recent public pictures, clips, audio uploads and verified posts from your account.'],
    ['Notifications and messages', 'Open on Civitai', 'Open Civitai notifications or go to Civitai to use Chat.'],
    ['Deep Search history', 'Requires sign-in', 'Reopen eligible RasterRaid runs, copy receipts and load available notes.'],
  ]],
];

const sectionHeading = (id, title) => `<h2 id="${id}">${title}</h2>`;
const supportLink = `${site.repository}/issues/new/choose`;
const previewLinks = `<div class="actions"><a class="button secondary" href="${site.previews.com}">Civitai.com preview</a><a class="button secondary" href="${site.previews.red}">Civitai.red preview</a></div>`;
const coverageCount = coverageGroups.reduce((total, [, rows]) => total + rows.length, 0);
const coverageMethods = [...new Set(coverageGroups.flatMap(([, rows]) => rows.map(([, method]) => method)))];
const coverageTable = coverageGroups.map(([group, rows]) => `<section class="coverage-group" data-coverage-group>
  ${sectionHeading(group.toLowerCase().match(/[a-z0-9]+/gu).join('-'), group)}
  <dl class="coverage-list">${rows.map(([title, method, description]) => `<div class="coverage-row" data-coverage-row data-method="${method}">
    <dt>${title}</dt><dd><span class="coverage-method">${method}</span><p>${description}</p></dd>
  </div>`).join('')}</dl>
</section>`).join('');

export const pages = [
  { slug: '', name: 'Home', title: 'Find the look. Follow the trail.', description: 'RasterRaid is a native Civitai search app for models, pictures, clips, guides and the links between them.', body: `
<section class="front-hero" aria-labelledby="hero-title">
  <div class="hero page-width">
    <div class="hero-copy">
      <p class="eyebrow">Civitai search and research</p>
      <h1 id="hero-title">Find the look.<em>Follow the trail.</em></h1>
      <p class="intro">Search Civitai models, pictures, clips, music and guides. Follow the work you like back to the exact releases and creators behind it.</p>
      <div class="actions"><a class="button primary" href="{{root}}guide/">Get started <span aria-hidden="true">→</span></a><a class="button secondary" href="#app-preview">See RasterRaid in action</a></div>
      <a class="release-link" href="{{root}}releases/">Developer preview ${site.version} <span aria-hidden="true">↗</span></a>
    </div>
    <div class="hero-art" aria-hidden="true"><img src="{{root}}assets/rasterraid-hero.webp" alt="" width="1536" height="1024" fetchpriority="high"></div>
  </div>
</section>
<section class="page-width home-paths" aria-labelledby="start-path">
  <h2 id="start-path">Start with what you have</h2>
  <div class="card-grid">
    <a class="path-card" href="{{root}}guide/#search-a-brief"><span class="path-icon type-icon" aria-hidden="true">Aa</span><strong>A few words</strong><span class="path-detail">Describe a look or enter a model name. Refine the results with Civitai’s filters.</span><span class="path-arrow" aria-hidden="true">↗</span></a>
    <a class="path-card" href="{{root}}guide/#search-a-picture"><span class="path-icon picture-icon" aria-hidden="true"></span><strong>A picture or clip</strong><span class="path-detail">Match a palette, a visual detail or a moment in a video.</span><span class="path-arrow" aria-hidden="true">↗</span></a>
    <a class="path-card" href="{{root}}guide/#search-a-link"><span class="path-icon link-icon" aria-hidden="true">↗</span><strong>An exact link</strong><span class="path-detail">Open the item, see its recorded model versions and follow related sources.</span><span class="path-arrow" aria-hidden="true">↗</span></a>
  </div>
</section>
<section class="product-section" id="app-preview" aria-labelledby="product-title">
  <div class="page-width product-layout">
    <div class="product-copy">
      <h2 id="product-title">One search.<br>More ways in.</h2>
      <p>Start free. Compare exact model releases, build a report with source links and keep the results you want to revisit.</p>
      <p>Deep Search shows a live Buzz estimate, with the app author fee, before you choose whether to run it.</p>
      <div class="actions"><a class="button primary" href="{{root}}deep-search/">Explore Deep Search <span aria-hidden="true">→</span></a><a class="text-link" href="{{root}}workspace/">See Workspace</a></div>
    </div>
    <figure class="app-preview">
      <img src="{{root}}assets/rasterraid-preview.png" alt="RasterRaid’s search page with a picture upload option and examples for Linocut, ComfyUI guides and a story project." width="1280" height="820" loading="lazy">
      <figcaption>RasterRaid ${site.version} search interface <a href="{{root}}assets/rasterraid-preview.png">Open full-size image <span aria-hidden="true">↗</span></a></figcaption>
    </figure>
  </div>
</section>
<section class="page-width home-close"><div><h2>${coverageCount} ways to search Civitai</h2><p>See what RasterRaid can find, which areas use your Civitai sign-in and where the wider search opens on Civitai.</p></div><a class="button secondary" href="{{root}}coverage/">Browse coverage <span aria-hidden="true">→</span></a></section>` },
  { slug: 'guide', name: 'Guide', title: 'Get started with RasterRaid', description: 'Start a Civitai search from a brief, picture, or exact link and follow the results into a report.', body: `
<aside class="callout"><strong>Opening the preview</strong><p>RasterRaid runs inside Civitai. Developer previews are available to the app author. Sign in on the same domain as the preview you open.</p>${previewLinks}<p><a href="{{root}}releases/">Check release availability</a></p></aside>
${sectionHeading('search-a-brief', 'Search from a few words')}
<ol><li>Type a model name, describe what you’re looking for, or select an example.</li><li>Use <strong>Search areas</strong> to focus on models, pictures, clips, guides or another part of Civitai.</li><li>Open <strong>Filter &amp; sort</strong> for choices appropriate to that area. Search again when you’re ready.</li></ol>
<p>In current source builds, <strong>Check model filters</strong> appears when a filtered model search returns few results. It samples one filter change at a time. Choose a change to search again, or return to the original filters.</p>
<div class="examples"><p>Try <code>DreamShaper 8</code>, <code>pictures of ginger cats in a rainy window</code>, or <code>guides for ComfyUI workflows</code>.</p></div>
${sectionHeading('search-a-picture', 'Search from a picture or clip')}
<p>Choose <strong>Add a picture</strong> or paste a public Civitai media link. In the visual comparison, focus on the whole picture or a selected detail. Choose the palette, lighting, layout or texture you want to match or avoid. Eligible clip results open close to the matched moment.</p>
<p>In the ${site.developerVersion} developer prerelease, <strong>Find the same subject → Compare on this device</strong> compares up to six eligible public previews. Combine up to four references and choose which subjects to match or avoid. The first comparison downloads about 78–81 MB of model files. It uses 0 Buzz, and pictures from your device stay in your browser.</p>
${sectionHeading('search-a-link', 'Follow an exact link')}
<p>Paste a Civitai model, picture, clip, post, article or collection link. An exact model version gives you its own examples and file details. A Civitai model download link can identify an exact version or file in the catalog. <strong>Check recorded settings</strong> shows the references Civitai recorded for a picture or clip. Two media links can open a side-by-side settings comparison.</p>
${sectionHeading('compare-and-report', 'Compare, refine and report')}
<p>Choose <strong>Compare</strong> on up to three model releases, then <strong>Compare free</strong>. See their base-model families, published file details and sample pictures together. <strong>Build a free report</strong> combines selected sources, such as model releases, media and articles, and links to the evidence. Choose <strong>Copy report</strong> for a Markdown version.</p>
<p><a href="{{root}}workspace/">Save your search or picks</a> · <a href="{{root}}deep-search/">Get live Deep Search quotes</a></p>` },
  { slug: 'coverage', name: 'Coverage', title: 'What RasterRaid can search', description: 'Browse all RasterRaid search areas and see which results open on Civitai or require sign-in.', body: `
<p>Both domains have been checked with the current developer build. The catalog you see depends on your Civitai account, browsing settings and the host’s available routes. For some areas RasterRaid finds the relevant listing, then opens Civitai’s full feed.</p>
<div class="coverage-controls" id="coverage-controls" hidden>
  <div><label for="coverage-filter">Filter search areas</label><input id="coverage-filter" type="search" placeholder="Try audio, auctions or downloads" autocomplete="off"></div>
  <div><label for="coverage-method">Access</label><select id="coverage-method"><option value="">All access types</option>${coverageMethods.map(method => `<option>${method}</option>`).join('')}</select></div>
  <p id="coverage-status" role="status" aria-atomic="true"></p>
</div>
${coverageTable}
<p>Filters and sorts depend on the chosen area. Model families and model types refresh from Civitai’s current public list. <a href="{{root}}guide/#search-a-brief">Learn how to refine a search</a>.</p>` },
  { slug: 'deep-search', name: 'Deep Search', title: 'Deep Search and Buzz', description: 'Learn what each Deep Search option checks, how live estimates work, and how to recover a receipt.', body: `
<p>Search, compare and build reports for free. Open <strong>Deep Search</strong> on a result to price additional work. The available comparisons depend on the selected evidence.</p>
${sectionHeading('options', 'What can a closer look check?')}
<dl class="feature-list"><div><dt>Compare the picks</dt><dd>Compare exact releases using descriptions and catalog details.</dd></div><div><dt>Check compatibility</dt><dd>Check which picks fit the family and requirements you selected.</dd></div><div><dt>Compare the pictures</dt><dd>Check catalog fit and analyze the exact example pictures.</dd></div><div><dt>Find the closest look</dt><dd>Compare the resemblance of selected previews and keep the catalog sources alongside the ranking.</dd></div></dl>
<p>Eligible reports can also quote a transcript, a music description, a sampled video frame or a synthesis of completed research.</p>
${sectionHeading('estimate', 'Read a live estimate')}
<ol><li>Pick your results and choose <strong>Get live quotes</strong>. Civitai may ask you to grant AI access for pricing.</li><li>Review the total in Buzz and any itemized app author fee. Pricing uses 0 Buzz.</li><li>When paid execution is available, <strong>Review run</strong> opens the exact estimate. Confirm to start. If the total or fee changes before submission, review the new estimate and confirm again.</li></ol>
<aside class="callout"><strong>Verified Linocut example</strong><p>The developer previews returned 3, 6, 6 and 7 Buzz for the four options above. Each included a 0 Buzz author fee in the author session. Civitai quotes your picks using your own session and eligible balance.</p></aside>
<p>Civitai chooses the eligible Blue, Green or Yellow Buzz balance and calculates the final charge at submission. The current developer previews show estimates. Published execution uses a private Civitai receipt before a run can start.</p>
${sectionHeading('recover', 'Recover a result or receipt')}
<p>Open <strong>Workspace → Deep Search history</strong> to find a RasterRaid run by status or workflow ID. <strong>Copy receipt</strong> keeps the available estimate, fee and reported cost. If a reply was interrupted, use <strong>Find original run</strong> first. That lookup uses 0 Buzz. A separately confirmed retry uses the original operation ID.</p>
<p><a href="{{root}}privacy/">See what the app stores</a> · <a href="https://developer.civitai.com/apps/guide/workflows.md">Civitai workflow reference</a></p>` },
  { slug: 'workspace', name: 'Workspace', title: 'Keep the work you want to reuse', description: 'Save searches, exact model picks, report comparisons and local setup checks in RasterRaid’s Workspace.', body: `
${sectionHeading('save', 'Save a search or shortlist')}
<p>Open <strong>Workspace</strong>, enter a name and choose <strong>Save current search</strong> or <strong>Save model picks</strong>. Reopening a shortlist checks access again and keeps eligible exact version and file identities. Recent public searches can also be reopened in the current tab.</p>
<p>In the ${site.developerVersion} developer prerelease, signed-in viewers can choose <strong>Find my public work</strong> to see recent pictures, clips, audio and verified posts. Enter a topic to filter this sample by published titles, descriptions or tags. Open your Civitai profile to browse older uploads.</p>
${sectionHeading('files', 'Check models and workflows from your setup')}
<p>Under <strong>Files &amp; setup</strong>, choose an existing ComfyUI workflow or select model files to verify their full SHA-256 checksums. RasterRaid can read supported CiviScribe sidecars and Civitai Metadata Studio exports. Matches link to the exact Civitai version or file. Several listings can share a checksum, so RasterRaid shows the matches for you to review.</p>
<p>From an eligible public picture or clip, choose <strong>Check recorded settings → Compare with my setup</strong> to compare its recorded references with your local profile.</p>
${sectionHeading('reports', 'Keep or compare a report')}
<p>Save a free report for comparison with a fresh search. Reopen ordinary saved catalog searches to see changes in the checked results. For a completed Deep Search run, <strong>Save report file</strong> keeps the captured notes, sources and available prices. Open it from <strong>Deep Search history</strong> in its original Civitai account and site.</p>
${sectionHeading('backup', 'Back up, restore or personalize')}
<p>Use <strong>Back up and restore</strong> to export, import or selectively merge saved searches and shortlists. In <strong>Settings</strong>, opt into preferences for model and media ranking or restore standard ranking. The search menu lets you reorder or hide shortcuts.</p>
<p><a href="{{root}}privacy/#storage">Read about storage and exports</a></p>` },
  { slug: 'privacy', name: 'Privacy', title: 'Privacy and permissions', description: 'Understand what RasterRaid and Civitai receive, what stays in your browser, and how you control saved data.', body: `
${sectionHeading('website', 'This documentation site')}
<p>These pages are hosted by GitHub Pages. The site renders documentation and filters the coverage list in your browser. GitHub handles requests to the site and any issues you choose to open. <a href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement">GitHub’s privacy statement</a>.</p>
${sectionHeading('civitai', 'Searches and Civitai access')}
<p>Search terms, allowed filters and exact IDs are sent to Civitai to resolve results. Civitai provides the account, browsing permissions and content previews. The public filter feed supplies Civitai filter names. The app can request AI access for quotes or runs, and it requests private collection access separately when you ask to include those collections.</p>
${sectionHeading('local', 'Files you choose')}
<p>Local pictures, workflow graphs and model files are read in your browser. A catalog check may send extracted Civitai IDs, model filenames or checksums. Deep Search quotes identify the public evidence selected for that analysis. Local visual references can guide a match on your device.</p>
${sectionHeading('storage', 'Saved workspace and receipts')}
<p>When enabled for the published app, Civitai’s private document store holds the viewer’s saved searches, picks, settings and run records. Preview workspace changes can be kept in the current session. Report and backup downloads are files you control. Clear recent searches or preferences in Workspace and use <strong>Account settings → Security &amp; Apps → App storage</strong> on Civitai to manage production app data.</p>
<p><a href="https://developer.civitai.com/apps/guide/storage.md#user-controls">Civitai’s storage controls</a> · <a href="{{root}}support/">Get help with RasterRaid</a></p>` },
  { slug: 'releases', name: 'Releases', title: 'Releases and current availability', description: 'Check the current RasterRaid developer preview and what has been verified on civitai.com and civitai.red.', body: `
<aside class="callout release-state"><p class="eyebrow">${site.version} · Civitai review</p><h2>Developer previews on both domains</h2><p>Civitai lists RasterRaid 0.0.4 as pending review. The app author can open the developer previews on both domains. The public run page requires Civitai approval and deployment.</p>${previewLinks}</aside>
${sectionHeading('candidate', site.developerVersion + ' developer prerelease')}
<ul><li>Deep Search verifies inline citations against the run’s sources and shows what broader estimates add.</li><li>Combine multiple subject references on your device or use a Civitai download link to identify a model file.</li><li>Compare changes in saved searches, find your recent public work, and check graphics memory guidance during a workflow upgrade.</li></ul>
<p>Developer-frame tests covered Chrome, Firefox, and WebKit on both domains and spent 0 Buzz. GitHub rebuilt the source ZIP and attested its provenance and runtime software inventory.</p>
<div class="actions"><a class="button primary" href="${site.repository}/releases/tag/v${site.developerVersion}">${site.developerVersion} download and verification <span aria-hidden="true">↗</span></a></div>
<p><a href="${site.repository}/releases/tag/v0.0.5">Earlier 0.0.5 prerelease</a> with guest media search, partial search recovery and the first on-device subject comparison.</p>
${sectionHeading('audit', '0.0.4 developer audit')}
<p>The November 24 audit exercised 39 search areas on each domain, including picture previews, video and music playback, free reports, workspace imports, live estimates, and older workflow receipts.</p>
<ul><li>Search pauses for review when Civitai retires a selected sort or time period as you apply filters.</li><li>The free comparison, search-area, and shortcut dialogs close with keyboard or pointer controls inside Civitai’s frame.</li><li>Deep Search uses the selected previews for image descriptions and visual ranking. Audio reports extract the soundtrack of a video before describing it.</li></ul>
<p>The developer build passed 304 tests and 186 automated accessibility scans across Chrome, Firefox, and WebKit. Browser asset SHA-256 <code class="digest">d57bca37ada4008ddf9ccce4efc4f081f6b8b06936acccc94b6099e175cca26b</code>.</p>
${sectionHeading('latest', 'Signed 0.0.4 archive')}
<p>The published GitHub archive preserves the earlier build and its verification record.</p>
<ul><li>One search field for text, links and picture references, with live model filters and configurable shortcuts.</li><li>Free reports that connect exact releases with published examples, posts, guides and creator profiles.</li><li>Visual, motion and sound comparisons, plus local metadata and workflow checks.</li><li>Four itemized Linocut quotes on each developer preview and a tested confirmation and receipt-recovery flow for the published app.</li></ul>
<p>Checked on <time datetime="${site.checked}">November 24, 2026</time>. The archived source rebuilt 96 browser assets and passed 162 automated accessibility scans across Chrome, Firefox, and WebKit.</p>
<p>Source archive SHA-256 <code class="digest">81d24a913e0eb1dfdc7a08f4e19ebd2ec58b2d0e83781f6abfccdfb999c28661</code>.</p>
${sectionHeading('signatures', 'Verify the signed release')}
<p>GitHub reproduced the published source archive byte for byte. Its build provenance and runtime software inventory are signed. The release notes show how to check the ZIP and its signer.</p>
<div class="actions"><a class="button primary" href="${site.repository}/releases/tag/v${site.version}">Release and verification commands <span aria-hidden="true">↗</span></a></div>` },
  { slug: 'development', name: 'Development', title: 'Build and verify RasterRaid', description: 'Run the native RasterRaid source locally, exercise the zero-Buzz simulation, and rebuild the documentation.', body: `
${sectionHeading('local-app', 'Run the app locally')}
<p>Use Node.js 24 or newer. The native app uses static browser modules and has no runtime npm packages. From the repository root, build the app, run its tests and start the local example.</p>
<pre><code>npm run build
npm test
npm run verify:bundle
npm run dev -- 5188 dist --mock-deep-search</code></pre>
<p>Open <code>http://127.0.0.1:5188/mock-deep-search</code> and try the Linocut walkthrough. Simulated credits use 0 Buzz. See the repository README for Civitai’s app validation commands and <a href="{{root}}releases/">releases</a> for hosted status.</p>
${sectionHeading('documentation', 'Build the documentation')}
<p>Run <code>node site/build.mjs</code> at the repository root to regenerate <code>docs/</code>. Use <code>node site/build.mjs --check</code> to compare the committed pages and assets to their source. GitHub Pages serves the generated folder.</p>
${sectionHeading('verification', 'Repository checks')}
<p>GitHub CI runs the app tests, verifies the browser bundle and checks the generated documentation. CodeQL scans the native code. Dependabot monitors npm and GitHub Actions. Consult the repository’s Actions and Security pages for the current results.</p>
<p><a href="${site.repository}">Source repository</a> · <a href="${site.repository}/actions">Actions</a> · <a href="${site.repository}/security">Security</a></p>` },
  { slug: 'support', name: 'Support', title: 'Help with RasterRaid', description: 'Fix common preview, search and quote issues or open a GitHub issue with the details needed to reproduce it.', body: `
${sectionHeading('common', 'Common questions')}
<div class="faq"><details><summary>Why does my developer preview show 404?</summary><p>Developer previews require the app author account on that specific Civitai domain. Sign in to the correct account on <code>.com</code> or <code>.red</code> and open the preview again.</p></details>
<details><summary>Why don’t I see a result on both sites?</summary><p>Civitai sets the catalog access and browsing level for each session. Check which account and domain are active, and open <strong>Filter &amp; sort</strong> to review any constraints.</p></details>
<details><summary>What should I do if a Deep Search submission was interrupted?</summary><p>Open <strong>Workspace → Deep Search history</strong> and look for the receipt or workflow ID. If the outcome is unresolved, choose <strong>Find original run</strong> before trying again.</p></details>
<details><summary>How do I find a specific file or release?</summary><p>Paste its precise Civitai version link, Civitai AIR address or full SHA-256 checksum in the search field. For a local file, use <strong>Workspace → Files &amp; setup → Identify model files</strong>.</p></details></div>
${sectionHeading('report', 'Report a bug or suggest an improvement')}
<p>Include the RasterRaid version, Civitai domain, search area, steps and what you expected to see. An example public link is helpful. GitHub issues are public, so leave private searches, account details, tokens and Buzz balances out of the report.</p>
<div class="actions"><a class="button primary" href="${supportLink}">Open a GitHub issue</a><a class="button secondary" href="${site.repository}/discussions">GitHub Discussions</a></div>
<p>Use <a href="${site.repository}/security/advisories/new">private vulnerability reporting</a> for a security issue.</p>` },
  { slug: '404.html', name: 'Page not found', title: 'Page not found', description: 'Return to RasterRaid or open the project guide.', body: `
<p>The address may have changed. Find the guide or return to the homepage.</p><div class="actions"><a class="button primary" href="{{root}}">Home</a><a class="button secondary" href="{{root}}guide/">Open the guide</a></div>` },
];
