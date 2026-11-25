import assert from 'node:assert/strict';
import test from 'node:test';
import { expandedQuoteOptions, quoteServiceAdvisories } from '../src/quotes.mjs';
import { RESEARCH_MODEL } from '../src/research.mjs';

const step = ($type, name, input = {}) => ({ $type, name, input });
const plan = (id, title, ...steps) => ({ id, title, body: { tier: 'paid', steps } });
const price = total => ({ total, authorFee: 0 });

test('compares complete shared steps only when both options have matched estimates', () => {
  const compare = step('chatCompletion', 'compare', { model: RESEARCH_MODEL, brief: 'linocut' });
  const caption = step('mediaCaptioning', 'frame');
  const check = step('chatCompletion', 'audit', { model: RESEARCH_MODEL });
  const basic = plan('basic', 'Basic', caption, compare);
  const broader = plan('broader', 'Check the sources', caption, check, compare);
  const edited = plan('edited', 'Different evidence', caption, check, { ...compare, input: { ...compare.input, brief: 'woodcut' } });
  const reordered = plan('reordered', 'Different order', compare, caption, check);
  const equal = { title: 'Check the sources', previews: 0, difference: 0 };
  const plans = [basic, edited, reordered, broader];
  assert.deepEqual(expandedQuoteOptions(plans, [price(5), price(1), price(2), price(5)]), [equal, null, null, null]);
  assert.deepEqual(expandedQuoteOptions(plans, [price(5), price(1), price(2), price(3)]), [{ ...equal, difference: -2 }, null, null, null]);
  assert.deepEqual(expandedQuoteOptions(plans, [price(5), price(1), price(2), price(7)]), [{ ...equal, difference: 2 }, null, null, null]);
  assert.deepEqual(expandedQuoteOptions(plans, [null, price(1), price(2), price(7)]), plans.map(() => null));
  assert.deepEqual(expandedQuoteOptions(plans, [price(5), price(1), price(2)]), plans.map(() => null));
});

test('service advisories use anonymous exact service reads and only appear on affected options', async () => {
  const transcript = step('transcription', 'words', { mediaUrl: 'private-fixture-never-send' });
  const music = step('audioCaptioning', 'music', { mediaUrl: transcript.input.mediaUrl });
  const classify = step('audioClassification', 'sound');
  const chat = step('chatCompletion', 'compare', { model: RESEARCH_MODEL });
  const other = step('chatCompletion', 'other', { model: 'private-fixture-never-send' });
  const compose = step('composeMedia', 'prepare');
  const calls = [];
  const states = { 'audio/transcription': 'available', 'audio/audioCaptioning': 'degraded', 'audio/audioClassification': 'unavailable',
    ['chat/' + RESEARCH_MODEL]: 'unknown', 'utility/composeMedia': 'unavailable' };
  const advisories = await quoteServiceAdvisories([plan('words', 'Words', transcript), plan('music', 'Music and words', transcript, music, classify),
    plan('mixed', 'Music and source notes', music, chat, compose, other)], {
    fetcher(url, options) {
      assert.equal(url.origin, 'https://orchestration.civitai.com');
      assert.equal(url.search, '?window=24h');
      assert.equal(options.method, 'GET');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.referrerPolicy, 'no-referrer');
      assert.equal(options.redirect, 'error');
      assert.equal(options.body, undefined);
      assert.equal(new Headers(options.headers).has('Authorization'), false);
      assert.doesNotMatch(url.href, /private-fixture/u);
      const id = url.pathname.slice('/v2/services/'.length);
      calls.push(id);
      // A mismatched identity must not create an advisory.
      if (id === 'utility/composeMedia') return Response.json({ id: 'utility/other', category: 'utility', status: 'unavailable' });
      return Response.json({ id, category: id.split('/')[0], status: states[id] });
    },
  });
  assert.deepEqual(calls.toSorted(), Object.keys(states).toSorted());
  assert.deepEqual(advisories, [[], ['Music description (degraded)', 'Sound classification (unavailable)'], ['Music description (degraded)']]);
});
