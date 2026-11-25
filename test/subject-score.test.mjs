import assert from 'node:assert/strict';
import test from 'node:test';
import { poolSubjectRegions, sceneSubjectSimilarity, subjectScore, subjectVectorSize } from '../src/subject-score.mjs';

test('regional comparison finds moved features and keeps the nearest screenshot first', () => {
  const tokens = (offset, rotation = 0) => {
    const patches = new Float32Array(14 ** 2 * subjectVectorSize);
    for (let index = 0; index < 14 ** 2; index++) {
      const cell = Math.floor(index / 28) * 7 + Math.floor((index % 14) / 2);
      patches[index * subjectVectorSize + offset + (cell + rotation) % 49] = index + 1;
    }
    return patches;
  };
  const reference = poolSubjectRegions(tokens(0));
  const shifted = poolSubjectRegions(tokens(0, 11));
  const other = poolSubjectRegions(tokens(71));
  assert.equal(sceneSubjectSimilarity(.65, reference, shifted), 1);
  assert.equal(sceneSubjectSimilarity(.85, reference, other), 0);
  assert.ok(sceneSubjectSimilarity(.95, reference, other) > sceneSubjectSimilarity(.8, reference, shifted));
  assert.throws(() => poolSubjectRegions(Float32Array.of(1)), /descriptor size/u);
});

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
