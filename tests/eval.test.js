'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeName,
  scoreResult,
  parseArguments,
  validateCases,
  selectCases,
  formatCsv,
  formatMarkdown,
} = require('../eval/run-eval');

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

test('evaluation options select a case and a report format', () => {
  assert.deepEqual(
    parseArguments(['--only', 'fake-one', '--format', 'csv']),
    { only: 'fake-one', format: 'csv' },
  );
  assert.throws(() => parseArguments(['--only']), /requires a case id/);
  assert.throws(() => parseArguments(['--format', 'html']), /must be table, csv, or markdown/);
});

test('evaluation cases require unique ids and can be filtered by id', () => {
  const cases = [
    { id: 'fake-one', image: 'one.png', expected: ['SAMPLE-ONLY-A'] },
    { id: 'fake-two', image: 'two.png', expected: ['SAMPLE-ONLY-B'] },
  ];
  assert.doesNotThrow(() => validateCases(cases));
  assert.deepEqual(selectCases(cases, 'fake-two'), [cases[1]]);
  assert.throws(() => selectCases(cases, 'missing'), /No evaluation case has id/);
  assert.throws(() => validateCases([cases[0], cases[0]]), /unique id/);
});

test('evaluation reports can be exported as CSV or Markdown', () => {
  const rows = [{
    id: 'fake-one',
    image: 'one.png',
    correct: 1,
    uncertain: 0,
    false_with_confidence: 0,
    missed: 0,
    seconds: '2.5',
    status: 'success',
  }];
  const summary = {
    cases: 1,
    correct: 1,
    uncertain: 0,
    falseWithConfidence: 0,
    missed: 0,
    errors: 0,
    meanSeconds: 2.5,
  };
  assert.match(formatCsv(rows, summary), /SUMMARY,,1,0,0,0,0,2\.5,/);
  assert.match(formatMarkdown(rows, summary), /\| fake-one \| one\.png \| 1 \|/);
  assert.match(formatMarkdown(rows, summary), /Summary: cases=1 correct=1/);
});
