'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeName, scoreResult } = require('../eval/run-eval');

test('evaluation names ignore case, accents, and repeated whitespace', () => {
  assert.equal(normalizeName('  Épreuve   Témoin A '), 'epreuve temoin a');
});

test('evaluation separates correct, uncertain, and false confident readings', () => {
  const score = scoreResult(
    ['Épreuve Témoin A', 'Second Sample'],
    {
      image_quality: 'good',
      detected_drugs: [{ name: 'Epreuve Temoin A' }, { name: 'Unexpected Sample' }],
      uncertain: [{ name: 'SECOND SAMPLE' }],
    },
  );

  assert.deepEqual(score, {
    correct: ['epreuve temoin a'],
    uncertain: ['second sample'],
    falseConfident: ['unexpected sample'],
    missed: [],
    ambiguous: [],
  });
});

test('evaluation flags the same expected name as both confident and uncertain', () => {
  const score = scoreResult(
    ['Sample Alpha'],
    {
      image_quality: 'good',
      detected_drugs: [{ name: 'Sample Alpha' }],
      uncertain: [{ name: 'sample alpha' }],
    },
  );

  assert.deepEqual(score.ambiguous, ['sample alpha']);
});
