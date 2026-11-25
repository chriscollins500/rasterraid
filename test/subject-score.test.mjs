import assert from 'node:assert/strict';
import test from 'node:test';
import { subjectScore } from '../src/subject-score.mjs';

test('one subject reference keeps the exact earlier cosine score', () => {
  for (const cosine of [-.26, 0, .1893, .4143, .98]) {
    assert.equal(subjectScore([cosine], []), cosine);
  }
});

test('two matching references favor candidates that fit both subjects', () => {
  const balanced = subjectScore([.61, .65], []);
  const weakSecond = subjectScore([.99, .35], []);
  assert.ok(balanced > weakSecond);
  assert.equal(subjectScore([.65, .61], []), balanced);
});

test('strong avoid references lower a matching result without stacking weak exclusions', () => {
  const preferred = [.75, .72];
  assert.equal(subjectScore(preferred, [-.15]), subjectScore(preferred, []));
  assert.equal(subjectScore(preferred, [.8]), subjectScore(preferred, [.4, .8]));
  assert.ok(subjectScore(preferred, [.8]) < subjectScore([.62, .60], [.25]));
});
