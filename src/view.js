import { clipMatchLink, visualReferenceLink } from './visual-discovery.mjs';
import { visualRegionLabel, visualRoles } from './visual-analysis.mjs';
import { aiServiceLabel, aiServicePerformance, aiServiceReference } from './ai-services.mjs';
import { modelChoiceKey, modelDownloadLabel } from './model-access.mjs';
import { isWorkflowModel } from './published-workflow.mjs';

export const GROUPS = Object.freeze({
  models: 'Models', pictures: 'Images', gallery: 'Gallery images', videos: 'Videos',
  audio: 'Audio', audioExamples: 'Music examples', audioTools: 'Audio tools', assets3d: '3D collections',
  topics: 'Civitai tags', topicImages: 'Topic pictures', collections: 'Collections', guides: 'Articles',
  posts: 'Posts', postMedia: 'Pictures and clips', storylines: 'Storylines linked in articles',
  bounties: 'Bounties', challenges: 'Challenge links from articles',
  crucibles: 'Crucibles linked in articles', leaderboards: 'Leaderboard shortcuts',
  services: 'Service and shop links', serviceArticles: 'Articles about commissioning', marketplace: 'Official Buzz articles',
  auctions: 'Auction articles', prizes: 'Public prize announcements', users: 'Users', articles: 'Articles', tools: 'Tools',
  creators: 'Creators', tags: 'Tags', comics: 'Comics', comicChapters: 'Chapters', comicPages: 'Page previews', apps: 'App Store', aiServices: 'AI services',
  hubs: 'Shared hub links', hubGuides: 'Hub guides', communityArticles: 'Community articles', reviews: 'Model versions with review pages',
  modelDiscussions: 'Model discussions', articleDiscussions: 'Article discussions', mediaDiscussions: 'Image and post discussions',
  libraryCollections: 'Collections', libraryMedia: 'Collection previews', pickedCreations: 'Selected pictures',
});

export function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

export function sourceLink(url, label, context) {
  const link = element('a', label);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  if (context.open) link.addEventListener('click', event => {
    event.preventDefault();
    context.open(link.href);
  });
  return link;
}

export function evidenceSource(item, context, onLookup) {
  if (!aiServiceReference(item.link)) return sourceLink(item.link, item.title, context);
  if (!onLookup) return element('span', item.title);
  const button = element('button', item.title, 'chip');
  button.type = 'button';
  button.addEventListener('click', () => onLookup(item.link, 'aiServices'));
  return button;
}

function aiServiceCard(item, onLookup) {
  const card = element('article', null, 'result-card ai-service-card');
  const copy = element('div', null, 'result-copy');
  copy.append(element('span', item.category + ' · ' + aiServiceLabel(item.status), 'card-category'), element('h4', item.title));
  copy.append(element('p', item.description || 'Input and output types unlisted', 'ai-service-transformation'));
  if (item.reason && !item.detail) copy.append(element('p', item.reason));
  if (item.summary) copy.append(element('p', item.summary));
  const observations = aiServicePerformance(item);
  if (observations.length) copy.append(element('p', 'Observed by Civitai · ' + observations.join(' · '), 'ai-service-observations'));
  const details = element('details', null, 'ai-service-details');
  details.open = item.detail;
  details.append(element('summary', 'Catalog evidence'), element('p', 'Service ID'));
  details.append(element('code', item.id), element('p', 'Registry record'), element('code', item.link));
  if (item.strengths) details.append(element('p', item.strengths));
  if (item.performance?.checkedAt) details.append(element('p', 'Metrics updated ' + item.performance.checkedAt));
  if (item.parameters.length) details.append(element('p', 'Listed settings · ' + item.parameters.join(', ')));
  if (item.recipe) details.append(element('p', 'Recipe schema'), element('code', item.recipe));
  copy.append(details);
  if (onLookup && !item.detail) {
    const button = element('button', 'Check service details', 'chip');
    button.type = 'button';
    button.setAttribute('aria-label', 'Check service details for ' + item.title);
    button.addEventListener('click', () => onLookup(item.link, 'aiServices'));
    copy.append(button);
  }
  card.append(copy);
  return card;
}

function pictureFrame(items, name, context, eager = false, loading = false) {
  const frame = element('div', null, 'picture-frame');
  const fallback = element('div', loading ? 'Loading pictures…' : 'Picture unavailable', 'picture-missing');
  frame.append(fallback);
  const pictures = items.filter(item => item.preview);
  if (!pictures.length) return frame;

  let index = 0;
  const link = sourceLink(pictures[0].link, '', context);
  link.className = 'picture-link';
  const image = element('img');
  image.alt = '';
  image.loading = eager ? 'eager' : 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  link.append(image);
  frame.prepend(link);
  const first = pictures[0];
  const badge = element('span', first.video ? 'Video preview' : 'Example', 'picture-badge');
  badge.setAttribute('aria-hidden', 'true');
  if (first.id) frame.append(badge);

  const next = element('button', '', 'picture-next');
  next.type = 'button';
  if (pictures.length > 1) {
    next.addEventListener('click', () => {
      index = (index + 1) % pictures.length;
      update();
    });
    frame.append(next);
  }

  function update() {
    const item = pictures[index];
    link.href = item.link;
    link.setAttribute('aria-label', 'Open ' + (item.video ? 'video' : 'picture') + ' for ' + name + ' on Civitai');
    badge.textContent = item.badge ?? (item.video ? 'Video preview' : 'Example');
    next.textContent = (index + 1) + '/' + pictures.length + ' ›';
    next.setAttribute('aria-label', 'Next picture for ' + name + '. Showing ' + (index + 1) + ' of ' + pictures.length);
    image.hidden = false;
    fallback.hidden = true;
    image.src = item.preview;
  }

  image.addEventListener('error', () => {
    const original = pictures[index].url;
    if (original && image.src !== original) {
      image.src = original;
      return;
    }
    image.hidden = true;
    fallback.hidden = false;
    fallback.replaceChildren(sourceLink(pictures[index].link, 'Open picture on Civitai ↗', context));
  });
  update();
  return frame;
}

const modelTypes = {
  lora: 'Style add-on · LoRA', checkpoint: 'Full model · Checkpoint', controlnet: 'Pose or layout control',
  embedding: 'Prompt embedding', workflows: 'Workflow', comfyworkflows: 'ComfyUI workflow',
};

export function renderModelComparison(area, candidates, context) {
  const families = new Map();
  let known = 0;
  for (const { base } of candidates) {
    const key = modelChoiceKey(base);
    if (!key || ['other', 'unknown'].includes(key)) continue;
    known++;
    if (!families.has(key)) families.set(key, base);
  }
  const summary = candidates.length === 1 ? 'Pick one more model to compare their pictures and release details.'
    : families.size > 1 ? 'Different model families · ' + new Intl.ListFormat('en').format([...families.values()])
    : known === candidates.length ? 'These releases list the same model family.'
    : 'Civitai is missing a specific model family for one or more picks.';
  const grid = element('div', null, 'comparison-grid');
  grid.dataset.columns = candidates.length;
  for (const candidate of candidates) {
    const name = candidate.model || 'Civitai model';
    const card = element('article', null, 'comparison-card');
    card.append(pictureFrame(candidate.examples, name, context, true));
    const body = element('div', null, 'comparison-copy');
    const title = element('h3');
    title.append(sourceLink(candidate.link, name, context));
    const details = element('dl');
    const fields = [
      ['Model family', candidate.base],
      ['Type', modelTypes[modelChoiceKey(candidate.type)] ?? candidate.type],
      ['Version', candidate.version || 'Version #' + candidate.id],
      ['Creator', candidate.creator && '@' + candidate.creator],
      ['Download access', modelDownloadLabel(candidate)],
      ['File formats', [...new Set(candidate.formats)].join(', ')],
    ];
    for (const [label, value] of fields) {
      const row = element('div');
      row.append(element('dt', label), element('dd', value || 'Unlisted'));
      details.append(row);
    }
    body.append(title, details);
    card.append(body);
    grid.append(card);
  }
  area.replaceChildren(element('p', summary, 'comparison-summary'), grid);
}

function rankingFeedback(candidate, feedback, title) {
  const actions = element('div', null, 'model-feedback');
  const status = element('p');
  status.setAttribute('role', 'status');
  let current = feedback.vote(candidate);
  const buttons = [['More like this', 1], ['Less like this', -1]].map(([label, vote]) => {
    const button = element('button', label, 'chip');
    button.type = 'button';
    button.setAttribute('aria-label', label + ' · ' + title);
    button.setAttribute('aria-pressed', String(current === vote));
    button.addEventListener('click', async () => {
      const next = current === vote ? 0 : vote;
      for (const choice of buttons) choice.disabled = true;
      const saved = await feedback.save(candidate, next);
      if (saved) {
        current = next;
        buttons[0].setAttribute('aria-pressed', String(current === 1));
        buttons[1].setAttribute('aria-pressed', String(current === -1));
      }
      status.textContent = saved ? current ? 'Rating saved.' : 'Rating removed.' : 'Could not save this rating.';
      for (const choice of buttons) choice.disabled = false;
    });
    return button;
  });
  actions.append(...buttons, status);
  return actions;
}

function modelCard(candidate, context, chosen, toggle, eager, loadingDetails, feedback, onLookup, onHandoff, onWorkflow) {
  const name = candidate.model || 'Civitai model';
  const card = element('article', null, 'result-card');
  card.dataset.version = candidate.id;
  card.append(pictureFrame(candidate.examples, name, context, eager, loadingDetails));
  const copy = element('div', null, 'result-copy');
  const title = element('h4');
  title.append(sourceLink(candidate.link, name, context));
  const type = modelTypes[candidate.type.toLowerCase()] || candidate.type || 'Model';
  copy.append(element('span', type, 'card-category'), title);
  const info = [candidate.base, candidate.creator ? 'by ' + candidate.creator : '', candidate.version];
  const summary = info.filter(Boolean).join(' · ');
  if (summary) copy.append(element('p', summary));
  if (candidate.generationListed === true) copy.append(element('p', 'Listed for Civitai generation', 'model-generation'));
  if (candidate.linkedFromReportPreview) copy.append(element('p', 'Linked from a report preview'));
  const download = modelDownloadLabel(candidate);
  if (download && candidate.downloadAccess !== 'free') copy.append(element('p', download, 'model-download-access'));
  if (candidate.listingOnSale) copy.append(sourceLink(new URL('/models/' + candidate.modelId, context.origin).href, 'See sale on Civitai', context));
  if (candidate.savedFiles?.length) copy.append(element('p', 'Saved ' + (candidate.savedFiles.length === 1 ? 'file · #' : 'files · #') +
    candidate.savedFiles.map(file => file.id).join(', #')));
  if (onWorkflow && isWorkflowModel(candidate.type)) {
    const inspect = element('button', 'Inspect workflow', 'chip');
    inspect.type = 'button';
    inspect.addEventListener('click', () => onWorkflow(candidate));
    copy.append(inspect);
  }

  const facts = element('details', null, 'facts');
  facts.append(element('summary', 'Model details'));
  if (candidate.generationListed === false) facts.append(element('p', 'This release is listed as unavailable for Civitai generation.'));
  if (candidate.downloadAccess === 'free') facts.append(element('p', download));
  if (candidate.desc) facts.append(element('p', candidate.desc));
  if (candidate.matchedCatalogTerms?.length) facts.append(element('p', 'Matches your search · ' + candidate.matchedCatalogTerms.join(', ')));
  if (candidate.triggers?.length) facts.append(element('p', 'Prompt words to try · ' + candidate.triggers.join(', ')));
  if (candidate.formats.length) facts.append(element('p', 'File formats · ' + [...new Set(candidate.formats)].join(', ')));
  if (candidate.selectedFile) {
    const file = candidate.selectedFile;
    facts.append(element('p', 'File #' + file.id + (file.name ? ' · ' + file.name : '')));
    if (file.sha256) facts.append(element('p', 'SHA-256 · ' + file.sha256));
    if (file.sha256 && onHandoff) {
      const handoff = element('button', 'Use in other tools', 'chip');
      handoff.type = 'button';
      handoff.addEventListener('click', () => onHandoff(candidate, file));
      facts.append(handoff);
    }
  }
  if (candidate.savedFiles?.length > 1) {
    const files = element('ul');
    for (const file of candidate.savedFiles) files.append(element('li', ['File #' + file.id, file.name,
      file.sha256 && 'SHA-256 ' + file.sha256].filter(Boolean).join(' · ')));
    facts.append(files);
  }
  if (candidate.matchingFiles?.length) {
    facts.append(element('p', 'This SHA-256 appears on multiple files in this release.'));
    const matches = element('ul');
    for (const file of candidate.matchingFiles.slice(0, 8)) matches.append(element('li', 'File #' + file.id + ' · ' + file.name));
    facts.append(matches);
  }
  const explicit = candidate.examples.filter(item => item.recorded.includes(candidate.id)).length;
  const exampleStatus = loadingDetails ? 'Checking catalog examples…'
    : candidate.examples.length + ' catalog examples' + (explicit ? ' · ' + explicit + ' list this exact version' : '');
  facts.append(element('p', 'Version ' + candidate.id + ' · ' + exampleStatus));
  if (onLookup) {
    const explore = element('button', 'Explore this release', 'chip');
    explore.type = 'button';
    explore.addEventListener('click', () => onLookup(candidate.link, 'report', undefined, 'release'));
    facts.append(explore);
  }
  if (feedback) facts.append(rankingFeedback(candidate, feedback, [candidate.model, candidate.version].filter(Boolean).join(' · ')));
  copy.append(facts);

  const actions = element('div', null, 'card-actions');
  actions.append(sourceLink(candidate.link, 'Open model ↗', context));
  const compare = element('button', 'Compare', 'compare');
  compare.type = 'button';
  compare.dataset.pick = candidate.id;
  compare.setAttribute('aria-label', 'Compare ' + name + (candidate.version ? ' ' + candidate.version : ''));
  compare.addEventListener('click', () => toggle(candidate.id));
  paintCompare(compare, chosen.has(candidate.id));
  actions.append(compare);
  copy.append(actions);
  card.append(copy);
  return card;
}

export function paintCompare(button, selected) {
  button.setAttribute('aria-pressed', String(selected));
  button.textContent = selected ? '✓ Compare' : '+ Compare';
}

function linkCard(item, group, context, onTag, eager, onLookup) {
  const card = element('article', null, 'result-card');
  if (group === 'users') card.classList?.add('user-card');
  if (item.preview && group === 'users') {
    const link = sourceLink(item.link, '', context);
    link.className = 'user-avatar';
    link.setAttribute('aria-label', 'Open ' + item.title + ' on Civitai');
    const img = element('img');
    img.src = item.preview;
    img.alt = '';
    img.loading = eager ? 'eager' : 'lazy';
    img.addEventListener('error', () => { link.hidden = true; });
    link.append(img);
    card.append(link);
  } else if (item.preview) {
    const preview = item.source || item.previewBadge
      ? { ...item, id: item.previewId ?? item.id, link: item.source ?? item.link, badge: item.previewBadge ?? 'Article cover' }
      : item;
    card.append(pictureFrame([preview], item.sourceTitle || item.title, context, eager));
  }
  const copy = element('div', null, 'result-copy');
  const headline = element('h4');
  if (item.tag) {
    const tag = element('button', item.title + ' ↗', 'chip');
    tag.type = 'button';
    tag.addEventListener('click', () => onTag(item.tag));
    headline.append(tag);
  } else {
    headline.append(sourceLink(item.link, item.title + ' ↗', context));
  }
  if (item.category) copy.append(element('span', item.category, 'card-category'));
  if (group === 'pictures') copy.append(element('span', item.video ? 'Video' : 'Example picture', 'card-category'));
  copy.append(headline);
  if (item.description) copy.append(element('p', item.description));
  if (item.summary) copy.append(element('p', item.summary));
  if (item.source) copy.append(sourceLink(item.source, item.sourceTitle + ' ↗', context));
  if (item.legacyLink) {
    const actions = element('div', null, 'card-actions');
    const season = sourceLink(item.link, 'Season ↗', context);
    const legacy = sourceLink(item.legacyLink, 'Legacy ↗', context);
    season.setAttribute('aria-label', item.title + ' season rankings on Civitai');
    legacy.setAttribute('aria-label', item.title + ' legacy rankings on Civitai');
    actions.append(season, legacy);
    copy.append(actions);
  }
  if (item.actions?.length || (item.lookup && onLookup)) {
    const actions = element('div', null, 'card-actions');
    for (const action of item.actions ?? []) {
      const link = sourceLink(action.link, action.label + ' ↗', context);
      link.setAttribute('aria-label', action.ariaLabel ?? action.label + ' by ' + item.title + ' on Civitai');
      actions.append(link);
    }
    if (item.lookup && onLookup) {
      const button = element('button', item.lookup.label, 'chip');
      button.type = 'button';
      button.addEventListener('click', () => onLookup(item.lookup.link, item.lookup.scope, undefined, item.lookup.reportType));
      actions.append(button);
    }
    copy.append(actions);
  }
  card.append(copy);
  return card;
}

function addMediaTags(copy, records, onTag) {
  if (!records.length) return;
  const tags = element('div', null, 'gallery-tags');
  for (const tag of records.slice(0, 4)) {
    const link = element('button', tag.name, 'chip');
    link.type = 'button';
    link.setAttribute('aria-label', 'Search for ' + tag.name);
    link.addEventListener('click', () => onTag(tag));
    tags.append(link);
  }
  copy.append(tags);
}

function postCard(post, context, onTag, eager, showPreviews = true) {
  const card = element('article', null, 'result-card');
  card.dataset.postId = String(post.id);
  if (showPreviews && post.previews.length) card.append(pictureFrame(post.previews, post.title, context, eager));
  const copy = element('div', null, 'result-copy');
  const title = element('h4');
  title.append(sourceLink(post.link, post.title + ' ↗', context));
  copy.append(title);
  if (post.description) copy.append(element('p', post.description));
  if (post.summary) copy.append(element('p', post.summary));
  if (!showPreviews && post.modelVersionId) copy.append(element('p', 'Listed with model version ' + post.modelVersionId));
  addMediaTags(copy, post.tags, onTag);
  card.append(copy);
  return card;
}

function bountyCard(item, context, eager) {
  const card = element('article', null, 'result-card');
  if (item.previews.length) card.append(pictureFrame(item.previews, item.title, context, eager));
  const copy = element('div', null, 'result-copy');
  copy.append(element('span', [item.category, item.status].filter(Boolean).join(' · '), 'card-category'));
  const title = element('h4');
  title.append(sourceLink(item.link, item.title + ' ↗', context));
  copy.append(title);
  if (item.description) copy.append(element('p', item.description));
  if (item.reward !== null) copy.append(element('p', item.reward.toLocaleString() + ' Buzz reward', 'bounty-reward'));
  const when = item.status === 'Upcoming' ? item.startsAt : item.closesAt;
  const date = new Date(when);
  if (Number.isFinite(date.valueOf())) {
    const time = element('time', new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date));
    time.dateTime = when;
    const label = element('p', item.status === 'Upcoming' ? 'Opens ' : item.status === 'Open' ? 'Closes ' : 'Deadline ');
    label.append(time);
    copy.append(label);
  }
  card.append(copy);
  return card;
}

function similarButton(item, context, onLookup, scope, region) {
  const target = scope === 'videos' ? clipMatchLink(context.origin, item.id) : visualReferenceLink(context.origin, item.id);
  const action = element('button', scope === 'videos' ? 'Find similar clips' : 'Find similar pictures', 'chip');
  action.type = 'button';
  action.addEventListener('click', () => onLookup(target, scope, undefined, undefined, region));
  return action;
}

export function showVisualRegion(media, region) {
  if (!region) return media;
  const [left, top, right, bottom] = region;
  const picture = element('span', null, 'visual-region-picture');
  const outline = element('span', null, 'visual-region-outline');
  outline.setAttribute('aria-hidden', 'true');
  outline.style.inset = [top, 1 - right, 1 - bottom, left].map(edge => (edge * 100) + '%').join(' ');
  picture.append(media, outline);
  return picture;
}

function addVisualReferenceButton(item, onVisualReference) {
  const button = element('button', 'Use as visual reference', 'chip');
  button.type = 'button';
  button.addEventListener('click', () => onVisualReference(item, button));
  return button;
}

function clipFrame(item, context, eager, seconds, source = item.stream, end) {
  const frame = element('div', null, 'picture-frame video-frame');
  const video = element('video');
  video.controls = true;
  video.playsInline = true;
  video.preload = 'none';
  if (item.preview) video.poster = item.preview;
  video.setAttribute('aria-label', item.title);
  video.addEventListener('error', () => frame.replaceWith(pictureFrame([item], item.title, context, eager)), { once: true });
  const stream = new URL(source);
  if (Number.isFinite(seconds)) stream.hash = 't=' + seconds.toFixed(2) + (Number.isFinite(end) ? ',' + end.toFixed(2) : '');
  video.src = stream.href;
  frame.append(video);
  return frame;
}

function galleryCard(item, context, onTag, eager, showPost = true, onLookup, feedback, onVisualReference) {
  const card = element('article', null, 'result-card');
  card.dataset.mediaId = String(item.id);
  if (item.stream && item.audio) {
    if (item.preview) card.append(pictureFrame([item], item.title, context, eager));
    const frame = element('div', null, 'audio-frame');
    const audio = element('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.setAttribute('aria-label', 'Play ' + item.title);
    audio.src = item.stream;
    frame.append(audio);
    card.append(frame);
  } else if (item.stream) {
    const scene = item.sceneMatch;
    card.append(clipFrame(item, context, eager, scene?.start ?? item.motionMatch?.seconds ?? item.visualMatch?.seconds,
      scene?.stream ?? item.motionMatch?.stream, scene?.end));
  } else {
    card.append(pictureFrame([item], item.title, context, eager));
  }
  const copy = element('div', null, 'result-copy');
  const title = element('h4');
  title.append(sourceLink(item.link, item.title + ' ↗', context));
  if (item.category) copy.append(element('span', item.category, 'card-category'));
  copy.append(title);
  if (item.description) copy.append(element('p', item.description));
  if (item.source) copy.append(sourceLink(item.source, item.sourceTitle + ' ↗', context));
  else if (showPost && item.postId) {
    copy.append(sourceLink(new URL('/posts/' + item.postId, context.origin).href, 'Open post ↗', context));
  }
  if (item.mediaMatch || item.exampleSource) {
    const reasons = element('details', null, 'gallery-match-details');
    reasons.append(element('summary', 'Why it matched'));
    if (item.exampleSource) {
      const { title, version, link } = item.exampleSource;
      const row = element('p', 'Civitai lists this example for ');
      row.append(sourceLink(link, [title, version].filter(Boolean).join(' · ') + ' ↗', context));
      reasons.append(row);
    }
    if (item.mediaMatch?.tags.length) reasons.append(element('p', 'Tags · ' + item.mediaMatch.tags.join(', ')));
    if (item.mediaMatch?.description.length) reasons.append(element('p', 'Published description · ' + item.mediaMatch.description.join(', ')));
    copy.append(reasons);
  }
  if (item.sceneMatch || item.motionMatch || item.visualMatch || item.visualSources?.length) {
    const scene = item.sceneMatch;
    const motion = item.motionMatch;
    const match = item.visualMatch;
    const evidence = element('details', null, 'gallery-match-details');
    const time = Number.isFinite(match?.seconds) ? ' · ' + Math.floor(match.seconds / 60) + ':' + String(Math.floor(match.seconds % 60)).padStart(2, '0') : '';
    evidence.append(element('summary', item.copyMatch ? 'Possible copy' : scene ? 'Scene match · ' + scene.seconds.toFixed(1) + ' s' : motion ? 'Motion match · ' + motion.seconds.toFixed(1) + ' s'
      : match ? 'Visual match · ' + Math.round(match.score * 100) + '/100' + time : 'Catalog connection'));
    if (item.copyMatch) evidence.append(element('p', 'The brightness patterns and edges line up across most of both previews.'));
    if (scene) {
      const scores = element('ul', null, 'visual-cue-scores');
      for (const [kind, score] of Object.entries(scene.scores)) {
        scores.append(element('li', { appearance: 'Picture', motion: 'Motion', sound: 'Sound' }[kind] + ' · ' + Math.round(score * 100) + '/100'));
      }
      evidence.append(element('p', 'Excerpt ' + scene.start.toFixed(1) + '–' + scene.end.toFixed(1) + ' s · Reference near ' +
        scene.referenceSeconds.toFixed(1) + ' s'), scores);
    }
    if (motion) evidence.append(element('p', motion.direction + '. This ' + motion.span.toFixed(2) + ' s sample resembles movement near ' +
      motion.referenceSeconds.toFixed(1) + ' s in your reference clip.'));
    if (match) {
      const focus = match.cues.find(cue => cue.region && cue.polarity !== 'avoid') ?? match.cues.find(cue => cue.region);
      const region = focus?.region;
      const basis = match.frames ? match.frames + ' sampled frames' : item.video ? 'Clip preview picture' : 'Picture preview';
      if (match.cues.some(cue => cue.label)) {
        const scores = element('ul', null, 'visual-cue-scores');
        for (const cue of match.cues) {
          const role = (cue.polarity === 'avoid' ? 'Avoid ' : 'Match ') + visualRoles[cue.role].toLowerCase();
          const detail = cue.region ? ' · ' + visualRegionLabel(cue.region) : cue.regionUnavailable ? ' · whole preview' : '';
          scores.append(element('li', role + ' · ' + cue.label + ' · ' + Math.round(cue.score * 100) + '/100' + detail));
        }
        evidence.append(element('p', basis), scores);
      } else {
        evidence.append(element('p', basis + ' · ' + match.cues.map(cue => visualRoles[cue.role] + ' ' + Math.round(cue.score * 100) + '/100').join(' · ')));
      }
      if (region && (match.frame || item.preview)) {
        const picture = match.frame ?? element('img');
        if (!match.frame) {
          picture.src = item.preview;
          picture.alt = '';
          picture.loading = 'lazy';
          picture.referrerPolicy = 'no-referrer';
        }
        evidence.append(element('p', 'Matching area · ' + visualRegionLabel(region)), showVisualRegion(picture, region));
      }
    }
    if (item.visualSources?.length) evidence.append(element('p', item.visualSources.join(' · ')));
    copy.append(evidence);
  }
  addMediaTags(copy, item.tags, onTag);
  if (feedback && Array.isArray(item.preferenceTags)) {
    const rating = element('details', null, 'gallery-match-details');
    rating.append(element('summary', item.video ? 'Rate this clip' : 'Rate this picture'),
      rankingFeedback(item, feedback, item.title + ' · #' + item.id));
    copy.append(rating);
  }
  if (item.preview && !item.audio && (onLookup || onVisualReference)) {
    const actions = element('div', null, 'gallery-actions');
    const more = element('details', null, 'gallery-card-more');
    const summary = element('summary', 'More actions');
    summary.setAttribute('aria-label', 'More actions for ' + item.title + ' · #' + item.id);
    const extra = element('div', null, 'gallery-card-extra');
    if (onLookup) {
      const trace = element('button', 'Check recorded settings', 'chip');
      trace.type = 'button';
      trace.setAttribute('aria-label', 'Check recorded settings for ' + item.title + ' · #' + item.id);
      trace.addEventListener('click', () => onLookup(item.link, 'report', undefined, 'trace'));
      actions.append(similarButton(item, context, onLookup, item.video ? 'videos' : 'gallery'));
      extra.append(trace);
    }
    if (onVisualReference) extra.append(addVisualReferenceButton(item, onVisualReference));
    more.append(summary, extra);
    actions.append(more);
    copy.append(actions);
  }
  card.append(copy);
  return card;
}

export function appendResultCards(area, items, group, { context, onTag, onMediaTag, onLookup, directory, mediaFeedback, onVisualReference }) {
  const grid = area.querySelector('[data-group="' + group + '"] .result-grid');
  if (!grid) return false;
  if (directory) {
    grid.append(...items.map(item => group === 'aiServices' ? aiServiceCard(item, onLookup)
      : linkCard(item, group, context, onTag, false, onLookup)));
    return true;
  }
  const similar = group === 'gallery' || group === 'videos' ? onLookup : undefined;
  grid.append(...items.map(item => group === 'bounties' ? bountyCard(item, context, false)
    : group === 'posts' ? postCard(item, context, onMediaTag, false)
      : galleryCard(item, context, onMediaTag, false, true, similar, mediaFeedback, similar && onVisualReference)));
  return true;
}

export function reorderGalleryCards(area, group, items) {
  const grid = area.querySelector('[data-group="' + group + '"] .result-grid');
  if (!grid || grid.children.length !== items.length) return false;
  const cards = new Map(Array.from(grid.children, node => [node.dataset.mediaId, node]));
  const ordered = items.map(item => cards.get(String(item.id)));
  if (ordered.some(card => !card)) return false;
  for (const [index, card] of ordered.entries()) {
    const current = grid.children[index];
    if (card === current) continue;
    if (typeof grid.moveBefore === 'function') grid.moveBefore(card, current);
    else grid.insertBefore(card, current);
  }
  return true;
}

export function resultGroups(result) {
  const unique = new Map();
  for (const candidate of result.candidates) {
    for (const image of candidate.examples) {
      if (unique.has(image.id)) continue;
      unique.set(image.id, { ...image, title: candidate.model, description: image.creator ? 'by ' + image.creator : 'Linked to this model' });
    }
  }
  return { models: result.candidates, pictures: [...unique.values()], ...result.related };
}

export function resultGroupOrder(result) {
  const first = result.quickCatalog?.lead;
  const groups = Object.entries(GROUPS);
  return first ? [[first, GROUPS[first]], ...groups.filter(([id]) => id !== first)] : groups;
}

export function renderResults(area, result, groups, filter, {
  context, chosen, toggle, onTag, onMediaTag, onLookup, onVisualCrop, loadingDetails, feedback, mediaFeedback, onVisualReference, onHandoff, onWorkflow,
  onShowResultType,
}) {
  area.replaceChildren();
  if (result.reference && (['all', 'models', 'pictures'].includes(filter) || result.visualSearch && filter === result.gallery?.scope)) {
    const item = result.reference;
    const motion = result.target.motion === true;
    const scene = result.target.scene === true;
    const timed = motion || scene;
    const reference = element('article', null, 'result-card reference-card');
    reference.append(timed && item.stream ? clipFrame(item, context, true, undefined, (result.visualSearch.scene ?? result.visualSearch.motion)?.referenceStream)
      : pictureFrame([item], 'your reference image', context, true));
    const copy = element('div', null, 'result-copy');
    const heading = element('h3', item.video ? 'Your reference clip' : 'Your reference picture');
    const note = scene ? 'Short excerpts in this clip are the reference.' : motion ? 'Short movements in this clip are the reference.' : result.visualSearch
      ? (item.video ? 'This clip’s preview picture is the reference.' : 'This picture is the reference for the visual match.')
      : item.recorded.length || item.associated.length
      ? 'Models below are linked to this picture in Civitai’s catalog or its saved settings.'
      : 'Civitai didn’t return any model links for this picture.';
    copy.append(heading, element('p', note), sourceLink(item.link, 'Open original ↗', context));
    if (result.visualSearch && onLookup) {
      if (item.video && item.stream && !loadingDetails && result.gallery.scope === 'videos') {
        const choices = [timed ? ['Match appearance', 'appearance'] : ['Match motion', 'motion'],
          scene ? ['Match motion', 'motion'] : ['Match scene', 'scene']];
        for (const [label, mode] of choices) {
          const button = element('button', label, 'chip');
          button.type = 'button';
          if (mode === 'scene') button.title = 'Compare picture, movement, and sound together when available';
          button.addEventListener('click', () => onLookup(clipMatchLink(context.origin, item.id, mode), 'videos'));
          copy.append(button);
        }
      }
      if (item.preview) copy.append(similarButton(item, context, onLookup, result.gallery.scope === 'videos' ? 'gallery' : 'videos', result.visualSearch.region));
      if (!timed && item.preview && onVisualCrop && result.primaryCount && !loadingDetails) {
        const region = result.visualSearch.region;
        const focus = element('button', region ? 'Edit selected area' : 'Focus on a detail', 'chip');
        focus.type = 'button';
        focus.addEventListener('click', () => onVisualCrop(item, focus));
        copy.append(focus);
        if (region) copy.append(element('p', 'Selected area · ' + visualRegionLabel(region)));
      }
    }
    if (onVisualReference && item.preview && !item.audio) copy.append(addVisualReferenceButton(item, onVisualReference));
    reference.append(copy);
    area.append(reference);
  }

  for (const [id, title] of resultGroupOrder(result)) {
    const items = groups[id];
    if (!items?.length || (filter !== 'all' && filter !== id) || (filter === 'all' && id === 'pictures' && groups.models.length)) continue;
    const group = element('section', null, 'group');
    group.dataset.group = id;
    const grid = element('div', null, 'result-grid');
    const sample = result.quickCatalog?.areas.find(area => area.group === id && area.count > 0);
    const heading = element('h3', title);
    heading.tabIndex = -1;
    const shown = sample && filter === 'all'
      ? [items[0], items.slice(1).find(item => item.preview || item.previews?.length) ?? items[1]].filter(Boolean)
      : onShowResultType ? items.slice(0, 3) : items;
    const showAll = !sample && shown.length < items.length && onShowResultType;
    if (showAll || sample && onLookup) {
      const top = element('div', null, 'group-heading');
      const more = element('button', showAll ? 'View all ' + items.length + ' ↗'
        : id === 'gallery' ? 'Search the gallery' : 'Search more ' + title.toLowerCase(), 'chip');
      more.type = 'button';
      if (showAll) more.setAttribute('aria-label', 'View all ' + items.length + ' ' + title.toLowerCase());
      more.addEventListener('click', () => showAll ? onShowResultType(id) : onLookup(sample.query, sample.scope, sample.tag));
      top.append(heading, more);
      group.append(top, grid);
    } else group.append(heading, grid);
    for (const [index, item] of shown.entries()) {
      const eager = index < 3;
      if (id === 'aiServices') grid.append(aiServiceCard(item, onLookup));
      else if (id === 'bounties') grid.append(bountyCard(item, context, eager));
      else if (id === 'posts') grid.append(postCard(item, context, tag => onMediaTag(tag, id), eager, !result.exactPost));
      else if (['gallery', 'videos', 'audio', 'audioExamples', 'postMedia', 'libraryMedia'].includes(id)) {
        const similar = id === 'gallery' || id === 'videos' ? onLookup : undefined;
        grid.append(galleryCard(item, context, tag => onMediaTag(tag, id), eager, !['postMedia', 'libraryMedia'].includes(id), similar,
          result.gallery?.scope === id ? mediaFeedback : undefined, similar && onVisualReference));
      }
      else if (id === 'models') grid.append(modelCard(item, context, chosen, toggle, eager, loadingDetails, feedback,
        result.report?.releaseSample ? null : onLookup, onHandoff, onWorkflow));
      else grid.append(linkCard(item, id, context, onTag, eager, onLookup));
    }
    area.append(group);
  }
  if (area.childElementCount) return;
  if (result.library && ['ready', 'followed-needs-query'].includes(result.library.status)) return;
  const empty = element('div', null, 'empty-state');
  if (result.library) {
    const message = {
      mine: 'No collections matched this search.',
      followed: 'No followed collections on this page.',
      collection: 'Civitai has no eligible pictures or videos to preview here.',
      'access-needed': 'Open Collections on Civitai or choose which collections to share.',
      unavailable: 'Civitai could not load collections. You can still open them on Civitai.',
    }[result.library.status];
    if (message) area.append(element('p', message, 'empty-state'));
    return;
  }
  if (result.scope === 'ownedModels') {
    const [title, message] = ({
      'sign-in': ['Sign in to see your published models', 'Open RasterRaid from your signed-in Civitai account.'],
      denied: ['Civitai declined this model search', 'You can open your profile to view your published models.'],
      unverified: ['Civitai could not confirm who owns these results', 'Open your profile or try the search again.'],
      unavailable: ['Civitai model search is temporarily unavailable', 'Try again or open your profile.'],
      'wrong-reference': ['Choose a model reference', 'Use a model name, model link, or exact file SHA-256.'],
    })[result.ownerStatus] ?? (result.modelPager?.nextCursor
      ? ['No matches on this page', 'Load more models to continue through your releases.']
      : ['No published models matched', 'Try a shorter name or clear a filter.']);
    empty.append(element('h3', title), element('p', message));
    area.append(empty);
    return;
  }
  if (result.scope === 'bounties') {
    empty.append(element('h3', 'No bounties found here'),
      element('p', result.gallery?.status === 'gallery-unavailable' ? 'Civitai’s bounty search is unavailable. Try again.'
        : 'Try a shorter title, clear a filter, or browse the bounty feed on Civitai.'));
    area.append(empty);
    return;
  }
  if (result.scope === 'apps') {
    const more = result.directory?.nextCursor;
    empty.append(element('h3', result.target.kind === 'app' ? 'This listing isn’t available here' : 'No matching apps found'),
      element('p', more ? 'Load more apps to search the next batch.'
        : result.target.kind === 'app' ? 'Try opening the original listing on Civitai.'
          : 'Try an app name, a shorter phrase, or a different category.'));
    area.append(empty);
    return;
  }
  if (result.scope === 'challenges') {
    const direct = ['challenge', 'challengeEvent'].includes(result.target.kind);
    empty.append(element('h3', direct ? 'Open this challenge on Civitai' : 'No linked challenges found'),
      element('p', direct ? 'View the rules, dates, and entries on the challenge page.'
        : 'Try a phrase from a challenge announcement or use the native challenge filters below.'));
    area.append(empty);
    return;
  }
  if (result.scope === 'crucibles') {
    const direct = result.target.kind === 'crucible';
    empty.append(element('h3', direct ? 'View entries and standings on Civitai' : 'No contest links found in articles'),
      element('p', direct ? 'The contest page shows its rules, entries, and available results.'
        : 'Try the contest or series name. The Civitai feed has the full contest listings.'));
    area.append(empty);
    return;
  }
  if (result.scope === 'leaderboards') {
    const direct = result.target.kind === 'leaderboard';
    empty.append(element('h3', direct ? 'View rankings on Civitai' : 'No matching leaderboard shortcuts'),
      element('p', direct ? 'The live board opens in a new tab.'
        : 'Try a topic like Flux, Writers, or Crucible. Civitai lists every available board.'));
    area.append(empty);
    return;
  }
  if (result.scope === 'services') {
    const direct = ['service', 'serviceShop'].includes(result.target.kind);
    empty.append(element('h3', direct ? 'View details on Civitai' : 'No public articles matched this service'),
      element('p', direct ? 'Civitai displays the listing or shop and its current availability.'
        : 'Try a skill like LoRA training or music video. You can also open the full Services catalog.'));
    area.append(empty);
    return;
  }
  if (result.scope === 'marketplace') {
    empty.append(element('h3', 'No official Buzz articles matched'),
      element('p', 'Try a topic like Blue Buzz or choose How Buzz works.'));
    area.append(empty);
    return;
  }
  const directoryEmpty = {
    auctions: ['Explore Auctions on Civitai', 'The native page shows current bidding periods and featured spots.'],
    prizes: ['Browse prizes on Civitai', 'Open My Prizes to see prizes awarded to your account.'],
    users: ['No public profiles found here', 'Try a username, a user ID, or a Civitai profile link.'],
    articles: ['No public articles found here', 'Try a shorter phrase or change the article filters.'],
    tools: ['No tools found here', 'Try a tool name, company, or a different filter.'],
    comics: ['No comic previews found here', 'Try another title or open the comic on Civitai.'],
    hubs: result.target.key ? ['Open the shared image feed', 'Civitai checks whether you can view this hub.']
      : ['No hub links found', 'Try How hubs work, enter a shared hub name, or paste a Civitai hub link.'],
    topics: ['No topic matches here', 'Try a short tag like portrait or paste a Civitai tag link.'],
    communities: ['No public community results here', 'Try a collection name or a phrase like community gallery.'],
    reviews: ['No version previews here', 'Try a model name or paste a link to a specific model version.'],
    comments: result.nativeLink ? ['Open the conversation on Civitai', 'The native page shows the discussion for this link.']
      : ['No public discussions found here', 'Try a model or article name, or paste a link to the item or a comment.'],
  }[result.scope];
  if (directoryEmpty) {
    empty.append(element('h3', directoryEmpty[0]), element('p', directoryEmpty[1]));
    area.append(empty);
    return;
  }
  if (result.scope === 'storylines') {
    const direct = result.target.kind === 'storyline';
    empty.append(element('h3', direct ? 'Open this storyline' : 'No linked stories found'),
      element('p', direct ? 'Read the story and view its chapters on Civitai.'
        : 'Try a name like Face of Civitai, or open the Storylines feed to browse all available stories.'));
    area.append(empty);
    return;
  }
  if (result.scope === 'posts') {
    empty.append(element('h3', 'No public posts found here'),
      element('p', result.gallery?.status === 'gallery-unavailable' ? 'Civitai’s post results are unavailable. Try again.'
        : 'Try a shorter tag, a creator, or a direct link. You can also browse posts on Civitai.'));
    area.append(empty);
    return;
  }
  if (result.scope === 'assets3d') {
    const direct = result.target.kind === 'asset3d';
    empty.append(element('h3', direct ? 'Open this 3D asset' : 'No matching 3D collections'),
      element('p', direct ? 'Civitai opens the interactive preview on the asset page.'
        : 'Try another collection name or browse individual models on Civitai.'));
    area.append(empty);
    return;
  }
  if (result.gallery?.scope === 'audio') {
    empty.append(element('h3', 'No audio matches here'),
      element('p', result.gallery.status === 'gallery-unavailable' ? 'Civitai’s audio gallery is unavailable. Try again.'
        : 'Try a genre like Citypop, an audio model name, or a Civitai link.'));
    area.append(empty);
    return;
  }
  if (result.gallery?.suggestions?.length && onMediaTag) {
    empty.append(element('h3', 'Did you mean one of these tags?'));
    addMediaTags(empty, result.gallery.suggestions, tag => onMediaTag(tag, result.gallery.scope));
    area.append(empty);
    return;
  }
  const reason = {
    'no-tag': 'Try a shorter tag or open the full description on Civitai.',
    'tag-unavailable': 'Civitai’s tag search is unavailable. You can retry or search on Civitai.',
    'gallery-unavailable': 'Civitai’s gallery is unavailable. You can retry or open it on Civitai.',
    'model-gallery-empty': 'Civitai returned no examples from these releases with the current filters.',
    'creator-conflict': 'The search and Uploaded by name different creators. Use the same name or clear one.',
    'source-conflict': 'The Civitai source filters point to different items. Remove a source filter to continue.',
    'source-unavailable': 'Civitai couldn’t verify the selected model and version together. Open the original gallery or try again.',
    'visual-reference-unavailable': 'Choose a picture or clip that is available in your Civitai gallery.',
    'motion-reference-required': result.target.scene ? 'Choose a playable clip to match its scenes.' : 'Choose a playable clip to match its movement.',
    unsupported: 'Use a tag, @creator, image, video, post, or model link.',
  }[result.gallery?.status];
  empty.append(element('h3', result.gallery ? 'No gallery matches here' : 'No matches here'),
    element('p', result.gallery?.modelChoices?.length ? 'Choose a matching model to browse its examples.' : reason ?? (result.gallery ? 'Try a different tag or fewer search options.'
      : 'Try a shorter search, a different topic, or fewer search options.')));
  area.append(empty);
}

export function quoteCard(plan, context) {
  const card = element('article', null, 'quote-card');
  card.dataset.plan = plan.id;
  const heading = element('h3', plan.title);
  const price = element('span', '', 'quote-price');
  const fee = element('p', '', 'quote-fee');
  price.setAttribute('aria-hidden', 'true');
  fee.setAttribute('aria-hidden', 'true');
  fee.hidden = true;
  card.append(heading, price, element('p', plan.work), fee);
  if (plan.dependentInputs) card.append(element('p', 'Civitai can update this estimate after extracting the frames.', 'quote-note'));
  if (plan.inputs?.length && context) {
    const details = element('details', null, 'gallery-match-details quote-inputs');
    const list = element('ol', null, 'pick-list');
    for (const [index, item] of plan.inputs.entries()) {
      const row = element('li');
      const link = sourceLink(item.link, '', context);
      if (item.preview) {
        const preview = element('img');
        preview.src = item.preview;
        preview.alt = '';
        preview.loading = 'lazy';
        preview.referrerPolicy = 'no-referrer';
        link.append(preview);
      }
      const label = element('span', null, 'quote-input-title');
      const purpose = item.purpose ?? (index === 0 ? 'Reference' : '');
      label.append(element('span', item.title), element('small', (purpose ? purpose + ' · ' : '') + item.kind));
      link.append(label);
      row.append(link);
      list.append(row);
    }
    const picturesOnly = plan.inputs.every(item => item.preview && !['Video clip', 'Clip audio'].includes(item.kind));
    const unit = picturesOnly ? 'preview' : 'media input';
    const label = 'See ' + plan.inputs.length + ' ' + unit + (plan.inputs.length === 1 ? '' : 's') + ' used';
    const summary = element('summary', label);
    summary.setAttribute('aria-label', label + ' for ' + plan.title);
    details.append(summary, list);
    card.append(details);
  }
  return { card, heading, price, fee };
}

export function showQuote(view, quote) {
  const total = quote ? quote.total + ' Buzz' : quote === null ? 'Unavailable' : '';
  const fee = !quote ? '' : quote.authorFee === null ? 'App fee included if applicable' : 'Includes ' + quote.authorFee + ' Buzz app author fee';
  view.price.textContent = total;
  view.fee.textContent = fee;
  view.fee.hidden = !fee;
  if (total) {
    const estimate = quote ? 'Estimate ' + total : 'Estimate unavailable';
    view.heading.setAttribute('aria-label', [view.heading.textContent, estimate, fee].filter(Boolean).join('. ') + '.');
  } else view.heading.removeAttribute('aria-label');
}
