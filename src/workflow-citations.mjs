import { aiServiceLink, aiServiceReference } from './ai-services.mjs';
import { SITE_ORIGINS } from './catalog.mjs';

const webAddress = String.raw`(?:(?:https?|ftp):\/\/|www\.)[^\s<>\[\]()"'\x60—–…。，、！？；：（）“”‘’]+`;
const hasAddress = /(?:(?:https?|ftp):\/\/|www\.)/iu;
const citationSyntax = new RegExp(String.raw`\[([^\[\]\r\n]{1,180})\]\(<?(${webAddress})>?\)|<(${webAddress})>|(${webAddress})`, 'giu');
const catalogPage = /^\/(models|images|articles|posts|collections|comics)\/([1-9]\d{0,14})(?:\/[^/]{1,170})?\/?$/u;

function citationUrl(address) {
  if (!/^https:\/\//iu.test(address) || address.includes('\\')) return null;
  try {
    const url = new URL(address);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

function catalogIdentity(url) {
  if (!SITE_ORIGINS.includes(url.origin)) return null;
  const id = catalogPage.exec(url.pathname);
  // A different version, file, clip time or fragment is a different citation.
  return id ? '/' + id[1] + '/' + id[2] + url.search + url.hash : null;
}

export function workflowSourceLookup({ origin, sources }) {
  const exact = new Map();
  const byIdentity = new Map();
  for (const source of sources) {
    const url = citationUrl(source.link);
    if (!url || (url.origin !== origin && aiServiceLink(aiServiceReference(url.href)) !== url.href)) continue;
    exact.set(url.href, source);
    const key = catalogIdentity(url);
    if (key) {
      if (!byIdentity.has(key)) byIdentity.set(key, source);
      else if (byIdentity.get(key)?.link !== source.link) byIdentity.set(key, null);
    }
  }
  return address => {
    const url = citationUrl(address);
    return url && (exact.get(url.href) ?? byIdentity.get(catalogIdentity(url)));
  };
}

export function workflowNoteParts(note, findSource) {
  const parts = [];
  let cursor = 0;
  for (const match of note.matchAll(citationSyntax)) {
    const [raw, label, named, angle, bare] = match;
    const address = named ?? angle ?? bare;
    let source = findSource(address);
    let end = address.length;
    if (bare && !source) {
      while (end > 0 && '.,!?;:*'.includes(address[end - 1])) end--;
      if (end < address.length) source = findSource(address.slice(0, end));
    }
    if (match.index > cursor) parts.push(note.slice(cursor, match.index));
    const unverified = label && !hasAddress.test(label) ? label + ' (unverified source link)' : 'Unverified source link';
    parts.push(source ?? unverified);
    if (end < address.length) parts.push(address.slice(end));
    cursor = match.index + raw.length;
  }
  if (cursor < note.length) parts.push(note.slice(cursor));
  return parts;
}

export function workflowEvidenceText(note, findSource) {
  return workflowNoteParts(note, findSource).map(part => typeof part === 'string' ? part : part.link).join('');
}
